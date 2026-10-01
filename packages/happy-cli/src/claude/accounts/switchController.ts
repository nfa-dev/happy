/**
 * SwitchController — proactive Claude account switching at turn boundaries (Phase 2)
 *
 * Consumes two quota signals:
 *  - current account: the SDK Layer 1 stream (rate_limit_event/get_usage),
 *    fed in via noteUsageLimits() from the launcher's onUsageLimits hook
 *  - inactive accounts: the shared OAuth usage cache (usageCache.ts polling)
 *
 * Decision point is the remote launcher's nextMessage entry (right after a
 * result, before waiting for the next instruction). When a switch is decided
 * the controller repoints CLAUDE_CONFIG_DIR and the caller returns null from
 * nextMessage — ending the current query so the launcher's while loop resumes
 * the same session under the new account (the mode-change restart cycle).
 *
 * Selection and guards follow these conventions:
 * round-robin while usage data is cold, dynamic score weekly*2 + fiveHour
 * (lower wins, unknown = 65) once fresh data covers half the candidates;
 * balance rebalances instead rank candidates by accountUtilization (the same
 * max(5h,7d) metric the gap check uses); no ping-pong return within
 * guard.noReturnWithinSec; 24h switch-count cap (0 = unlimited); parking
 * until the earliest reset when every account is exhausted. New sessions
 * under the balance strategy start on the least-utilized account
 * (applyBalanceStartAccount) rather than the last-switched-to one.
 *
 * Model-scoped mode: a session running a model capped on its own weekly
 * window (Fable — MODEL_SCOPED_WINDOW_ID in Layer 1, a limits[] row in the
 * cache) decides on that window alone: it is the threshold trigger, the
 * balance gap, the ranking and the candidate filter. Account-level
 * rejections and cooldowns still force a move, since they stop that model
 * too. A spent window is recorded as a model cooldown, apart from the
 * account's own. When the window is spent on every account the session is
 * told so instead of parked: the reset can be days away, and every other
 * model keeps working meanwhile.
 */

import { logger } from '@/ui/logger';
import { MODEL_SCOPED_WINDOW_ID, type UsageLimitsPatch } from '@/claude/utils/usageLimits';
import {
  DEFAULT_ACCOUNT_ID,
  accountConfigDir,
  applyAccountConfigDirToEnv,
  findAccount,
  getActiveAccount,
  hasClaudeCredentials,
  readAccountRegistry,
  updateAccountRegistry,
} from './registry';
import { syncMcpServersToAccountDir, syncUserConfigToAccountDir } from './dirs';
import type { ClaudeAccount, ClaudeAccountSwitchSettings } from './types';
import {
  flushUsageRefresh,
  modelScopeFor,
  modelScopeLabel,
  readUsageCache,
  recentSwitches,
  recordAccountSwitch,
  scheduleUsageRefresh,
  type CachedAccountUsage,
  type SwitchEvent,
  type UsageCacheFile,
} from './usageCache';

const FRESH_FOR_DYNAMIC_MS = 3600_000;
const NEUTRAL_UTILIZATION = 65;
const FIVE_HOURS_MS = 5 * 3600_000;
const NOTIFY_THROTTLE_MS = 3600_000;
const PARK_NOTIFY_THROTTLE_MS = 60_000;
/** Start warming the inactive-account cache this many points below the threshold */
const PREFETCH_MARGIN_PCT = 20;

/** Account-level windows that justify switching accounts. seven_day_<model> caps do not. */
const ACCOUNT_WINDOW_IDS = ['five_hour', 'seven_day', 'plan'] as const;
/** Layer 1 windows the controller keeps: the account-level pair plus the model-scoped one (Fable) */
const TRACKED_WINDOW_IDS = new Set<string>(['five_hour', 'seven_day', MODEL_SCOPED_WINDOW_ID]);


type TrackedWindow = {
  utilization: number | null;
  resetsAt: number | null;
  status?: string;
  /** capturedAt of the patch that last touched it */
  observedAt: number;
};

// ─── Selection (pure, unit-tested) ───────────────────────────────────────────

/**
 * A cooldown is spurious when usage data fetched AFTER it was recorded shows
 * the account clearly under the switch threshold. Guards against cooldowns
 * poisoned by another account's late rate-limit events (a rejected turn's
 * Layer 1 flush landing after the switch): a genuinely exhausted account
 * reports ~100% utilization, so it never heals early.
 */
export function cooldownLooksSpurious(
  account: ClaudeAccount,
  cached: CachedAccountUsage | undefined,
  now: number,
  thresholdPct: number
): boolean {
  if (account.cooldownUntil == null || account.cooldownUntil <= now) return false;
  if (!cached || now - cached.fetchedAt > FRESH_FOR_DYNAMIC_MS) return false;
  if (account.cooldownSetAt != null && cached.fetchedAt < account.cooldownSetAt) return false;
  if (!cached.fiveHour || cached.fiveHour.utilization >= thresholdPct) return false;
  if (cached.sevenDay && cached.sevenDay.utilization >= 100) return false;
  return true;
}

