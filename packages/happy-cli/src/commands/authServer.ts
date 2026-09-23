/**
 * `happy auth server` — choose the Happy server (and web app) this machine uses
 *
 * Saves settings.serverUrl / settings.webappUrl, which every happy process
 * reads at startup (the daemon and the sessions it spawns included), so a
 * custom server sticks without HAPPY_SERVER_URL / HAPPY_WEBAPP_URL exported in
 * every shell. Precedence is unchanged (configuration.ts): env, then
 * settings.json, then the built-in default. A value equal to the built-in
 * default is removed instead of stored, so the machine keeps following it.
 *
 * A login belongs to the server that issued it, so once the server changes the
 * interactive flow offers `happy auth login --force` — in a child process,
 * because this one resolved its URLs at startup.
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import { configuration, DEFAULT_SERVER_URL, DEFAULT_WEBAPP_URL } from '@/configuration';
import { readCredentials, readSettings, updateSettings, type Settings } from '@/persistence';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

type ServiceUrlKey = 'serverUrl' | 'webappUrl';

export type EffectiveServiceUrl = { value: string; source: 'env' | 'settings' | 'default' };

const SERVICE_URLS: Record<ServiceUrlKey, { label: string; env: string; flag: string; builtIn: string }> = {
  serverUrl: { label: 'Server URL', env: 'HAPPY_SERVER_URL', flag: '--server-url', builtIn: DEFAULT_SERVER_URL },
  webappUrl: { label: 'Web app URL', env: 'HAPPY_WEBAPP_URL', flag: '--webapp-url', builtIn: DEFAULT_WEBAPP_URL },
};
const KEYS = Object.keys(SERVICE_URLS) as ServiceUrlKey[];

export async function handleAuthServer(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    showAuthServerHelp();
    return;
  }

  const settings = await readSettings();
  const before = effectiveServiceUrls(settings);

  // Flags make it scriptable (no prompts); a URL not named keeps its stored value
  const interactive = !args.includes('--reset') && !KEYS.some(key => args.includes(SERVICE_URLS[key].flag));
  const chosen: Record<ServiceUrlKey, string | null> = args.includes('--reset')
    ? { serverUrl: null, webappUrl: null }
    : { serverUrl: settings.serverUrl ?? null, webappUrl: settings.webappUrl ?? null };
  for (const key of KEYS) {
    const index = args.indexOf(SERVICE_URLS[key].flag);
    if (index < 0) {
      continue;
    }
    const normalized = normalizeServiceUrl(args[index + 1] ?? '');
    if (normalized === null) {
      console.error(chalk.red(`${SERVICE_URLS[key].flag} needs an http(s) URL, e.g. https://happy.example.com`));
      process.exit(1);
    }
    chosen[key] = normalized;
  }
  if (interactive && !process.stdin.isTTY) {
    console.error(chalk.red('No terminal to ask in — pass --server-url / --webapp-url, or --reset'));
    process.exit(1);
  }

  console.log(chalk.bold('\nHappy server\n'));
  for (const line of describeServiceUrls(before)) {
    console.log(`  ${line}`);
  }
  console.log('');

  if (interactive) {
    // Defaults are what this machine uses right now, so Enter keeps it
    // (and turns a value that only lives in an env var into a saved one)
    const answers = await inquirer.prompt(KEYS.map(key => ({
      type: 'input' as const,
      name: key,
      message: SERVICE_URLS[key].label,
      default: before[key].value,
      validate: (input: string) => normalizeServiceUrl(input) !== null || 'Enter an http(s) URL, e.g. https://happy.example.com',
    })));
    for (const key of KEYS) {
      chosen[key] = normalizeServiceUrl(String(answers[key]));
    }
  }

  const next = withServiceUrls(settings, chosen);
  if (KEYS.every(key => next[key] === settings[key])) {
    console.log(chalk.gray('Nothing to change.'));
    return;
  }
  const saved = await updateSettings(current => withServiceUrls(current, chosen));
  const after = effectiveServiceUrls(saved);
  console.log(chalk.green(`✓ Saved to ${configuration.settingsFile}`));
  for (const line of describeServiceUrls(after)) {
    console.log(`  ${line}`);
  }
  for (const key of KEYS) {
    if (after[key].source === 'env') {
      console.log(chalk.yellow(`⚠️  ${SERVICE_URLS[key].env} is set in this shell and still overrides settings.json — unset it to use the saved value`));
    }
  }

  if (after.serverUrl.value === before.serverUrl.value) {
    return;
  }
  const hasLogin = (await readCredentials()) !== null;
  const loginArgs = hasLogin ? ['auth', 'login', '--force'] : ['auth', 'login'];
  const loginHint = `happy ${loginArgs.join(' ')}`;
  if (hasLogin) {
    console.log(chalk.yellow(`\nThe current login belongs to ${before.serverUrl.value}; log in again for ${after.serverUrl.value}.`));
    console.log(chalk.gray('A running daemon keeps the old server until that login stops it; the next happy run starts it on the new one.'));
  }
  if (!interactive) {
    console.log(chalk.gray(`Next: ${loginHint}`));
    return;
  }
  const { loginNow } = await inquirer.prompt([{
    type: 'confirm',
    name: 'loginNow',
    message: `Log in to ${after.serverUrl.value} now?`,
    default: true,
  }]);
  if (!loginNow) {
    console.log(chalk.gray(`Log in later with: ${loginHint}`));
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnHappyCLI(loginArgs, { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', () => resolve());
    });
  } catch (error) {
    console.error(chalk.red(`Could not start the login: ${error instanceof Error ? error.message : String(error)}`));
    console.error(chalk.gray(`Run it yourself: ${loginHint}`));
  }
}

/**
 * http(s) URL in the form the CLI appends paths to (`${serverUrl}/v1/...`): no
 * trailing slash, query, fragment or credentials. Null when the input is not one.
 */
