import { afterAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// The migration works on real locations resolved at module load (happy home,
// accounts root, default login): point all three into a sandbox before the
// modules under test are imported (dynamically, inside the tests).
const sandbox = mkdtempSync(join(tmpdir(), 'happy-migrate-'));
const happyHome = join(sandbox, 'happy');
const accountsRoot = join(sandbox, 'claude-accounts');
const defaultLogin = join(sandbox, 'claude');
const sandboxEnv = { HAPPY_HOME_DIR: happyHome, HAPPY_CLAUDE_ACCOUNTS_DIR: accountsRoot, CLAUDE_CONFIG_DIR: defaultLogin };
const savedEnv = Object.fromEntries(Object.keys(sandboxEnv).map(key => [key, process.env[key]]));
Object.assign(process.env, sandboxEnv);

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'happy-migrate-case-'));
}

function isLink(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

/** Where a link points, normalized the same way as the expected path */
function linkTarget(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('migrateLegacyAccountLayout', () => {
  const legacyShared = join(happyHome, 'claude-shared', 'projects');
  const legacyTeam2 = join(happyHome, 'claude-accounts', 'team2');

  it('moves history, account dirs, registry and usage cache out of the happy home', async () => {
    // The layout earlier builds created: history adopted into the happy home,
    // ~/.claude/projects and the account's projects linked to it
    write(join(legacyShared, 'C--work-alpha', 'session-1.jsonl'), 'history');
    mkdirSync(defaultLogin, { recursive: true });
    symlinkSync(legacyShared, join(defaultLogin, 'projects'), 'junction');
    write(join(legacyTeam2, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"t"}}');
    symlinkSync(legacyShared, join(legacyTeam2, 'projects'), 'junction');
    write(join(happyHome, 'claude-accounts', 'usage-cache.json'), '{"accounts":{},"backoff":{},"switches":[]}');
    write(join(happyHome, 'settings.json'), JSON.stringify({
      schemaVersion: 3,
      onboardingCompleted: true,
      machineId: 'machine-1',
      claudeAccountSwitch: {
        enabled: true,
        activeAccountId: 'team2',
        accounts: [{ id: 'default', configDir: null }, { id: 'team2', configDir: legacyTeam2 }],
      },
    }));

    const { migrateLegacyAccountLayout } = await import('./migrate');
    const result = await migrateLegacyAccountLayout();
    expect(result.pending).toEqual([]);
    expect(result.keep).toEqual([]);
    expect(result.moved).toHaveLength(3); // history, team2, registry

    const projects = join(defaultLogin, 'projects');
    expect(isLink(projects)).toBe(false);
    expect(readFileSync(join(projects, 'C--work-alpha', 'session-1.jsonl'), 'utf8')).toBe('history');
    expect(existsSync(join(happyHome, 'claude-shared'))).toBe(false);

    const team2 = join(accountsRoot, 'team2');
    expect(readFileSync(join(team2, '.credentials.json'), 'utf8')).toContain('accessToken');
    expect(linkTarget(join(team2, 'projects'))).toBe(resolve(projects));
    expect(readFileSync(join(team2, 'projects', 'C--work-alpha', 'session-1.jsonl'), 'utf8')).toBe('history');
    expect(linkTarget(legacyTeam2)).toBe(resolve(team2)); // left for claude processes still running under it

    const registry = JSON.parse(readFileSync(join(accountsRoot, 'accounts.json'), 'utf8'));
    expect(registry.enabled).toBe(true);
    expect(registry.activeAccountId).toBe('team2');
    expect(registry.accounts.find((a: { id: string }) => a.id === 'team2').configDir).toBe(team2);
    const settings = JSON.parse(readFileSync(join(happyHome, 'settings.json'), 'utf8'));
    expect(settings.claudeAccountSwitch).toBeUndefined();
    expect(settings.machineId).toBe('machine-1');

    expect(existsSync(join(accountsRoot, 'usage-cache.json'))).toBe(true);
    expect(existsSync(join(happyHome, 'claude-accounts', 'usage-cache.json'))).toBe(false);
  });

  it('finds nothing to do on the next run', async () => {
    const { migrateLegacyAccountLayout } = await import('./migrate');
    expect(await migrateLegacyAccountLayout()).toEqual({ moved: [], pending: [], keep: [] });
  });

  it('leaves logins and history intact when the happy home is wiped (happy auth logout)', async () => {
    rmSync(happyHome, { recursive: true, force: true });
    expect(readFileSync(join(accountsRoot, 'team2', '.credentials.json'), 'utf8')).toContain('accessToken');
    expect(readFileSync(join(defaultLogin, 'projects', 'C--work-alpha', 'session-1.jsonl'), 'utf8')).toBe('history');
    const { readAccountRegistry } = await import('./registry');
    expect((await readAccountRegistry()).activeAccountId).toBe('team2');
  });

  it('keeps an account dir it cannot move, and tells logout to keep it too', async () => {
    const legacyTeam3 = join(happyHome, 'claude-accounts', 'team3');
    write(join(legacyTeam3, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"old"}}');
    write(join(accountsRoot, 'team3', 'keep.txt'), 'already here');
    const { updateAccountRegistry } = await import('./registry');
    await updateAccountRegistry(r => ({
      ...r,
      accounts: [...r.accounts, { id: 'team3', configDir: legacyTeam3, enabled: true, cooldownUntil: null, cooldownSetAt: null }],
    }));

    const { migrateLegacyAccountLayout } = await import('./migrate');
    const result = await migrateLegacyAccountLayout();
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toContain("account 'team3'");
    expect(result.keep).toEqual([join(happyHome, 'claude-accounts')]);
    expect(readFileSync(join(legacyTeam3, '.credentials.json'), 'utf8')).toContain('old');
    expect(readdirSync(join(accountsRoot, 'team3'))).toEqual(['keep.txt']);
  });
});

describe('reclaimProjects', () => {
  it('turns a link left dangling by a wiped happy home into an empty real dir', async () => {
    const { reclaimProjects } = await import('./migrate');
    const root = tmpDir();
    const legacy = join(root, 'happy', 'claude-shared', 'projects');
    mkdirSync(legacy, { recursive: true });
    symlinkSync(legacy, join(root, 'projects'), 'junction');
    rmSync(join(root, 'happy'), { recursive: true, force: true });
    expect(reclaimProjects(join(root, 'projects'), legacy)).toEqual({ moved: false, pending: null });
    expect(isLink(join(root, 'projects'))).toBe(false);
    expect(readdirSync(join(root, 'projects'))).toEqual([]);
  });

  it('never touches a link that points somewhere else', async () => {
    const { reclaimProjects } = await import('./migrate');
    const root = tmpDir();
    const elsewhere = join(root, 'elsewhere');
    const legacy = join(root, 'legacy');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, 'projects'), 'junction');
    expect(reclaimProjects(join(root, 'projects'), legacy)).toEqual({ moved: false, pending: null });
    write(join(legacy, 'C--p', 's.jsonl'), 'x');
    expect(reclaimProjects(join(root, 'projects'), legacy).pending).toContain('merge it by hand');
    expect(linkTarget(join(root, 'projects'))).toBe(resolve(elsewhere));
  });

  it('merges a partial adoption one level down and reports what collides', async () => {
    const { reclaimProjects } = await import('./migrate');
    const root = tmpDir();
    const projects = join(root, 'projects');
    const legacy = join(root, 'legacy');
    write(join(projects, 'C--a', 'one.jsonl'), 'default side');
    write(join(legacy, 'C--a', 'two.jsonl'), 'legacy side');
    write(join(legacy, 'C--b', 'three.jsonl'), 'legacy only');
    expect(reclaimProjects(projects, legacy)).toEqual({ moved: true, pending: null });
    expect(readdirSync(join(projects, 'C--a')).sort()).toEqual(['one.jsonl', 'two.jsonl']);
    expect(readFileSync(join(projects, 'C--b', 'three.jsonl'), 'utf8')).toBe('legacy only');
    expect(existsSync(legacy)).toBe(false);

    write(join(legacy, 'C--a', 'one.jsonl'), 'conflicting copy');
    const collision = reclaimProjects(projects, legacy);
    expect(collision.moved).toBe(false);
    expect(collision.pending).toContain('C--a');
    expect(readFileSync(join(projects, 'C--a', 'one.jsonl'), 'utf8')).toBe('default side');
    expect(readFileSync(join(legacy, 'C--a', 'one.jsonl'), 'utf8')).toBe('conflicting copy');
  });
});

