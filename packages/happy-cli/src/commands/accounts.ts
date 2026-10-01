/**
 * `happy accounts` — manage multiple Claude logins for account switching
 *
 * Each account is an isolated Claude Code config directory
 * (~/.claude-accounts/<id>) whose projects dir links to the default login's,
 * so sessions can be resumed across accounts. Logging in is delegated to
 * `claude auth login` running against the account's CLAUDE_CONFIG_DIR —
 * claude owns and refreshes the credentials, happy never writes them.
 */

import chalk from 'chalk';
import { spawn as crossSpawn } from 'cross-spawn';
import {
  DEFAULT_ACCOUNT_ID,
  accountConfigDir,
  accountConfigDirFor,
  accountsRootDir,
  defaultClaudeConfigDir,
  findAccount,
  getActiveAccount,
  hasClaudeCredentials,
  readAccountRegistry,
  sharedProjectsDir,
  updateAccountRegistry,
} from '@/claude/accounts/registry';
import { ensureAccountDir, verifyAccountLinks } from '@/claude/accounts/dirs';
import { migrateLegacyAccountLayout } from '@/claude/accounts/migrate';
import { clearAccountUsageState, modelScopeLabel, readUsageCache, type CachedAccountUsage } from '@/claude/accounts/usageCache';
import type { ClaudeAccount } from '@/claude/accounts/types';

const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9-_]{0,63}$/;

export async function handleAccountsCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAccountsHelp();
    return;
  }

  // Installs from before the move keep accounts inside the happy home, where
  // `happy auth logout` deletes them: move them out before touching anything
  const migration = await migrateLegacyAccountLayout();
  for (const line of migration.moved) {
    console.log(chalk.gray(`✓ Moved out of the happy home: ${line}`));
  }
  if (migration.pending.length > 0) {
    console.log(chalk.yellow('⚠️  Claude account data not moved out of the happy home yet (retried on every run):'));
    for (const line of migration.pending) {
      console.log(chalk.yellow(`   - ${line}`));
    }
  }

  switch (subcommand) {
    case 'add':
      await handleAdd(args.slice(1));
      break;
    case 'list':
    case 'ls':
      await handleList();
      break;
    case 'remove':
    case 'rm':
      await handleRemove(args.slice(1));
      break;
    case 'login':
      await handleLogin(args.slice(1));
      break;
    case 'use':
      await handleUse(args.slice(1));
      break;
    case 'auto':
      await handleAuto(args.slice(1));
      break;
    default:
      console.error(chalk.red(`Unknown accounts subcommand: ${subcommand}`));
      showAccountsHelp();
      process.exit(1);
  }
}

function showAccountsHelp(): void {
  console.log(`
${chalk.bold('happy accounts')} - Manage multiple Claude logins

${chalk.bold('Usage:')}
  happy accounts add <id> [--label <text>]   Register an account and log in via claude
  happy accounts list                        Show accounts and which one is active
  happy accounts use <id>                    Make new sessions run under this account
  happy accounts login <id>                  (Re-)login an existing account
  happy accounts remove <id>                 Unregister an account (files are kept)
  happy accounts auto [on|off]               Show or toggle automatic switching
       [--threshold <0..1>]                  Default 0.85. auto/round-robin/dynamic: 5h utilization
                                             that triggers a switch. balance: utilization gap
                                             between accounts that triggers a rebalance.
       [--strategy auto|round-robin|dynamic|balance]
                                             auto/round-robin/dynamic: how to pick the candidate
                                             once the threshold (or a rate limit) triggers a switch.
                                             balance: rebalance every turn — move to the other
                                             account when its usage (max of 5h/7d) is lower than
                                             the current account's by at least the threshold.
                                             Sessions running Fable, which has its own weekly
                                             limit, apply all of this to that limit instead of 5h/7d.
       [--max-switches <n>]                  Max auto-switches per 24h; 0 = unlimited (default)

${chalk.gray('Accounts are separate Claude Code logins in isolated config directories.')}
${chalk.gray('Session history is shared between them, so a conversation started under')}
${chalk.gray('one account can be resumed under another.')}
${chalk.gray(`Account logins and the account list live in ${accountsRootDir()}`)}
${chalk.gray('(override with HAPPY_CLAUDE_ACCOUNTS_DIR), outside the happy home, so')}
${chalk.gray('`happy auth logout` leaves them alone.')}
`);
}