export function dynamicScore(usage: CachedAccountUsage | undefined, now: number, modelScope: string | null = null): number {
  if (modelScope) {
    // One window decides in model-scoped mode
    return accountUtilization(usage, now, modelScope) ?? NEUTRAL_UTILIZATION;
  }
  const fresh = usage != null && now - usage.fetchedAt <= FRESH_FOR_DYNAMIC_MS;
  const weekly = fresh && usage.sevenDay ? usage.sevenDay.utilization : NEUTRAL_UTILIZATION;
  const fiveHour = fresh && usage.fiveHour ? usage.fiveHour.utilization : NEUTRAL_UTILIZATION;
  // weekly weighted 2x so weekly-starved accounts are spared
  return weekly * 2 + fiveHour;
}

/**
 * Balance strategy metric: an account's effective utilization is its most
 * constrained window — max(5h, 7d) — or, in model-scoped mode, that model's
 * own weekly window. Null when data is missing or stale.
 */
export function accountUtilization(usage: CachedAccountUsage | undefined, now: number, modelScope: string | null = null): number | null {
  if (!usage || now - usage.fetchedAt > FRESH_FOR_DYNAMIC_MS) return null;
  if (modelScope) return usage.modelScoped?.[modelScope]?.utilization ?? null;
  const fiveHour = usage.fiveHour?.utilization;
  const sevenDay = usage.sevenDay?.utilization;
  if (fiveHour == null && sevenDay == null) return null;
  return Math.max(fiveHour ?? 0, sevenDay ?? 0);
}

/**
 * Whether moving from the current account to the candidate frees enough
 * headroom to justify a rebalance: the utilization gap must reach gapPct
 * (the registry's switchThreshold, which in balance mode means the gap).
 * Unknown candidate data never rebalances — no switching on guesses.
 */
export function worthBalancing(
  currentUtilization: number,
  candidate: CachedAccountUsage | undefined,
  now: number,
  gapPct: number,
  modelScope: string | null = null
): boolean {
  const candidateUtilization = accountUtilization(candidate, now, modelScope);
  if (candidateUtilization == null) return false;
  return currentUtilization - candidateUtilization >= gapPct;
}

/**
 * Whether a model cooldown (the Fable limit) still keeps sessions running
 * that model off the account. Usage fetched after it was recorded that shows
 * the window below 100% proves it wrong, so it lapses early — the healing
 * cooldownLooksSpurious gives account-level cooldowns.
 */
export function modelCooldownActive(
  account: ClaudeAccount,
  modelScope: string,
  cached: CachedAccountUsage | undefined,
  now: number
): boolean {
  const cooldown = account.modelCooldowns?.[modelScope];
  if (!cooldown || cooldown.until <= now) return false;
  const window = cached?.modelScoped?.[modelScope];
  if (!cached || !window || now - cached.fetchedAt > FRESH_FOR_DYNAMIC_MS) return true;
  return cached.fetchedAt <= cooldown.setAt || window.utilization >= 100;
}

export type SelectionInput = {
  registry: ClaudeAccountSwitchSettings;
  currentAccountId: string;
  usage: Record<string, CachedAccountUsage>;
  switches: SwitchEvent[];
  now: number;
  /**
   * Proactive (threshold-triggered) switches must not land on an account that
   * is itself known to be past the threshold; reactive/cooldown switches take
   * whatever is usable.
   */
  excludeAboveThreshold: boolean;
  /**
   * Balance rebalance: rank candidates by accountUtilization (max of 5h/7d,
   * fresh data only) and require each to undercut currentUtilization by
   * gapPct. Replaces dynamic scoring for this selection — the weekly-weighted
   * dynamicScore can crown a candidate that fails the gap check while another
   * candidate would have passed it, silently killing the rebalance.
   */
  balance?: { currentUtilization: number; gapPct: number };
  /**
   * Model-scoped mode: the session runs a model capped on its own weekly
   * window (e.g. 'fable'). Candidates with that window spent or cooling down
   * are skipped, and ranking, the threshold exclusion and the balance gap
   * use the window instead of 5h/7d.
   */
  modelScope?: string | null;
  /** Injectable for tests; defaults to the file-based credential check */
  credentialCheck?: (account: ClaudeAccount) => boolean;
};

