/**
 * Usage cache + OAuth usage polling for Claude account auto-switching (Phase 2)
 *
 * The active account's utilization arrives for free through the SDK's
 * rate_limit_event/get_usage stream (Layer 1). Inactive candidate accounts
 * have no such stream, so their 5h/7d windows — and the weekly windows of
 * models capped on their own, such as Fable — are polled from the OAuth usage
 * endpoint and cached in ~/.claude-accounts/usage-cache.json, shared
 * (file-locked) between happy sessions on the same machine.
 *
 * Load-control conventions: 300s TTL,
 * single fetch in flight per process, exponential backoff 30s→3600s with
 * jitter on failure.
 *
 * Tokens: claude refreshes credentials only for the account it is RUNNING as,
 * so an inactive account's access token eventually expires and its usage can
 * no longer be polled — which starves the balance strategy of candidate data
 * and glues sessions to the current account. To prevent that, file-based
 * credentials past their expiresAt are refreshed here with the stored refresh
 * token and persisted back to .credentials.json (same shape claude writes).
 * Keychain-only credentials are never refreshed — a rotated refresh token
 * that we cannot write back would invalidate the stored login.
 */

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { logger } from '@/ui/logger';
import { withFileLock } from '@/utils/fileLock';
import { accountConfigDir, accountsRootDir, defaultClaudeConfigDir } from './registry';
import type { ClaudeAccount } from './types';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
/** Claude Code's public OAuth client id (PKCE flow — not a secret) */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Refresh this far before expiresAt so an in-flight usage fetch never races expiry */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;
export const FETCH_TTL_MS = 300_000;
const BACKOFF_BASE_SEC = 30;
const BACKOFF_MAX_SEC = 3600;
const SWITCH_HISTORY_WINDOW_MS = 24 * 3600_000;

/** Normalized like AgentState.usageLimits: utilization 0-100, resetsAt epoch ms */
export type CachedUsageWindow = {
  utilization: number;
  resetsAt: number | null;
};

/** A model's own weekly window, with the server's label for it (e.g. 'Fable') */
export type CachedModelWindow = CachedUsageWindow & { label: string };

export type CachedAccountUsage = {
  fiveHour?: CachedUsageWindow;
  sevenDay?: CachedUsageWindow;
  /**
   * Weekly windows of models capped on their own (the usage endpoint's
   * limits[] rows of kind 'weekly_scoped'), keyed by modelScopeKey — e.g.
   * 'fable'. Such a model is cut off there while 5h/7d still have room.
   */
  modelScoped?: Record<string, CachedModelWindow>;
  fetchedAt: number;
};

export type BackoffState = {
  lastAttemptedAt: number;
  consecutiveFailures: number;
  jitterSec: number;
};

/** One auto-switch event; kept 24h as evidence for the switch-rate guard */
export type SwitchEvent = {
  at: number;
  from: string;
  to: string;
};

export type UsageCacheFile = {
  accounts: Record<string, CachedAccountUsage>;
  backoff: Record<string, BackoffState>;
  switches: SwitchEvent[];
};

const emptyCache = (): UsageCacheFile => ({ accounts: {}, backoff: {}, switches: [] });

export function usageCachePath(): string {
  return join(accountsRootDir(), 'usage-cache.json');
}