describe('moveAccountDir', () => {
  it('moves the dir and leaves a working link at the old path', async () => {
    const { moveAccountDir } = await import('./migrate');
    const root = tmpDir();
    const oldDir = join(root, 'old', 'team2');
    const newDir = join(root, 'new', 'team2');
    write(join(oldDir, '.claude.json'), '{}');
    expect(moveAccountDir(oldDir, newDir)).toEqual({ configDir: newDir, moved: true });
    expect(isLink(newDir)).toBe(false);
    expect(linkTarget(oldDir)).toBe(resolve(newDir));
    expect(readFileSync(join(oldDir, '.claude.json'), 'utf8')).toBe('{}');
    // Re-run: the link says where it went
    expect(moveAccountDir(oldDir, newDir)).toEqual({ configDir: resolve(newDir), moved: false });
  });

  it('refuses to overwrite a dir already at the destination', async () => {
    const { moveAccountDir } = await import('./migrate');
    const root = tmpDir();
    const oldDir = join(root, 'old', 'team2');
    const newDir = join(root, 'new', 'team2');
    write(join(oldDir, 'a'), 'old');
    write(join(newDir, 'b'), 'new');
    const move = moveAccountDir(oldDir, newDir);
    expect('pending' in move && move.pending).toContain('already exists');
    expect(readdirSync(oldDir)).toEqual(['a']);
    expect(readdirSync(newDir)).toEqual(['b']);
  });

  it('points a vanished account at the new root for its next login', async () => {
    const { moveAccountDir } = await import('./migrate');
    const root = tmpDir();
    expect(moveAccountDir(join(root, 'old', 'team2'), join(root, 'new', 'team2'))).toEqual({ configDir: join(root, 'new', 'team2'), moved: false });
    expect(existsSync(join(root, 'new'))).toBe(false);
  });
});

describe('repointProjectsLink', () => {
  it('re-points a projects link still aimed at the legacy dir, and leaves others alone', async () => {
    const { repointProjectsLink } = await import('./migrate');
    const root = tmpDir();
    const legacy = join(root, 'legacy');
    mkdirSync(legacy);
    const account = join(root, 'team2');
    mkdirSync(account);
    symlinkSync(legacy, join(account, 'projects'), 'junction');
    repointProjectsLink(account, legacy);
    expect(linkTarget(join(account, 'projects'))).toBe(resolve(join(defaultLogin, 'projects')));

    const foreign = join(root, 'foreign');
    const foreignShared = join(root, 'foreign-shared');
    mkdirSync(foreign);
    mkdirSync(foreignShared);
    symlinkSync(foreignShared, join(foreign, 'projects'), 'junction');
    repointProjectsLink(foreign, legacy);
    expect(linkTarget(join(foreign, 'projects'))).toBe(resolve(foreignShared));
  });
});