export function selectNextAccount(input: SelectionInput): { account: ClaudeAccount; index: number } | null {
  const { registry, currentAccountId, usage, switches, now } = input;
  const credentialCheck = input.credentialCheck ?? hasClaudeCredentials;
  const noReturnMs = registry.guard.noReturnWithinSec * 1000;
  // Accounts we recently switched AWAY from (into the current one) are blocked
  // from being switched back to — the ping-pong guard.
  const blockedReturns = new Set(
    switches
      .filter(s => s.to === currentAccountId && now - s.at < noReturnMs)
      .map(s => s.from)
  );
  const thresholdPct = registry.switchThreshold * 100;
  const modelScope = input.modelScope ?? null;

  const usable = (account: ClaudeAccount): boolean => {
    if (account.id === currentAccountId) return false;
    if (!account.enabled) return false;
    if (account.cooldownUntil != null && account.cooldownUntil > now) return false;
    if (blockedReturns.has(account.id)) return false;
    if (!credentialCheck(account)) return false;
    if (modelScope) {
      if (modelCooldownActive(account, modelScope, usage[account.id], now)) return false;
      // A spent window never qualifies; proactive switches also skip one past the threshold
      const modelUtilization = accountUtilization(usage[account.id], now, modelScope);
      if (modelUtilization != null && modelUtilization >= (input.excludeAboveThreshold ? thresholdPct : 100)) return false;
    } else if (input.excludeAboveThreshold) {
      const cached = usage[account.id];
      const fresh = cached != null && now - cached.fetchedAt <= FRESH_FOR_DYNAMIC_MS;
      if (fresh && cached.fiveHour && cached.fiveHour.utilization >= thresholdPct) return false;
    }
    return true;
  };

  const candidates = registry.accounts.filter(usable);
  if (candidates.length === 0) return null;

  if (input.balance) {
    let best: { account: ClaudeAccount; utilization: number } | null = null;
    for (const account of candidates) {
      if (!worthBalancing(input.balance.currentUtilization, usage[account.id], now, input.balance.gapPct, modelScope)) continue;
      const utilization = accountUtilization(usage[account.id], now, modelScope)!;
      if (!best || utilization < best.utilization) {
        best = { account, utilization };
      }
    }
    return best ? { account: best.account, index: registry.accounts.indexOf(best.account) } : null;
  }

  const freshCount = candidates.filter(a => {
    const cached = usage[a.id];
    if (modelScope) return accountUtilization(cached, now, modelScope) != null;
    return cached != null && now - cached.fetchedAt <= FRESH_FOR_DYNAMIC_MS;
  }).length;
  const strategy = registry.strategy === 'auto'
    ? (freshCount * 2 >= candidates.length ? 'dynamic' : 'round-robin')
    : registry.strategy;

  if (strategy === 'round-robin') {
    const total = registry.accounts.length;
    for (let step = 1; step <= total; step++) {
      const index = (((input.registry.lastUsedIndex + step) % total) + total) % total;
      const account = registry.accounts[index];
      if (candidates.includes(account)) {
        return { account, index };
      }
    }
    return null;
  }

  let best: { account: ClaudeAccount; score: number } | null = null;
  for (const account of candidates) {
    const score = dynamicScore(usage[account.id], now, modelScope);
    if (!best || score < best.score) {
      best = { account, score };
    }
  }
  return best ? { account: best.account, index: registry.accounts.indexOf(best.account) } : null;
}

// ─── Controller ───────────────────────────────────────────────────────────────

