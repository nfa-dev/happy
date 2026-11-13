import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeAccount } from './types';

// The machine-default login is resolved from the home dir and from the
// CLAUDE_CONFIG_DIR seen at module load: point the home dir into a sandbox and
// clear CLAUDE_CONFIG_DIR before registry.ts is imported (dynamically, inside
// the tests).
const home = mkdtempSync(join(tmpdir(), 'happy-registry-'));
const sandboxEnv = {
  HOME: home,
  USERPROFILE: home,
  HAPPY_HOME_DIR: join(home, '.happy'),
  HAPPY_CLAUDE_ACCOUNTS_DIR: join(home, '.claude-accounts'),
};
const savedEnv = Object.fromEntries([...Object.keys(sandboxEnv), 'CLAUDE_CONFIG_DIR'].map(key => [key, process.env[key]]));
Object.assign(process.env, sandboxEnv);
delete process.env.CLAUDE_CONFIG_DIR;

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const defaultAccount: ClaudeAccount = { id: 'default', configDir: null, enabled: true, cooldownUntil: null, cooldownSetAt: null };

describe('hasClaudeCredentials', () => {
  it('finds a keychain-only default login through ~/.claude.json at the home root', async () => {
    const { hasClaudeCredentials } = await import('./registry');
    // macOS keeps the token in the keychain: ~/.claude holds no .credentials.json
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: 'default@x' } }));
    expect(hasClaudeCredentials(defaultAccount)).toBe(true);
  });

  it('reports the default login as missing when ~/.claude.json has no oauthAccount', async () => {
    const { hasClaudeCredentials } = await import('./registry');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
    expect(hasClaudeCredentials(defaultAccount)).toBe(false);
  });

  it('reads an account login from the .claude.json inside its own config dir', async () => {
    const { hasClaudeCredentials } = await import('./registry');
    const configDir = join(home, '.claude-accounts', 'team2');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'team2@x' } }));
    expect(hasClaudeCredentials({ ...defaultAccount, id: 'team2', configDir })).toBe(true);
  });
});
