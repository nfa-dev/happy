import { describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isUserConfigSyncTarget, syncMcpServers, syncUserConfig, syncUserConfigToAccountDir } from './dirs';
import { accountsRootDir, defaultClaudeConfigDir } from './registry';

function tmpJson(name: string, value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'happy-mcp-sync-'));
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const SOURCE = {
  mcpServers: { 'oss-mcp': { type: 'stdio', command: 'oss' }, 'wiki-mcp': { type: 'http', url: 'http://x' } },
  projects: {
    'C:/work/alpha': { mcpServers: { local: { type: 'stdio', command: 'l' } }, hasTrustDialogAccepted: true, history: ['not-mcp'] },
    'C:/work/beta': { hasTrustDialogAccepted: true }, // no MCP config — must not be copied
  },
  oauthAccount: { email: 'default@x' },
};

describe('syncMcpServers', () => {
  it('copies user-scope and project-local MCP config, preserving target identity', () => {
    const source = tmpJson('source.json', SOURCE);
    const target = tmpJson('target.json', {
      hasCompletedOnboarding: true,
      oauthAccount: { email: 'team2@x' },
      projects: { 'C:/work/alpha': { history: ['own-history'] } },
    });
    expect(syncMcpServers(source, target)).toBe(true);
    const result = JSON.parse(readFileSync(target, 'utf8'));
    expect(Object.keys(result.mcpServers)).toEqual(['oss-mcp', 'wiki-mcp']);
    expect(result.projects['C:/work/alpha'].mcpServers.local.command).toBe('l');
    expect(result.projects['C:/work/alpha'].history).toEqual(['own-history']); // untouched
    expect(result.projects['C:/work/beta']).toBeUndefined(); // no MCP config → not copied
    expect(result.oauthAccount.email).toBe('team2@x'); // identity never synced
    expect(result.hasCompletedOnboarding).toBe(true);
  });

  it('is idempotent — a second sync reports no change', () => {
    const source = tmpJson('source.json', SOURCE);
    const target = tmpJson('target.json', {});
    expect(syncMcpServers(source, target)).toBe(true);
    expect(syncMcpServers(source, target)).toBe(false);
  });

  it('replaces stale account-local servers with the default set', () => {
    const source = tmpJson('source.json', { mcpServers: { fresh: { type: 'stdio', command: 'f' } } });
    const target = tmpJson('target.json', { mcpServers: { stale: { type: 'stdio', command: 's' } } });
    expect(syncMcpServers(source, target)).toBe(true);
    expect(Object.keys(JSON.parse(readFileSync(target, 'utf8')).mcpServers)).toEqual(['fresh']);
  });

  it('does nothing without a readable source and never clobbers a corrupt target', () => {
    const target = tmpJson('target.json', { mcpServers: {} });
    expect(syncMcpServers(join(tmpdir(), 'does-not-exist.json'), target)).toBe(false);
    const source = tmpJson('source.json', SOURCE);
    const corrupt = tmpJson('target.json', {});
    writeFileSync(corrupt, '{ not json');
    expect(syncMcpServers(source, corrupt)).toBe(false);
    expect(readFileSync(corrupt, 'utf8')).toBe('{ not json');
  });
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'happy-user-config-'));
}

/** Where a link points, normalized the same way as the expected path */
function linkTarget(path: string): string {
  return resolve(readlinkSync(path));
}

function seedDefaultLogin(source: string): void {
  mkdirSync(join(source, 'rules'));
  writeFileSync(join(source, 'rules', 'style.md'), '# style');
  mkdirSync(join(source, 'skills', 'demo'), { recursive: true });
  writeFileSync(join(source, 'settings.json'), '{"hooks":{}}');
  writeFileSync(join(source, 'CLAUDE.md'), '# memo');
}