export type AccountSwitchController = {
  /**
   * Monotonic counter bumped on every executed switch. The launcher captures
   * it when a query starts and drops Layer 1 events from queries whose epoch
   * is stale — a rejected turn's flush arriving after the switch would
   * otherwise be attributed to the NEW account and cascade into a spurious
   * cooldown that parks a healthy account.
   */
  epoch(): number;
  /** Feed Layer 1 usage data from the launcher's onUsageLimits hook */
  noteUsageLimits(patch: UsageLimitsPatch): void;
  /**
   * Track the model the session runs: the SDK init message's resolved model,
   * or the model an instruction is dispatched with. Returns true when that
   * changes which model-scoped window (if any) limits the session — e.g. a
   * session's first Fable instruction — so the caller can re-run the
   * turn-boundary decision before dispatching it.
   */
  noteModel(model: string | null | undefined): boolean;
  /**
   * Turn-boundary decision. When true the caller must return null from
   * nextMessage — CLAUDE_CONFIG_DIR is already repointed and the launcher
   * loop will resume the session under the new account.
   */
  maybeSwitchAtTurnBoundary(): Promise<boolean>;
  /**
   * Reactive path (Phase 3): a rate limit another account can lift rejected
   * the turn in progress — an account-level one (windowId five_hour,
   * seven_day or null) or, while the session runs that model, the Fable
   * limit (MODEL_SCOPED_WINDOW_ID). Records the cooldown and tries to switch
   * immediately. When true the caller should abort the current query and
   * re-inject the interrupted instruction; when false (parked, Fable spent
   * everywhere, no candidate) the turn is left to end on its own.
   */
  handleMidTurnRejection(info: { windowId: string | null; resetsAt: number | null }): Promise<boolean>;
  /** Holds message dispatch while every account is exhausted (parking) */
  waitIfParked(signal: AbortSignal): Promise<void>;
};

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createAccountSwitchController(opts: {
  notify: (message: string) => void;
}): AccountSwitchController {
  // The session's account is process-local (env snapshot); the registry's
  // activeAccountId only steers NEW sessions, so track our own id here.
  let currentAccountId: string | null = null;
  let epochCounter = 0;
  const windows = new Map<string, TrackedWindow>();
  let parkedUntil = 0;
  let lastGuardNotifyAt = 0;
  let lastNoCandidateNotifyAt = 0;
  let lastParkNotifyAt = 0;
  let lastModelSpentNotifyAt = 0;
  // The model the session runs; each decision derives from it which
  // model-scoped window, if any, applies (modelScopeFor)
  let sessionModel: string | null = null;

  // The proactive (turn boundary) and reactive (mid-turn) paths can fire for
  // the same rejection — a rejected turn still emits a result. Serializing
  // them means the loser observes the winner's state (account already
  // switched, cooldown recorded) and no-ops instead of double-switching.
  let evaluationChain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(run: () => Promise<T>): Promise<T> => {
    const next = evaluationChain.then(run, run);
    evaluationChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const noteUsageLimits = (patch: UsageLimitsPatch): void => {
    for (const incoming of patch.windows) {
      if (!TRACKED_WINDOW_IDS.has(incoming.id)) continue;
      const previous = windows.get(incoming.id);
      windows.set(incoming.id, {
        utilization: incoming.utilization ?? previous?.utilization ?? null,
        resetsAt: incoming.resetsAt ?? previous?.resetsAt ?? null,
        // A window reported without a status (a non-binding unifiedWindows
        // entry) keeps its last one only while it is still at the cap —
        // below it, a remembered 'rejected' is stale.
        status: incoming.status
          ?? (typeof incoming.utilization === 'number' && incoming.utilization < 100 ? undefined : previous?.status),
        observedAt: patch.capturedAt,
      });
    }
    if (patch.unbound) {
      const previous = windows.get('plan');
      windows.set('plan', {
        utilization: patch.unbound.utilization ?? previous?.utilization ?? null,
        resetsAt: patch.unbound.resetsAt ?? previous?.resetsAt ?? null,
        status: patch.unbound.status,
        observedAt: patch.capturedAt,
      });
    }
  };

  const noteModel = (model: string | null | undefined): boolean => {
    // '<synthetic>' marks Claude Code's own error messages, not a model
    if (!model || model.startsWith('<')) return false;
    const previousScope = modelScopeFor(sessionModel);
    sessionModel = model;
    return modelScopeFor(model) !== previousScope;
  };

  /**
   * Layer 1's model-scoped window, unless it is over an hour old: the
   * header only rides on requests to that model, so after a stretch on
   * another model the cache is the better witness.
   */
  const liveModelWindow = (now: number): TrackedWindow | undefined => {
    const window = windows.get(MODEL_SCOPED_WINDOW_ID);
    return window && now - window.observedAt <= FRESH_FOR_DYNAMIC_MS ? window : undefined;
  };

  /** Record a spent model window on the account for every session (expired entries pruned) */
  const recordModelCooldown = async (account: ClaudeAccount, modelScope: string, until: number, now: number): Promise<void> => {
    const withCooldown = (cooldowns: ClaudeAccount['modelCooldowns']) => ({
      ...Object.fromEntries(Object.entries(cooldowns ?? {}).filter(([, c]) => c.until > now)),
      [modelScope]: { until, setAt: now },
    });
    await updateAccountRegistry(r => ({
      ...r,
      accounts: r.accounts.map(a => a.id === account.id ? { ...a, modelCooldowns: withCooldown(a.modelCooldowns) } : a),
    }));
    account.modelCooldowns = withCooldown(account.modelCooldowns);
  };

  /** The model's window is spent on every account: say so (hourly at most) instead of parking */
  const notifyModelSpent = (registry: ClaudeAccountSwitchSettings, cache: UsageCacheFile, modelScope: string, now: number): void => {
    if (now - lastModelSpentNotifyAt <= NOTIFY_THROTTLE_MS) return;
    lastModelSpentNotifyAt = now;
    const resets: number[] = [];
    for (const account of registry.accounts) {
      const reset = account.enabled ? cache.accounts[account.id]?.modelScoped?.[modelScope]?.resetsAt : null;
      if (reset != null && reset > now) resets.push(reset);
    }
    const label = modelScopeLabel(modelScope, cache);
    const earliest = resets.length > 0 ? ` (earliest reset ${new Date(Math.min(...resets)).toLocaleString()})` : '';
    opts.notify(`${label} limit reached on every Claude account${earliest}. Switch to another model to continue.`);
  };

  const park = (registry: ClaudeAccountSwitchSettings, now: number): void => {
    const resets: number[] = [];
    for (const account of registry.accounts) {
      if (account.cooldownUntil != null && account.cooldownUntil > now) {
        resets.push(account.cooldownUntil);
      }
    }
    for (const id of ACCOUNT_WINDOW_IDS) {
      const w = windows.get(id);
      if (w?.resetsAt != null && w.resetsAt > now) {
        resets.push(w.resetsAt);
      }
    }
    parkedUntil = resets.length > 0 ? Math.min(...resets) : now + FIVE_HOURS_MS;
    if (now - lastParkNotifyAt > PARK_NOTIFY_THROTTLE_MS) {
      lastParkNotifyAt = now;
      opts.notify(`All Claude accounts are rate-limited. Parking until ${new Date(parkedUntil).toLocaleString()} — queued instructions will resume automatically.`);
    }
  };

  /** Common preamble: null when auto-switch does not apply to this session */
  const loadSwitchContext = async (): Promise<{ registry: ClaudeAccountSwitchSettings; current: ClaudeAccount; now: number } | null> => {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      return null; // token-scoped session (daemon pod spawn) — config dirs don't apply
    }
    const registry = await readAccountRegistry();
    if (!registry.enabled || registry.strategy === 'off' || registry.accounts.length < 2) {
      return null;
    }
    if (!currentAccountId) {
      currentAccountId = getActiveAccount(registry).id;
    }
    const current = findAccount(registry, currentAccountId) ?? getActiveAccount(registry);
    return { registry, current, now: Date.now() };
  };

  /** Guard-checked selection + execution, shared by the proactive and reactive paths */
  const attemptSwitch = async (args: {
    registry: ClaudeAccountSwitchSettings;
    current: ClaudeAccount;
    now: number;
    reason: string;
    /** The session's model-scoped window ('fable'), or null — selects in model-scoped mode */
    modelScope: string | null;
    /**
     * Proactive (threshold) switches must not land on a candidate that is
     * itself past the threshold; reactive/cooldown switches take whatever is
     * usable, and balance switches compare utilization gaps instead.
     */
    excludeAboveThreshold: boolean;
    /**
     * Balance strategy: the current account's utilization (max of 5h/7d, or
     * the model window). The selected candidate must undercut it by the
     * threshold-as-gap (switchThreshold * 100) or no switch happens.
     */
    balanceAgainstUtilization?: number;
    /**
     * An account-level limit forces the move: when no candidate has room in
     * the model's window, take any candidate that is usable at all — the
     * session can still run another model there.
     */
    fallBackToAccountLevel?: boolean;
    /** Nothing is selectable: park, warn, or let it be */
    onStuck?: (cache: UsageCacheFile) => void;
  }): Promise<boolean> => {
    const { registry, current, now, modelScope } = args;
    let cache = await readUsageCache();
    const switches = recentSwitches(cache, now);
    // maxSwitchesPer24h 0 = unlimited
    if (registry.guard.maxSwitchesPer24h > 0 && switches.length >= registry.guard.maxSwitchesPer24h) {
      if (now - lastGuardNotifyAt > NOTIFY_THROTTLE_MS) {
        lastGuardNotifyAt = now;
        opts.notify(`Account auto-switch paused: ${switches.length} switches in 24h reached the guard limit (${registry.guard.maxSwitchesPer24h}).`);
      }
      return false;
    }

    // Heal spuriously cooled candidates before selecting: a cooldown poisoned
    // by cross-account event leakage must not park the fleet while a candidate
    // demonstrably has quota. Forces usage data newer than each cooldown.
    const cooled = registry.accounts.filter(a =>
      a.id !== current.id && a.enabled && a.cooldownUntil != null && a.cooldownUntil > now);
    // Model cooldowns heal on usage data newer than them alone (modelCooldownActive)
    const modelCooled = modelScope
      ? registry.accounts.flatMap(a => {
        const cooldown = a.modelCooldowns?.[modelScope];
        return a.id !== current.id && a.enabled && cooldown && cooldown.until > now ? [{ account: a, setAt: cooldown.setAt }] : [];
      })
      : [];
    if (cooled.length > 0 || modelCooled.length > 0) {
      for (const account of cooled) {
        scheduleUsageRefresh([account], account.cooldownSetAt ?? 0);
      }
      for (const { account, setAt } of modelCooled) {
        scheduleUsageRefresh([account], setAt);
      }
      await flushUsageRefresh();
      cache = await readUsageCache();
      const thresholdPct = registry.switchThreshold * 100;
      const spurious = cooled.filter(a => cooldownLooksSpurious(a, cache.accounts[a.id], now, thresholdPct));
      if (spurious.length > 0) {
        const ids = new Set(spurious.map(a => a.id));
        await updateAccountRegistry(r => ({
          ...r,
          accounts: r.accounts.map(a => ids.has(a.id) ? { ...a, cooldownUntil: null, cooldownSetAt: null } : a),
        }));
        for (const account of registry.accounts) {
          if (ids.has(account.id)) {
            account.cooldownUntil = null;
            account.cooldownSetAt = null;
          }
        }
        logger.debug(`[accountSwitch] cleared spurious cooldown on: ${[...ids].join(', ')}`);
      }
    }

    const select = (scope: string | null) => selectNextAccount({
      registry,
      currentAccountId: current.id,
      usage: cache.accounts,
      switches: cache.switches,
      now,
      excludeAboveThreshold: args.excludeAboveThreshold,
      modelScope: scope,
      balance: args.balanceAgainstUtilization != null
        ? { currentUtilization: args.balanceAgainstUtilization, gapPct: registry.switchThreshold * 100 }
        : undefined,
    });
    const selection = select(modelScope) ?? (modelScope && args.fallBackToAccountLevel ? select(null) : null);
    if (!selection) {
      args.onStuck?.(cache);
      return false;
    }

    // Execute: repoint env, persist registry cursor + guard evidence, notify.
    applyAccountConfigDirToEnv(selection.account);
    const selectedDir = accountConfigDir(selection.account);
    if (selectedDir) {
      // The restarted query resolves MCP servers, hooks, rules and skills from
      // the new config dir — carry the default login's over before it spawns.
      try {
        syncMcpServersToAccountDir(selectedDir);
      } catch (e) {
        logger.debug('[accountSwitch] MCP sync failed (continuing with switch)', e);
      }
      try {
        syncUserConfigToAccountDir(selectedDir);
      } catch (e) {
        logger.debug('[accountSwitch] User config sync failed (continuing with switch)', e);
      }
    }
    await updateAccountRegistry(r => ({
      ...r,
      activeAccountId: selection.account.id === DEFAULT_ACCOUNT_ID ? null : selection.account.id,
      lastUsedIndex: selection.index,
    }));
    await recordAccountSwitch(current.id, selection.account.id, now);
    opts.notify(`Account switch: ${current.id} → ${selection.account.id} (${args.reason})`);
    logger.debug(`[accountSwitch] ${current.id} → ${selection.account.id} (${args.reason})`);
    currentAccountId = selection.account.id;
    epochCounter++; // invalidates Layer 1 events still in flight from the old account's query
    windows.clear(); // Layer 1 data belonged to the previous account
    parkedUntil = 0;
    return true;
  };

  /**
   * Balance strategy: at every turn boundary (no rejection trigger needed)
   * move to the least-utilized account when the utilization gap — max(5h, 7d)
   * per account, or the model's own window in model-scoped mode — reaches
   * switchThreshold. Guards (ping-pong, 24h cap) apply.
   */
  const attemptBalanceSwitch = async (
    registry: ClaudeAccountSwitchSettings,
    current: ClaudeAccount,
    now: number,
    modelScope: string | null
  ): Promise<boolean> => {
    // TTL-gated: at most one fetch per account per 5min despite running every turn
    scheduleUsageRefresh(registry.accounts);
    await flushUsageRefresh();
    const cache = await readUsageCache();
    // Per window prefer live Layer 1 data (fresher than any poll), fall back
    // to the cache. With nothing known, don't churn on guesses.
    const cached = cache.accounts[current.id];
    let currentUtilization: number | null;
    if (modelScope) {
      currentUtilization = liveModelWindow(now)?.utilization ?? accountUtilization(cached, now, modelScope);
    } else {
      const cachedFresh = cached != null && now - cached.fetchedAt <= FRESH_FOR_DYNAMIC_MS;
      const fiveHour = windows.get('five_hour')?.utilization
        ?? (cachedFresh ? cached.fiveHour?.utilization : undefined);
      const sevenDay = windows.get('seven_day')?.utilization
        ?? (cachedFresh ? cached.sevenDay?.utilization : undefined);
      currentUtilization = fiveHour == null && sevenDay == null ? null : Math.max(fiveHour ?? 0, sevenDay ?? 0);
    }
    if (currentUtilization == null) {
      return false;
    }
    return await attemptSwitch({
      registry,
      current,
      now,
      modelScope,
      excludeAboveThreshold: false, // balance compares utilization gaps, not the threshold
      balanceAgainstUtilization: currentUtilization,
      reason: modelScope ? `${modelScopeLabel(modelScope, cache)} usage balancing` : 'usage balancing',
    });
  };

  const maybeSwitchAtTurnBoundary = (): Promise<boolean> => serialized(async () => {
    try {
      const context = await loadSwitchContext();
      if (!context) {
        return false;
      }
      const { registry, current, now } = context;
      const cache = await readUsageCache();
      const modelScope = modelScopeFor(sessionModel, cache);

      const fiveHour = windows.get('five_hour');
      const thresholdPct = registry.switchThreshold * 100;
      const rejectedWindow = ACCOUNT_WINDOW_IDS
        .map(id => windows.get(id))
        .find(w => w?.status === 'rejected');
      let cooldownActive = current.cooldownUntil != null && current.cooldownUntil > now;
      // Under the balance strategy the threshold means the utilization GAP
      // between accounts, not an absolute 5h trigger — rebalancing (plus the
      // rejection/cooldown reactive paths) replaces the threshold trigger.
      const balancing = registry.strategy === 'balance';
      const thresholdHit = !balancing
        && typeof fiveHour?.utilization === 'number'
        && fiveHour.utilization >= thresholdPct;
      const approaching = !balancing
        && typeof fiveHour?.utilization === 'number'
        && fiveHour.utilization >= thresholdPct - PREFETCH_MARGIN_PCT;

      // Model-scoped mode: the model's own window replaces 5h as the
      // proactive trigger, and a spent window (or its cooldown) forces a move
      // the way an account-level rejection does — for this model only.
      const modelWindow = modelScope ? liveModelWindow(now) : undefined;
      const modelUtilization = modelScope
        ? modelWindow?.utilization ?? accountUtilization(cache.accounts[current.id], now, modelScope)
        : null;
      const modelRejected = modelWindow?.status === 'rejected'
        && (modelWindow.resetsAt == null || modelWindow.resetsAt > now);
      const modelCooling = modelScope != null && modelCooldownActive(current, modelScope, cache.accounts[current.id], now);
      const modelBlocked = modelScope != null && (modelRejected || modelCooling || (modelUtilization ?? 0) >= 100);
      const proactiveHit = modelScope
        ? !balancing && modelUtilization != null && modelUtilization >= thresholdPct
        : thresholdHit;
      const proactiveApproaching = modelScope
        ? !balancing && modelUtilization != null && modelUtilization >= thresholdPct - PREFETCH_MARGIN_PCT
        : approaching;

      // A cooldown with no corroborating live signal (no rejection, 5h under
      // threshold) may be poisoned — e.g. recorded from another account's
      // late rate-limit events before the epoch guard existed. Validate it
      // against usage data newer than the cooldown before acting on it.
      if (cooldownActive && !rejectedWindow && !thresholdHit) {
        scheduleUsageRefresh([current], current.cooldownSetAt ?? 0);
        await flushUsageRefresh();
        const refreshed = await readUsageCache();
        if (cooldownLooksSpurious(current, refreshed.accounts[current.id], now, thresholdPct)) {
          await updateAccountRegistry(r => ({
            ...r,
            accounts: r.accounts.map(a => a.id === current.id ? { ...a, cooldownUntil: null, cooldownSetAt: null } : a),
          }));
          current.cooldownUntil = null;
          current.cooldownSetAt = null;
          cooldownActive = false;
          opts.notify(`Claude account '${current.id}' cooldown cleared — live usage shows quota available.`);
          logger.debug(`[accountSwitch] cleared spurious cooldown on current account '${current.id}'`);
        }
      }

      if (proactiveHit || rejectedWindow || cooldownActive || proactiveApproaching || modelBlocked) {
        // Warm the candidate cache ahead of / for this decision (TTL-gated)
        scheduleUsageRefresh(registry.accounts.filter(a => a.id !== current.id));
      }
      if (!proactiveHit && !rejectedWindow && !cooldownActive && !modelBlocked) {
        parkedUntil = 0;
        if (balancing) {
          return await attemptBalanceSwitch(registry, current, now, modelScope);
        }
        return false;
      }

      // A rejected account-level window means this account is out until reset —
      // record it so other sessions (and our own selection) see the cooldown.
      if (rejectedWindow && !cooldownActive) {
        const until = rejectedWindow.resetsAt ?? now + FIVE_HOURS_MS;
        await updateAccountRegistry(r => ({
          ...r,
          accounts: r.accounts.map(a => a.id === current.id ? { ...a, cooldownUntil: until, cooldownSetAt: now } : a),
        }));
        current.cooldownUntil = until;
        current.cooldownSetAt = now;
      }
      // Likewise a rejected model window, for that model only
      if (modelScope && modelRejected && !modelCooling) {
        await recordModelCooldown(current, modelScope, modelWindow?.resetsAt ?? now + FIVE_HOURS_MS, now);
      }

      const mustLeaveAccount = Boolean(rejectedWindow) || cooldownActive;
      const modelLabel = modelScope ? modelScopeLabel(modelScope, cache) : null;
      const reason = rejectedWindow
        ? 'rate limit reached'
        : cooldownActive
          ? 'account in cooldown'
          : modelBlocked
            ? `${modelLabel} limit reached`
            : modelLabel
              ? `${modelLabel} usage ${Math.round(modelUtilization!)}%`
              : `5h usage ${Math.round(fiveHour!.utilization!)}%`;
      return await attemptSwitch({
        registry,
        current,
        now,
        reason,
        modelScope,
        excludeAboveThreshold: !mustLeaveAccount && !modelBlocked,
        fallBackToAccountLevel: mustLeaveAccount,
        onStuck: (latest) => {
          if (mustLeaveAccount) {
            park(registry, now);
          } else if (modelBlocked) {
            notifyModelSpent(registry, latest, modelScope!, now);
          } else if (now - lastNoCandidateNotifyAt > NOTIFY_THROTTLE_MS) {
            lastNoCandidateNotifyAt = now;
            opts.notify(modelLabel
              ? `Claude account '${current.id}' is at ${Math.round(modelUtilization ?? 0)}% of its ${modelLabel} limit but no other account has ${modelLabel} room to switch to.`
              : `Claude account '${current.id}' is at ${Math.round(fiveHour?.utilization ?? 0)}% of its 5h window but no other account is available to switch to.`);
          }
        },
      });
    } catch (e) {
      // Auto-switch must never take the session down — stay on the current account.
      logger.debug('[accountSwitch] evaluation failed (staying on current account)', e);
      return false;
    }
  });

  const handleMidTurnRejection = (info: { windowId: string | null; resetsAt: number | null }): Promise<boolean> => {
    // Bind the rejection to the account that was current when it fired —
    // by the time the serialized body runs, a concurrent turn-boundary
    // evaluation may already have switched away from it.
    const rejectedAccountId = currentAccountId;
    return serialized(() => handleMidTurnRejectionBody(info, rejectedAccountId));
  };

  const handleMidTurnRejectionBody = async (
    info: { windowId: string | null; resetsAt: number | null },
    rejectedAccountId: string | null
  ): Promise<boolean> => {
    try {
      const context = await loadSwitchContext();
      if (!context) {
        return false;
      }
      const { registry, current, now } = context;
      if (rejectedAccountId !== null && rejectedAccountId !== current.id) {
        // Another evaluation already switched off the rejected account; the
        // launcher loop is restarting on its own — no abort needed.
        return false;
      }
      const cache = await readUsageCache();
      const modelScope = modelScopeFor(sessionModel, cache);
      if (info.windowId === MODEL_SCOPED_WINDOW_ID) {
        // Another account lifts the Fable limit only for a session running
        // Fable; for any other session it is not a limit it can act on.
        if (!modelScope) {
          return false;
        }
        await recordModelCooldown(current, modelScope, info.resetsAt ?? now + FIVE_HOURS_MS, now);
        scheduleUsageRefresh(registry.accounts.filter(a => a.id !== current.id));
        return await attemptSwitch({
          registry,
          current,
          now,
          modelScope,
          excludeAboveThreshold: false,
          reason: `${modelScopeLabel(modelScope, cache)} limit hit mid-turn`,
          onStuck: (latest) => notifyModelSpent(registry, latest, modelScope, now),
        });
      }
      // The rejection may never produce a result (no Layer 1 flush), so the
      // cooldown must be recorded here for other sessions and our selection.
      const until = info.resetsAt ?? now + FIVE_HOURS_MS;
      if (current.cooldownUntil == null || current.cooldownUntil < until) {
        await updateAccountRegistry(r => ({
          ...r,
          accounts: r.accounts.map(a => a.id === current.id ? { ...a, cooldownUntil: until, cooldownSetAt: now } : a),
        }));
        current.cooldownUntil = until;
        current.cooldownSetAt = now;
      }
      scheduleUsageRefresh(registry.accounts.filter(a => a.id !== current.id));
      return await attemptSwitch({
        registry,
        current,
        now,
        modelScope,
        excludeAboveThreshold: false,
        fallBackToAccountLevel: true,
        reason: 'rate limit hit mid-turn',
        onStuck: () => park(registry, now),
      });
    } catch (e) {
      logger.debug('[accountSwitch] mid-turn evaluation failed (staying on current account)', e);
      return false;
    }
  };

  const waitIfParked = async (signal: AbortSignal): Promise<void> => {
    while (parkedUntil > Date.now() && !signal.aborted) {
      await abortableSleep(Math.min(parkedUntil - Date.now(), 30_000), signal);
    }
  };

  return { epoch: () => epochCounter, noteUsageLimits, noteModel, maybeSwitchAtTurnBoundary, handleMidTurnRejection, waitIfParked };
}