async function handleAdd(args: string[]): Promise<void> {
  const id = args[0];
  if (!id || !ACCOUNT_ID_PATTERN.test(id)) {
    console.error(chalk.red('Usage: happy accounts add <id> [--label <text>]'));
    console.error(chalk.gray('  <id> must be lowercase letters, digits, - or _ (max 64 chars)'));
    process.exit(1);
  }
  const labelIndex = args.indexOf('--label');
  const label = labelIndex >= 0 ? args[labelIndex + 1] : undefined;

  const registry = await readAccountRegistry();
  if (findAccount(registry, id)) {
    console.error(chalk.red(`Account '${id}' already exists`));
    process.exit(1);
  }

  const configDir = accountConfigDirFor(id);
  ensureAccountDir(configDir);
  await updateAccountRegistry((r) => ({
    ...r,
    accounts: [...r.accounts, { id, label, configDir, enabled: true, cooldownUntil: null, cooldownSetAt: null }],
  }));
  // A previously removed account with the same id may have left usage/backoff
  // state behind — it describes a different login, so start clean.
  await clearAccountUsageState(id);
  console.log(chalk.green(`✓ Registered account '${id}'`));
  console.log(chalk.gray(`  Config dir: ${configDir}`));
  console.log(chalk.gray(`  Session history: ${sharedProjectsDir()} (shared with every account)`));

  console.log(chalk.blue('\nLogging in with claude (browser window will open)...\n'));
  const loggedIn = await runClaudeAuthLogin(configDir);
  if (loggedIn) {
    console.log(chalk.green(`\n✓ Account '${id}' is ready`));
    console.log(chalk.gray(`  Switch to it with: happy accounts use ${id}`));
  } else {
    console.log(chalk.yellow(`\n⚠️  Login did not complete. Retry with: happy accounts login ${id}`));
  }
}

function formatUsage(usage: CachedAccountUsage | undefined): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.fiveHour) parts.push(`5h ${Math.round(usage.fiveHour.utilization)}%`);
  if (usage.sevenDay) parts.push(`7d ${Math.round(usage.sevenDay.utilization)}%`);
  for (const window of Object.values(usage.modelScoped ?? {})) {
    parts.push(`${window.label} ${Math.round(window.utilization)}%`);
  }
  if (parts.length === 0) return '';
  const ageMin = Math.round((Date.now() - usage.fetchedAt) / 60_000);
  return chalk.gray(` · ${parts.join(' ')} (${ageMin < 1 ? 'just now' : `${ageMin}m ago`})`);
}