describe('syncUserConfig', () => {
  it('links rules/ and skills/ to the default login and copies settings.json + CLAUDE.md (T1)', () => {
    const source = tmpDir();
    const target = tmpDir();
    seedDefaultLogin(source);
    expect(syncUserConfig(source, target)).toEqual({ settings: 'written', claudeMd: 'written', rules: 'linked', skills: 'linked' });
    for (const name of ['rules', 'skills']) {
      expect(lstatSync(join(target, name)).isSymbolicLink()).toBe(true);
      expect(linkTarget(join(target, name))).toBe(resolve(join(source, name)));
    }
    expect(readFileSync(join(target, 'rules', 'style.md'), 'utf8')).toBe('# style'); // readable through the link
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{"hooks":{}}');
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf8')).toBe('# memo');
    expect(readdirSync(target).some(entry => entry.includes('.tmp-'))).toBe(false); // no temp files left behind
  });

  it('points at the default login path itself even when that side is a link (T1, claude-sync layout)', () => {
    const source = tmpDir();
    const target = tmpDir();
    const real = tmpDir();
    symlinkSync(real, join(source, 'rules'), 'junction');
    expect(syncUserConfig(source, target).rules).toBe('linked');
    expect(linkTarget(join(target, 'rules'))).toBe(resolve(join(source, 'rules')));
  });

  it('creates nothing while the default login lacks the directory, links once it appears (T2)', () => {
    const source = tmpDir();
    const target = tmpDir();
    expect(syncUserConfig(source, target).rules).toBe('absent');
    expect(existsSync(join(target, 'rules'))).toBe(false);
    mkdirSync(join(source, 'rules'));
    expect(syncUserConfig(source, target).rules).toBe('linked');
  });

  it('keeps a real directory with content, replaces an empty one (T3)', () => {
    const source = tmpDir();
    const target = tmpDir();
    mkdirSync(join(source, 'skills'));
    mkdirSync(join(source, 'rules'));
    mkdirSync(join(target, 'skills'));
    writeFileSync(join(target, 'skills', 'own.md'), 'mine');
    mkdirSync(join(target, 'rules')); // empty
    const result = syncUserConfig(source, target);
    expect(result.skills).toBe('skipped');
    expect(lstatSync(join(target, 'skills')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(target, 'skills', 'own.md'), 'utf8')).toBe('mine');
    expect(result.rules).toBe('linked');
    expect(linkTarget(join(target, 'rules'))).toBe(resolve(join(source, 'rules')));
  });

  it('keeps a live link wherever it points, re-links a dangling one (T3b)', () => {
    const source = tmpDir();
    const target = tmpDir();
    const elsewhere = tmpDir();
    mkdirSync(join(source, 'rules'));
    mkdirSync(join(source, 'skills'));
    symlinkSync(elsewhere, join(target, 'rules'), 'junction');
    const gone = join(tmpDir(), 'gone');
    mkdirSync(gone);
    symlinkSync(gone, join(target, 'skills'), 'junction');
    rmdirSync(gone); // skills now dangles
    const first = syncUserConfig(source, target);
    expect(first.rules).toBe('kept');
    expect(linkTarget(join(target, 'rules'))).toBe(resolve(elsewhere));
    expect(first.skills).toBe('linked');
    expect(linkTarget(join(target, 'skills'))).toBe(resolve(join(source, 'skills')));
    expect(syncUserConfig(source, target)).toMatchObject({ rules: 'kept', skills: 'kept' });
  });

  it('rewrites settings.json only when the bytes differ (T4)', async () => {
    const source = tmpDir();
    const target = tmpDir();
    writeFileSync(join(source, 'settings.json'), '{"a":1}');
    expect(syncUserConfig(source, target).settings).toBe('written');
    const written = statSync(join(target, 'settings.json')).mtimeMs;
    await new Promise(wake => setTimeout(wake, 25));
    expect(syncUserConfig(source, target).settings).toBe('unchanged');
    expect(statSync(join(target, 'settings.json')).mtimeMs).toBe(written);
    writeFileSync(join(source, 'settings.json'), '{"a":2}');
    expect(syncUserConfig(source, target).settings).toBe('written');
    expect(readFileSync(join(target, 'settings.json'), 'utf8')).toBe('{"a":2}');
  });

  it('copies CLAUDE.md the same way and leaves the account copy when the default has none (T5)', () => {
    const source = tmpDir();
    const target = tmpDir();
    writeFileSync(join(target, 'CLAUDE.md'), '# account-local');
    expect(syncUserConfig(source, target).claudeMd).toBe('absent');
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf8')).toBe('# account-local');
    writeFileSync(join(source, 'CLAUDE.md'), '# default');
    expect(syncUserConfig(source, target).claudeMd).toBe('written');
    expect(readFileSync(join(target, 'CLAUDE.md'), 'utf8')).toBe('# default');
    expect(syncUserConfig(source, target).claudeMd).toBe('unchanged');
  });
});

describe('syncUserConfigToAccountDir', () => {
  it('never targets the default login dir or a dir happy did not create (T6)', () => {
    expect(syncUserConfigToAccountDir(defaultClaudeConfigDir())).toBeNull();
    const foreign = tmpDir();
    expect(syncUserConfigToAccountDir(foreign)).toBeNull();
    expect(readdirSync(foreign)).toEqual([]);
  });

  it('accepts only happy-managed account dirs other than the default login', () => {
    const managed = join(accountsRootDir(), 'team2');
    const defaultDir = join(homedir(), '.claude');
    expect(isUserConfigSyncTarget(managed, defaultDir)).toBe(true);
    expect(isUserConfigSyncTarget(managed, managed)).toBe(false);
    expect(isUserConfigSyncTarget(managed + (process.platform === 'win32' ? '\\' : '/'), managed)).toBe(false); // trailing separator
    expect(isUserConfigSyncTarget(defaultDir, defaultDir)).toBe(false);
    expect(isUserConfigSyncTarget(tmpDir(), defaultDir)).toBe(false);
  });
});