// ─── Session-start balancing ──────────────────────────────────────────────────

/**
 * Balance strategy, session start: every switch persists activeAccountId, so
 * new sessions would otherwise all pile onto the most-recently-switched-to
 * account and only spread out once the utilization gap builds up mid-session.
 * Instead, steer the NEW session to the least-utilized usable account (cached
 * usage, fresh data only) before the config dir is applied. Unlike a mid-turn
 * rebalance this costs nothing (no query restart), so no gap is required and
 * it is not recorded as a switch. Cold/stale cache → keep activeAccountId;
 * a refresh is scheduled in the background for the next session.
 *
 * `model` is the session's --model (daemon spawns pass the app's pick): a
 * model capped on its own weekly window (Fable) starts where that window has
 * the most room, never where it is spent.
 */
export async function applyBalanceStartAccount(model?: string): Promise<void> {
  try {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return;
    const registry = await readAccountRegistry();
    if (!registry.enabled || registry.strategy !== 'balance' || registry.accounts.length < 2) return;
    const now = Date.now();
    scheduleUsageRefresh(registry.accounts); // fire-and-forget: never delay session start
    const cache = await readUsageCache();
    const modelScope = modelScopeFor(model, cache);
    let best: { account: ClaudeAccount; utilization: number } | null = null;
    for (const account of registry.accounts) {
      if (!account.enabled) continue;
      if (account.cooldownUntil != null && account.cooldownUntil > now) continue;
      if (!hasClaudeCredentials(account)) continue;
      if (modelScope && modelCooldownActive(account, modelScope, cache.accounts[account.id], now)) continue;
      const utilization = accountUtilization(cache.accounts[account.id], now, modelScope);
      if (utilization == null || (modelScope && utilization >= 100)) continue;
      if (!best || utilization < best.utilization) {
        best = { account, utilization };
      }
    }
    if (!best || best.account.id === getActiveAccount(registry).id) return;
    const chosen = best.account;
    await updateAccountRegistry(r => ({
      ...r,
      activeAccountId: chosen.id === DEFAULT_ACCOUNT_ID ? null : chosen.id,
    }));
    logger.debug(`[accountSwitch] session start → least-utilized account '${chosen.id}' (${modelScope ? `${modelScope} ` : ''}${Math.round(best.utilization)}%)`);
  } catch (e) {
    logger.debug('[accountSwitch] session-start balancing failed (using activeAccountId)', e);
  }
}
