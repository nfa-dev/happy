/**
 * Types and schema for Claude multi-account support (account switching)
 *
 * An "account" is a Claude Code login isolated in its own config directory
 * (pointed at via CLAUDE_CONFIG_DIR). Credential files inside the directory
 * are owned and refreshed by claude itself — happy only reads them.
 *
 * The registry is persisted in ~/.claude-accounts/accounts.json; installs from
 * before the move still have it in ~/.happy/settings.json under
 * `claudeAccountSwitch` until migrate.ts moves it. Kept in its own module (no
 * imports from persistence.ts) so persistence.ts can import the schema
 * without a cycle.
 */

import * as z from 'zod';

export const ClaudeAccountSchema = z.object({
  /** Stable identifier, also the directory name under the accounts root */
  id: z.string(),
  label: z.string().optional(),
  /**
   * Config directory for this login. `null` means the machine default
   * (~/.claude or whatever CLAUDE_CONFIG_DIR the user's shell provides).
   */
  configDir: z.string().nullable().default(null),
  enabled: z.boolean().default(true),
  /** Epoch ms until which the account is rate-limited (set by auto-switch, Phase 2+) */
  cooldownUntil: z.number().nullable().default(null),
  /**
   * Epoch ms when cooldownUntil was recorded. A usage fetch OLDER than this
   * cannot prove the cooldown wrong (the account may have been exhausted
   * after the fetch), so spurious-cooldown healing requires newer data.
   */
  cooldownSetAt: z.number().nullable().default(null),
  /**
   * Cooldowns of the weekly windows of models capped on their own (the Fable
   * limit), keyed like the usage cache's modelScoped ('fable'). Kept apart
   * from cooldownUntil: every other model can still run on the account, so
   * only sessions running the capped model steer clear of it.
   */
  modelCooldowns: z.record(z.string(), z.object({ until: z.number(), setAt: z.number() })).optional(),
});

export type ClaudeAccount = z.infer<typeof ClaudeAccountSchema>;

export const ClaudeAccountSwitchSchema = z.object({
  /** Master switch for automatic switching (Phase 2). Manual `accounts use` works regardless. */
  enabled: z.boolean().default(false),
  /**
   * auto/round-robin/dynamic pick the candidate once a threshold or rate-limit
   * trigger fires; balance additionally rebalances at every turn boundary,
   * moving to the least-utilized account when the score gap is large enough.
   */
  strategy: z.enum(['auto', 'round-robin', 'dynamic', 'balance', 'off']).default('auto'),
  /**
   * 0-1, meaning depends on the strategy:
   * - auto/round-robin/dynamic: 5h-window utilization above which a proactive
   *   switch is attempted
   * - balance: utilization gap (current − candidate, each max(5h, 7d)) that
   *   triggers a turn-boundary rebalance
   * A session running a model capped on its own weekly window (Fable) applies
   * either meaning to that window instead of 5h/7d.
   */
  switchThreshold: z.number().min(0).max(1).default(0.85),
  accounts: z.array(ClaudeAccountSchema).default([]),
  /** Account new sessions run under. `null` = default account. */
  activeAccountId: z.string().nullable().default(null),
  /** Round-robin cursor (Phase 2) */
  lastUsedIndex: z.number().default(0),
  guard: z.object({
    /** Don't switch back to the previous account within this window (ping-pong guard) */
    noReturnWithinSec: z.number().default(300),
    /** Max auto-switches per rolling 24h across all sessions; 0 = unlimited */
    maxSwitchesPer24h: z.number().default(0),
  }).default({ noReturnWithinSec: 300, maxSwitchesPer24h: 0 }),
});

export type ClaudeAccountSwitchSettings = z.infer<typeof ClaudeAccountSwitchSchema>;