export async function readUsageCache(): Promise<UsageCacheFile> {
  try {
    const raw = JSON.parse(await readFile(usageCachePath(), 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyCache();
    return {
      accounts: raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {},
      backoff: raw.backoff && typeof raw.backoff === 'object' ? raw.backoff : {},
      switches: Array.isArray(raw.switches) ? raw.switches : [],
    };
  } catch {
    return emptyCache();
  }
}

/** Atomically mutate the cache under its lock file. */
export async function updateUsageCache(
  mutate: (current: UsageCacheFile) => UsageCacheFile
): Promise<UsageCacheFile> {
  const target = usageCachePath();
  const tmpFile = target + '.tmp';
  await mkdir(accountsRootDir(), { recursive: true });
  return await withFileLock(target + '.lock', async () => {
    const updated = mutate(await readUsageCache());
    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, target);
    return updated;
  });
}

// ─── Response parsing (shape verified against captured responses) ──

/**
 * Parse a GET /api/oauth/usage 200 body: the account-level windows
 * (five_hour/seven_day) plus the limits[] rows of models capped on their own
 * weekly window (Fable). The top-level seven_day_<model> fields are ignored —
 * they are null on current accounts, and the limits[] rows carry what they
 * used to. Returns null when no usable window is present (treated as a fetch
 * failure).
 */
export function parseUsageResponseBody(body: string): Omit<CachedAccountUsage, 'fetchedAt'> | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  const readWindow = (key: string): CachedUsageWindow | undefined => {
    const node = root[key];
    if (!node || typeof node !== 'object') return undefined; // null window (e.g. seven_day_opus) skipped
    return toCachedWindow((node as Record<string, unknown>).utilization, (node as Record<string, unknown>).resets_at);
  };
  const fiveHour = readWindow('five_hour');
  const sevenDay = readWindow('seven_day');
  const modelScoped = readModelScopedRows(root.limits);
  if (!fiveHour && !sevenDay && !modelScoped) return null;
  return { fiveHour, sevenDay, ...(modelScoped && { modelScoped }) };
}

/** 0-100 utilization (clamped) and a resets_at given as ISO text or unix seconds/ms */
function toCachedWindow(utilization: unknown, rawReset: unknown): CachedUsageWindow | undefined {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  let resetsAt: number | null = null;
  if (typeof rawReset === 'string') {
    const ms = Date.parse(rawReset);
    resetsAt = Number.isFinite(ms) ? ms : null;
  } else if (typeof rawReset === 'number' && Number.isFinite(rawReset) && rawReset > 0) {
    resetsAt = rawReset < 1e12 ? Math.round(rawReset * 1000) : Math.round(rawReset);
  }
  return { utilization: Math.min(100, Math.max(0, utilization)), resetsAt };
}

/**
 * The limits[] rows that cap one model, e.g. {kind: 'weekly_scoped',
 * percent: 94, resets_at: '…', scope: {model: {id: null, display_name: 'Fable'}}}.
 * The server sends no model id, so the label is the only handle on the model.
 */
function readModelScopedRows(limits: unknown): Record<string, CachedModelWindow> | undefined {
  if (!Array.isArray(limits)) return undefined;
  const windows: Record<string, CachedModelWindow> = {};
  for (const row of limits) {
    if (!row || typeof row !== 'object' || row.kind !== 'weekly_scoped') continue;
    const label = row.scope?.model?.display_name;
    if (typeof label !== 'string') continue;
    const key = modelScopeKey(label);
    const window = toCachedWindow(row.percent, row.resets_at);
    if (key && window) {
      windows[key] = { ...window, label };
    }
  }
  return Object.keys(windows).length > 0 ? windows : undefined;
}

// ─── Model-scoped windows ────────────────────────────────────────────────────

/**
 * Models known to be capped on their own weekly window. Fable is the one
 * Claude Code names today (its rate_limit_event calls the
 * seven_day_overage_included window the "Fable limit"); limits[] rows the
 * usage endpoint reports for other models extend this through the cache.
 */
const KNOWN_MODEL_SCOPES = ['fable'];

/**
 * Cache key of a model's own window: the first word of the server's label,
 * lowercased ('Fable' → 'fable'), the way it appears in model ids like
 * claude-fable-5-1. Null when the label holds no word.
 */
export function modelScopeKey(label: string): string | null {
  return label.toLowerCase().match(/[a-z]+/)?.[0] ?? null;
}