export function normalizeServiceUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
    return null;
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/** Settings with the chosen URLs; null or the built-in default removes the key so the default applies */
export function withServiceUrls(current: Settings, chosen: Record<ServiceUrlKey, string | null>): Settings {
  const next: Settings = { ...current };
  for (const key of KEYS) {
    const value = chosen[key];
    if (value === null || value === SERVICE_URLS[key].builtIn) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

/** What a happy process started now would use, and why — the precedence of configuration.ts */
export function effectiveServiceUrls(settings: Settings): Record<ServiceUrlKey, EffectiveServiceUrl> {
  const effective = (key: ServiceUrlKey): EffectiveServiceUrl => {
    const fromEnv = process.env[SERVICE_URLS[key].env];
    if (fromEnv) {
      return { value: fromEnv, source: 'env' };
    }
    const stored = settings[key];
    if (typeof stored === 'string' && stored.length > 0) {
      return { value: stored, source: 'settings' };
    }
    return { value: SERVICE_URLS[key].builtIn, source: 'default' };
  };
  return { serverUrl: effective('serverUrl'), webappUrl: effective('webappUrl') };
}

export function describeServiceUrls(urls: Record<ServiceUrlKey, EffectiveServiceUrl>): string[] {
  return KEYS.map((key) => {
    const { value, source } = urls[key];
    const origin = source === 'env' ? SERVICE_URLS[key].env : source === 'settings' ? 'settings.json' : 'built-in default';
    return `${SERVICE_URLS[key].label.padEnd(12)} ${value} ${chalk.gray(`(${origin})`)}`;
  });
}

function showAuthServerHelp(): void {
  console.log(`
${chalk.bold('happy auth server')} - Choose the Happy server this machine uses

${chalk.bold('Usage:')}
  happy auth server                             Ask for the server and web app URLs
  happy auth server --server-url <url> [--webapp-url <url>]
                                                Set them without prompting
  happy auth server --reset                     Go back to the built-in defaults

${chalk.gray('Saved in settings.json, which the daemon and every session read at startup.')}
${chalk.gray('HAPPY_SERVER_URL / HAPPY_WEBAPP_URL still take precedence while set.')}
${chalk.gray(`Built-in defaults: ${DEFAULT_SERVER_URL} and ${DEFAULT_WEBAPP_URL}`)}
`);
}
