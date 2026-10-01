/**
 * Claude account registry — bookkeeping for multi-account switching
 *
 * Everything multi-account lives outside the happy home, under
 * ~/.claude-accounts (HAPPY_CLAUDE_ACCOUNTS_DIR overrides it): the registry
 * (accounts.json), one config dir per account and the usage cache. `happy
 * auth logout` wipes the happy home, and Claude logins must survive that.
 * Session history is the machine-default login's own projects dir; account
 * dirs link to it (dirs.ts).
 *
 * Installs from before the move keep the registry in the `claudeAccountSwitch`
 * block of ~/.happy/settings.json and the account dirs under
 * ~/.happy/claude-accounts. Until migrate.ts moves them, the registry is read
 * from and written to that legacy block, so an unmigrated install behaves as
 * before. Also resolves which CLAUDE_CONFIG_DIR a session should run under.
 */

import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { configuration } from '@/configuration';
import { readSettings, updateSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { withFileLock } from '@/utils/fileLock';
import { ClaudeAccountSwitchSchema, type ClaudeAccount, type ClaudeAccountSwitchSettings } from './types';

export const DEFAULT_ACCOUNT_ID = 'default';

export function accountsRootDir(): string {
  const override = process.env.HAPPY_CLAUDE_ACCOUNTS_DIR;
  return override ? expandHome(override) : join(homedir(), '.claude-accounts');
}

/** Where account dirs lived before the move — inside the happy home that logout wipes */
export function legacyAccountsRootDir(): string {
  return join(configuration.happyHomeDir, 'claude-accounts');
}

/** Where shared session history lived before the move; <default>/projects linked to it */
export function legacySharedProjectsDir(): string {
  return join(configuration.happyHomeDir, 'claude-shared', 'projects');
}

/** Session history shared by every account: the machine-default login's projects dir */
export function sharedProjectsDir(): string {
  return join(defaultClaudeConfigDir(), 'projects');
}

export function registryFilePath(): string {
  return join(accountsRootDir(), 'accounts.json');
}

export function accountConfigDirFor(id: string): string {
  return join(accountsRootDir(), id);
}

/**
 * Whether a config dir lives under happy's own accounts root — i.e. it was
 * put into the environment by happy itself, not by the user. Happy sessions
 * mutate their process.env (applyActiveAccountToEnv / auto-switch) and that
 * value is INHERITED by children they spawn — notably the auto-started
 * daemon, which then leaks it into every session it launches. An inherited
 * CLAUDE_CONFIG_DIR pointing at an account dir must therefore never be
 * mistaken for the machine default: that collapses the default account onto
 * the leaked account and turns every switch between them into a no-op.
 * The legacy root counts too: unmigrated account dirs still live there, and a
 * daemon started before the move can leak a value pointing into it.
 */
export function isHappyManagedConfigDir(dir: string): boolean {
  return isWithinDir(dir, accountsRootDir()) || isWithinDir(dir, legacyAccountsRootDir());
}

/** Whether `dir` is `root` or lies inside it (case- and separator-insensitive on Windows) */
export function isWithinDir(dir: string, root: string): boolean {
  const normalize = (p: string) => {
    const expanded = expandHome(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? expanded.toLowerCase().replaceAll('/', '\\') : expanded;
  };
  const separator = process.platform === 'win32' ? '\\' : '/';
  const candidate = normalize(dir);
  const normalizedRoot = normalize(root);
  return candidate === normalizedRoot || candidate.startsWith(normalizedRoot + separator);
}

// Captured at module load, before applyActiveAccountToEnv / the auto-switch
// controller ever override process.env.CLAUDE_CONFIG_DIR. Reading the live env
// after an override would misreport the ACCOUNT dir as the machine default
// (breaking hasClaudeCredentials for the default account and switch-back).
// A happy-managed value is a leak from a parent happy process, not user intent.
const initialEnvConfigDir: string | undefined =
  process.env.CLAUDE_CONFIG_DIR && !isHappyManagedConfigDir(process.env.CLAUDE_CONFIG_DIR)
    ? process.env.CLAUDE_CONFIG_DIR
    : undefined;

/** The machine-default Claude config dir (what claude uses with no happy override) */
export function defaultClaudeConfigDir(): string {
  if (initialEnvConfigDir) {
    return expandHome(initialEnvConfigDir);
  }
  return join(homedir(), '.claude');
}

/**
 * Point CLAUDE_CONFIG_DIR at the given account. Switching back to the default
 * account restores the session-start value (a genuinely user-provided
 * CLAUDE_CONFIG_DIR is honored; a leaked or happy-set one is removed).
 */
export function applyAccountConfigDirToEnv(account: ClaudeAccount): void {
  const dir = accountConfigDir(account);
  if (dir) {
    process.env.CLAUDE_CONFIG_DIR = dir;
  } else if (initialEnvConfigDir) {
    process.env.CLAUDE_CONFIG_DIR = initialEnvConfigDir;
  } else {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
}

export function expandHome(pathValue: string): string {
  return pathValue.replace(/^~(?=[\\/]|$)/, homedir());
}

/**
 * Parse the settings block, filling defaults and guaranteeing the default
 * account is always present at index 0.
 */
function withDefaults(raw: unknown): ClaudeAccountSwitchSettings {
  const parsed = ClaudeAccountSwitchSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    logger.warn(`Invalid claudeAccountSwitch settings, falling back to defaults: ${parsed.error.message}`);
  }
  const settings = parsed.success ? parsed.data : ClaudeAccountSwitchSchema.parse({});
  if (!settings.accounts.some(a => a.id === DEFAULT_ACCOUNT_ID)) {
    settings.accounts.unshift({
      id: DEFAULT_ACCOUNT_ID,
      label: 'Default login',
      configDir: null,
      enabled: true,
      cooldownUntil: null,
      cooldownSetAt: null,
    });
  }
  return settings;
}

async function readRegistryFile(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(registryFilePath(), 'utf8'));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      logger.warn(`Failed to read ${registryFilePath()}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}

/** Atomically mutate accounts.json under its lock file (temp file + rename) */
async function updateRegistryFile(
  mutate: (registry: ClaudeAccountSwitchSettings) => ClaudeAccountSwitchSettings
): Promise<ClaudeAccountSwitchSettings> {
  const file = registryFilePath();
  await mkdir(dirname(file), { recursive: true });
  return await withFileLock(`${file}.lock`, async () => {
    const updated = mutate(withDefaults(await readRegistryFile()));
    const tmpFile = `${file}.tmp`;
    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, file);
    return updated;
  });
}

/**
 * accounts.json once it exists; before that, the legacy settings.json block
 * of an install that has not been migrated yet.
 */
export async function readAccountRegistry(): Promise<ClaudeAccountSwitchSettings> {
  if (existsSync(registryFilePath())) {
    return withDefaults(await readRegistryFile());
  }
  const settings = await readSettings();
  return withDefaults(settings.claudeAccountSwitch);
}

/**
 * Atomically mutate the registry. An unmigrated install keeps writing its
 * legacy settings.json block (under the settings lock) so every process of
 * that install keeps seeing one registry; anything else writes accounts.json.
 */
export async function updateAccountRegistry(
  mutate: (registry: ClaudeAccountSwitchSettings) => ClaudeAccountSwitchSettings
): Promise<ClaudeAccountSwitchSettings> {
  if (existsSync(registryFilePath()) || (await readSettings()).claudeAccountSwitch === undefined) {
    return await updateRegistryFile(mutate);
  }
  let result!: ClaudeAccountSwitchSettings;
  await updateSettings((current) => {
    result = mutate(withDefaults(current.claudeAccountSwitch));
    return { ...current, claudeAccountSwitch: result };
  });
  return result;
}

/**
 * Move the registry from the legacy settings.json block into accounts.json,
 * repointing each account's configDir through `relocate` (account dirs the
 * migration moved). Idempotent. Once accounts.json exists the legacy block is
 * stale — a process started before the move may even have written it back —
 * so it is dropped either way.
 */
export async function moveRegistryToAccountsRoot(
  relocate: (configDir: string | null) => string | null
): Promise<'moved' | 'updated' | 'none'> {
  const legacy = (await readSettings()).claudeAccountSwitch;
  const fileExists = existsSync(registryFilePath());
  if (!fileExists && legacy === undefined) {
    return 'none';
  }
  const relocateAll = (registry: ClaudeAccountSwitchSettings): ClaudeAccountSwitchSettings => ({
    ...registry,
    accounts: registry.accounts.map(account => ({ ...account, configDir: relocate(account.configDir) })),
  });
  await updateRegistryFile((current) => relocateAll(fileExists ? current : withDefaults(legacy)));
  if (legacy !== undefined) {
    await updateSettings((current) => ({ ...current, claudeAccountSwitch: undefined }));
  }
  return fileExists ? 'updated' : 'moved';
}

export function findAccount(registry: ClaudeAccountSwitchSettings, id: string): ClaudeAccount | undefined {
  return registry.accounts.find(a => a.id === id);
}

export function getActiveAccount(registry: ClaudeAccountSwitchSettings): ClaudeAccount {
  const active = registry.activeAccountId ? findAccount(registry, registry.activeAccountId) : undefined;
  return active ?? findAccount(registry, DEFAULT_ACCOUNT_ID)!;
}

/** Resolved config dir for an account; null = leave the machine default alone */
export function accountConfigDir(account: ClaudeAccount): string | null {
  return account.configDir ? expandHome(account.configDir) : null;
}

/**
 * Whether a Claude login exists for the account. File checks only — never
 * touches the OS keychain. A macOS keychain-only login leaves no
 * .credentials.json, but claude records the account in .claude.json's
 * oauthAccount at login time (our onboarding seed does not), so that field
 * is the fallback signal.
 */
export function hasClaudeCredentials(account: ClaudeAccount): boolean {
  const dir = accountConfigDir(account) ?? defaultClaudeConfigDir();
  if (existsSync(join(dir, '.credentials.json'))) {
    return true;
  }
  try {
    const claudeJson = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
    return claudeJson.oauthAccount != null;
  } catch {
    return false;
  }
}

/**
 * Point CLAUDE_CONFIG_DIR at the active account before any claude spawn.
 *
 * Returns the account that was applied, or null when nothing was changed:
 * - default account active → the machine default (including any user-provided
 *   CLAUDE_CONFIG_DIR) stays as-is
 * - CLAUDE_CODE_OAUTH_TOKEN present → the session is token-scoped (daemon pod
 *   spawns inject it); re-pointing the config dir would fight that auth path
 */
export async function applyActiveAccountToEnv(): Promise<ClaudeAccount | null> {
  const registry = await readAccountRegistry();
  const account = getActiveAccount(registry);
  const dir = accountConfigDir(account);
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    if (dir) {
      logger.warn(`[accounts] CLAUDE_CODE_OAUTH_TOKEN is set — skipping account '${account.id}' config dir override`);
    }
    return null;
  }
  if (!dir) {
    // Still normalize the env: a CLAUDE_CONFIG_DIR leaked from a parent happy
    // process (e.g. via the auto-started daemon) must not survive into the
    // claude spawn, or the default account silently runs as that account.
    const inherited = process.env.CLAUDE_CONFIG_DIR;
    if (inherited && isHappyManagedConfigDir(inherited)) {
      applyAccountConfigDirToEnv(account);
      logger.debug(`[accounts] Removed leaked CLAUDE_CONFIG_DIR=${inherited} (active account is '${account.id}')`);
    }
    return null;
  }
  process.env.CLAUDE_CONFIG_DIR = dir;
  logger.debug(`[accounts] Active account '${account.id}' → CLAUDE_CONFIG_DIR=${dir}`);
  return account;
}