/**
 * The model-scoped window a session running `model` is cut off by, or null
 * when the model draws only on the account-level 5h/7d windows. Matched on
 * whole words of the model id or alias ('claude-fable-5-1', 'fable').
 */
export function modelScopeFor(model: string | null | undefined, cache?: UsageCacheFile): string | null {
  if (!model) return null;
  const words = model.toLowerCase().split(/[^a-z]+/);
  const scopes = new Set(KNOWN_MODEL_SCOPES);
  for (const usage of Object.values(cache?.accounts ?? {})) {
    for (const key of Object.keys(usage.modelScoped ?? {})) {
      scopes.add(key);
    }
  }
  return [...scopes].find(scope => words.includes(scope)) ?? null;
}

/** Display name of a model-scoped window: the server's label, else the key capitalized */
export function modelScopeLabel(scope: string, cache?: UsageCacheFile): string {
  for (const usage of Object.values(cache?.accounts ?? {})) {
    const label = usage.modelScoped?.[scope]?.label;
    if (label) return label;
  }
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

// ─── Backoff ──────────────────────────────────────────────────────────────────

export function backoffWaitSec(consecutiveFailures: number): number {
  const clamped = Math.min(Math.max(consecutiveFailures, 0), 7);
  return Math.min(BACKOFF_BASE_SEC * (1 << clamped), BACKOFF_MAX_SEC);
}

export function backoffActive(state: BackoffState | undefined, nowMs: number): boolean {
  if (!state) return false;
  const waitSec = backoffWaitSec(state.consecutiveFailures) + Math.max(state.jitterSec ?? 0, 0);
  return nowMs < state.lastAttemptedAt + waitSec * 1000;
}

function nextBackoff(previous: BackoffState | undefined, nowMs: number): BackoffState {
  const consecutiveFailures = Math.max(previous?.consecutiveFailures ?? 0, 0) + 1;
  const halfBase = Math.floor(backoffWaitSec(consecutiveFailures) / 2);
  return {
    lastAttemptedAt: nowMs,
    consecutiveFailures,
    // desyncs sessions that hit a 429/outage at the same instant
    jitterSec: Math.floor(Math.random() * (halfBase + 1)),
  };
}

/**
 * `minFetchedAt` forces a refetch (TTL notwithstanding) when the cached data
 * predates that instant — used to validate a cooldown against usage data that
 * is provably newer than the moment the cooldown was recorded.
 */
export function usageFetchDue(cache: UsageCacheFile, accountId: string, nowMs: number, minFetchedAt = 0): boolean {
  if (backoffActive(cache.backoff[accountId], nowMs)) return false;
  const usage = cache.accounts[accountId];
  return !usage || nowMs - usage.fetchedAt > FETCH_TTL_MS || usage.fetchedAt < minFetchedAt;
}

// ─── Credential access (read-only) ───────────────────────────────────────────

/**
 * Keychain service claude stores a non-default config dir's login under on
 * macOS. Derived from the config dir path, so moving an account dir orphans
 * the login unless the item is copied to the new path's service (migrate.ts).
 */
export function keychainService(configDir: string): string {
  const digest = createHash('sha256').update(configDir).digest('hex');
  return `Claude Code-credentials-${digest.slice(0, 8)}`;
}

/** Account attribute of claude's keychain items */
export const KEYCHAIN_ACCOUNT = process.env.USER ?? 'claude-code-user';

function readKeychainToken(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-w', '-s', service],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const cred = JSON.parse(stdout.trim());
          const token = cred?.claudeAiOauth?.accessToken;
          resolve(typeof token === 'string' && token.length > 0 ? token : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

type FileOAuthCredentials = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
};

async function readCredentialsFile(credentialsPath: string): Promise<{ raw: any; oauth: FileOAuthCredentials } | null> {
  try {
    const raw = JSON.parse(await readFile(credentialsPath, 'utf8'));
    const node = raw?.claudeAiOauth;
    const accessToken = node?.accessToken;
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    return {
      raw,
      oauth: {
        accessToken,
        refreshToken: typeof node.refreshToken === 'string' && node.refreshToken.length > 0 ? node.refreshToken : null,
        expiresAt: typeof node.expiresAt === 'number' && Number.isFinite(node.expiresAt) ? node.expiresAt : null,
      },
    };
  } catch {
    return null;
  }
}

function tokenLooksLive(oauth: FileOAuthCredentials, now: number): boolean {
  return oauth.expiresAt == null || oauth.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now;
}

/**
 * Refresh expired file-based credentials with the stored refresh token and
 * persist the result back to .credentials.json (preserving sibling fields,
 * same shape claude writes). Locked across happy processes; re-checks after
 * acquiring the lock so concurrent sessions converge on a single refresh —
 * refresh tokens may rotate, and a double-spend would invalidate the login.
 * Returns a usable access token, or null when the refresh is impossible/fails
 * (the caller's backoff handles retry pacing).
 */
async function refreshFileCredentials(credentialsPath: string, accountId: string): Promise<string | null> {
  return await withFileLock(credentialsPath + '.happy-refresh.lock', async () => {
    const current = await readCredentialsFile(credentialsPath);
    if (!current) return null;
    if (tokenLooksLive(current.oauth, Date.now())) return current.oauth.accessToken; // another session won the race
    if (!current.oauth.refreshToken) {
      logger.debug(`[usageCache] '${accountId}' token expired and no refresh token on file — re-login needed`);
      return null;
    }
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.oauth.refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.debug(`[usageCache] token refresh failed for '${accountId}': HTTP ${response.status}`);
      return null;
    }
    const tokenData = await response.json() as any;
    const accessToken = tokenData?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      logger.debug(`[usageCache] token refresh for '${accountId}' returned no access_token`);
      return null;
    }
    const updated = {
      ...current.raw,
      claudeAiOauth: {
        ...current.raw.claudeAiOauth,
        accessToken,
        refreshToken: typeof tokenData.refresh_token === 'string' && tokenData.refresh_token.length > 0
          ? tokenData.refresh_token
          : current.oauth.refreshToken,
        expiresAt: typeof tokenData.expires_in === 'number'
          ? Date.now() + tokenData.expires_in * 1000
          : current.oauth.expiresAt,
      },
    };
    const tmpFile = credentialsPath + '.happy-refresh.tmp';
    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, credentialsPath);
    logger.debug(`[usageCache] refreshed expired OAuth token for '${accountId}'`);
    return accessToken;
  });
}