async function handleList(): Promise<void> {
  const registry = await readAccountRegistry();
  const active = getActiveAccount(registry);
  const linkProblems = verifyAccountLinks(registry.accounts);
  const usageCache = await readUsageCache();

  console.log(chalk.bold('\nClaude accounts\n'));
  for (const account of registry.accounts) {
    const isActive = account.id === active.id;
    const marker = isActive ? chalk.green('●') : chalk.gray('○');
    const name = isActive ? chalk.bold(account.id) : account.id;
    const label = account.label ? chalk.gray(` (${account.label})`) : '';
    const credentials = hasClaudeCredentials(account)
      ? chalk.green('logged in')
      : chalk.red('no login') + chalk.gray(` — happy accounts login ${account.id}`);
    const cooldown = account.cooldownUntil && account.cooldownUntil > Date.now()
      ? chalk.yellow(` · rate-limited until ${new Date(account.cooldownUntil).toLocaleString()}`)
      : '';
    const modelCooldowns = Object.entries(account.modelCooldowns ?? {})
      .filter(([, c]) => c.until > Date.now())
      .map(([scope, c]) => chalk.yellow(` · ${modelScopeLabel(scope, usageCache)} limit until ${new Date(c.until).toLocaleString()}`))
      .join('');
    const disabled = account.enabled ? '' : chalk.gray(' · disabled');
    const usage = formatUsage(usageCache.accounts[account.id]);
    console.log(`  ${marker} ${name}${label} — ${credentials}${cooldown}${modelCooldowns}${disabled}${usage}`);
    console.log(chalk.gray(`      ${accountConfigDir(account) ?? defaultClaudeConfigDir() + ' (machine default)'}`));
  }
  if (linkProblems.length > 0) {
    console.log(chalk.yellow('\n⚠️  Shared history link problems:'));
    for (const problem of linkProblems) {
      console.log(chalk.yellow(`  - ${problem}`));
    }
  }
  const auto = registry.enabled
    ? chalk.green(`on (strategy: ${registry.strategy}, threshold: ${Math.round(registry.switchThreshold * 100)}%)`)
    : chalk.gray('off — enable with: happy accounts auto on');
  console.log(`\n  Auto-switch: ${auto}\n`);
}

async function handleAuto(args: string[]): Promise<void> {
  const mode = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  if (mode && mode !== 'on' && mode !== 'off') {
    console.error(chalk.red('Usage: happy accounts auto [on|off] [--threshold <0..1>] [--strategy auto|round-robin|dynamic|balance] [--max-switches <n>]'));
    process.exit(1);
  }
  const thresholdIndex = args.indexOf('--threshold');
  const threshold = thresholdIndex >= 0 ? Number(args[thresholdIndex + 1]) : undefined;
  if (threshold !== undefined && !(threshold > 0 && threshold <= 1)) {
    console.error(chalk.red('--threshold must be a number in (0, 1], e.g. 0.85'));
    process.exit(1);
  }
  const strategyIndex = args.indexOf('--strategy');
  const strategy = strategyIndex >= 0 ? args[strategyIndex + 1] : undefined;
  if (strategy !== undefined && !['auto', 'round-robin', 'dynamic', 'balance'].includes(strategy)) {
    console.error(chalk.red('--strategy must be one of: auto, round-robin, dynamic, balance'));
    process.exit(1);
  }
  const maxSwitchesIndex = args.indexOf('--max-switches');
  const maxSwitches = maxSwitchesIndex >= 0 ? Number(args[maxSwitchesIndex + 1]) : undefined;
  if (maxSwitches !== undefined && !(Number.isInteger(maxSwitches) && maxSwitches >= 0)) {
    console.error(chalk.red('--max-switches must be a non-negative integer (0 = unlimited)'));
    process.exit(1);
  }

  const registry = await updateAccountRegistry((r) => ({
    ...r,
    enabled: mode ? mode === 'on' : r.enabled,
    switchThreshold: threshold ?? r.switchThreshold,
    strategy: (strategy as 'auto' | 'round-robin' | 'dynamic' | 'balance' | undefined) ?? r.strategy,
    guard: maxSwitches !== undefined ? { ...r.guard, maxSwitchesPer24h: maxSwitches } : r.guard,
  }));

  const state = registry.enabled ? chalk.green('on') : chalk.gray('off');
  const thresholdMeaning = registry.strategy === 'balance' ? 'utilization gap between accounts' : 'of the 5h window';
  console.log(`Auto-switch: ${state} · strategy: ${registry.strategy} · threshold: ${Math.round(registry.switchThreshold * 100)}% ${thresholdMeaning}`);
  console.log(chalk.gray('  Sessions running Fable apply the threshold to the Fable weekly limit instead of 5h/7d.'));
  const switchCap = registry.guard.maxSwitchesPer24h > 0 ? `max ${registry.guard.maxSwitchesPer24h} switches/24h` : 'no switch cap';
  console.log(chalk.gray(`  Guards: no return within ${registry.guard.noReturnWithinSec}s, ${switchCap}`));
  if (registry.enabled && registry.accounts.length < 2) {
    console.log(chalk.yellow('  ⚠️  Only one account is registered — add more with: happy accounts add <id>'));
  }
  if (mode) {
    console.log(chalk.gray('  Applies to newly started sessions (running sessions pick it up at the next turn).'));
  }
}