/**
 * Extract a usable OAuth access token for an account. File first (refreshing
 * it when expired — see refreshFileCredentials); on macOS fall back to the
 * keychain (per-dir hashed service, plus the plain global service for the
 * default account only, so one login's token never stands in for another's).
 */
export async function readOAuthAccessToken(account: ClaudeAccount): Promise<string | null> {
  const configDir = accountConfigDir(account) ?? defaultClaudeConfigDir();
  const credentialsPath = join(configDir, '.credentials.json');
  if (existsSync(credentialsPath)) {
    const cred = await readCredentialsFile(credentialsPath);
    if (cred) {
      if (tokenLooksLive(cred.oauth, Date.now())) return cred.oauth.accessToken;
      try {
        const refreshed = await refreshFileCredentials(credentialsPath, account.id);
        if (refreshed) return refreshed;
      } catch (e) {
        logger.debug(`[usageCache] token refresh errored for '${account.id}'`, e);
      }
      return null; // expired and unrefreshable — don't offer a token that will 401
    }
  }
  if (process.platform === 'darwin') {
    const fromHashed = await readKeychainToken(keychainService(configDir));
    if (fromHashed) return fromHashed;
    if (accountConfigDir(account) === null) {
      return await readKeychainToken('Claude Code-credentials');
    }
  }
  return null;
}

// ─── Polling ──────────────────────────────────────────────────────────────────

let refreshChain: Promise<void> = Promise.resolve();

/**
 * Fire-and-forget TTL-gated refresh of the given accounts' usage windows.
 * Serialized on one in-process chain (global concurrency 1); each account is
 * re-checked against the shared cache right before its fetch, so concurrent
 * happy sessions converge on one fetch per account per TTL window.
 */
export function scheduleUsageRefresh(accounts: ClaudeAccount[], minFetchedAt = 0): void {
  refreshChain = refreshChain
    .then(() => refreshAccounts(accounts, minFetchedAt))
    .catch((e) => {
      logger.debug('[usageCache] refresh chain failed (ignored)', e);
    });
}

/** Awaitable variant for callers that want the freshest possible cache. */
export function flushUsageRefresh(): Promise<void> {
  return refreshChain;
}

async function refreshAccounts(accounts: ClaudeAccount[], minFetchedAt: number): Promise<void> {
  for (const account of accounts) {
    const cache = await readUsageCache();
    if (!usageFetchDue(cache, account.id, Date.now(), minFetchedAt)) continue;
    await refreshAccount(account);
  }
}

async function refreshAccount(account: ClaudeAccount): Promise<void> {
  const recordFailure = async () => {
    await updateUsageCache(c => ({
      ...c,
      backoff: { ...c.backoff, [account.id]: nextBackoff(c.backoff[account.id], Date.now()) },
    }));
  };
  try {
    const token = await readOAuthAccessToken(account);
    if (!token) {
      logger.debug(`[usageCache] no access token for '${account.id}' — backing off`);
      await recordFailure();
      return;
    }
    const response = await fetch(USAGE_API_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const parsed = parseUsageResponseBody(await response.text());
    if (!parsed) {
      throw new Error('no usable rate-limit windows in response');
    }
    await updateUsageCache(c => {
      const backoff = { ...c.backoff };
      delete backoff[account.id];
      return {
        ...c,
        accounts: { ...c.accounts, [account.id]: { ...parsed, fetchedAt: Date.now() } },
        backoff,
      };
    });
    const modelWindows = Object.values(parsed.modelScoped ?? {}).map(w => ` ${w.label}=${w.utilization}%`).join('');
    logger.debug(`[usageCache] refreshed '${account.id}': 5h=${parsed.fiveHour?.utilization ?? '?'}% 7d=${parsed.sevenDay?.utilization ?? '?'}%${modelWindows}`);
  } catch (e) {
    logger.debug(`[usageCache] fetch failed for '${account.id}' (backing off)`, e);
    await recordFailure();
  }
}

/**
 * Drop cached usage and backoff state for an account id. Must be called when
 * the id's login identity may have changed (accounts add/login/remove): the
 * cache is keyed by happy account id, so after a re-login the old entry
 * describes a DIFFERENT Claude account's utilization, and a backoff built up
 * by the previous login's expired token would delay the first fetch with the
 * new token by up to an hour — both feed wrong data into switch decisions.
 */
export async function clearAccountUsageState(accountId: string): Promise<void> {
  await updateUsageCache(c => {
    const accounts = { ...c.accounts };
    const backoff = { ...c.backoff };
    delete accounts[accountId];
    delete backoff[accountId];
    return { ...c, accounts, backoff };
  });
}

/** Record an auto-switch and prune history past the 24h guard window. */
export async function recordAccountSwitch(from: string, to: string, at: number): Promise<void> {
  await updateUsageCache(c => ({
    ...c,
    switches: [...c.switches.filter(s => at - s.at < SWITCH_HISTORY_WINDOW_MS), { at, from, to }],
  }));
}

export function recentSwitches(cache: UsageCacheFile, nowMs: number): SwitchEvent[] {
  return cache.switches.filter(s => nowMs - s.at < SWITCH_HISTORY_WINDOW_MS);
}