async function handleUse(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error(chalk.red('Usage: happy accounts use <id>'));
    process.exit(1);
  }
  const registry = await readAccountRegistry();
  const account = findAccount(registry, id);
  if (!account) {
    console.error(chalk.red(`Unknown account '${id}'. See: happy accounts list`));
    process.exit(1);
  }
  if (!hasClaudeCredentials(account)) {
    console.log(chalk.yellow(`⚠️  Account '${id}' has no Claude login yet — run: happy accounts login ${id}`));
  }
  // Explicitly choosing an account is a user override — drop any recorded
  // cooldown so a stale/spurious rate-limit mark can't immediately park it.
  await updateAccountRegistry((r) => ({
    ...r,
    activeAccountId: id === DEFAULT_ACCOUNT_ID ? null : id,
    accounts: r.accounts.map(a => a.id === id ? { ...a, cooldownUntil: null, cooldownSetAt: null, modelCooldowns: undefined } : a),
  }));
  console.log(chalk.green(`✓ Active account: ${id}`));
  console.log(chalk.gray('  Applies to newly started sessions. Running sessions keep their account.'));
}

async function handleLogin(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error(chalk.red('Usage: happy accounts login <id>'));
    process.exit(1);
  }
  const registry = await readAccountRegistry();
  const account = findAccount(registry, id);
  if (!account) {
    console.error(chalk.red(`Unknown account '${id}'. See: happy accounts list`));
    process.exit(1);
  }
  const configDir = accountConfigDir(account);
  if (configDir) {
    ensureAccountDir(configDir);
  }
  const loggedIn = await runClaudeAuthLogin(configDir);
  if (loggedIn) {
    // The id may now hold a DIFFERENT Claude login: cached usage, fetch
    // backoff and any recorded cooldown all described the previous one.
    await clearAccountUsageState(id);
    await updateAccountRegistry((r) => ({
      ...r,
      accounts: r.accounts.map(a => a.id === id ? { ...a, cooldownUntil: null, cooldownSetAt: null, modelCooldowns: undefined } : a),
    }));
  }
  console.log(loggedIn ? chalk.green(`\n✓ Account '${id}' logged in`) : chalk.yellow('\n⚠️  Login did not complete'));
}

async function handleRemove(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error(chalk.red('Usage: happy accounts remove <id>'));
    process.exit(1);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    console.error(chalk.red('The default account cannot be removed'));
    process.exit(1);
  }
  const registry = await readAccountRegistry();
  const account = findAccount(registry, id);
  if (!account) {
    console.error(chalk.red(`Unknown account '${id}'`));
    process.exit(1);
  }
  await updateAccountRegistry((r) => ({
    ...r,
    accounts: r.accounts.filter(a => a.id !== id),
    activeAccountId: r.activeAccountId === id ? null : r.activeAccountId,
  }));
  await clearAccountUsageState(id);
  console.log(chalk.green(`✓ Removed account '${id}' from the registry`));
  const configDir = accountConfigDir(account);
  if (configDir) {
    console.log(chalk.gray(`  Login data kept at ${configDir} — delete it manually if no longer needed.`));
  }
}

/**
 * Run `claude auth login` interactively against the given config dir
 * (null = machine default). Resolves to whether the login left credentials.
 */
function runClaudeAuthLogin(configDir: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    if (configDir) {
      env.CLAUDE_CONFIG_DIR = configDir;
    }
    const child = crossSpawn('claude', ['auth', 'login'], { stdio: 'inherit', env });
    child.on('error', (error) => {
      console.error(chalk.red(`Failed to run claude: ${error.message}`));
      console.error(chalk.gray('Is Claude Code installed and on PATH?'));
      resolve(false);
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}
