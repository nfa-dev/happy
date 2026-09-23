import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// configuration.ts resolves the happy home and the server URLs at module load:
// point the home into a sandbox before the modules under test are imported
// (dynamically, inside the tests), seeded with a settings.json saved the way
// Windows PowerShell 5.1 writes UTF-8 — with a BOM.
const happyHome = mkdtempSync(join(tmpdir(), 'happy-auth-server-'));
const settingsFile = join(happyHome, 'settings.json');
const savedEnv = Object.fromEntries(['HAPPY_HOME_DIR', 'HAPPY_SERVER_URL', 'HAPPY_WEBAPP_URL'].map(key => [key, process.env[key]]));
process.env.HAPPY_HOME_DIR = happyHome;
delete process.env.HAPPY_SERVER_URL;
delete process.env.HAPPY_WEBAPP_URL;
writeFileSync(settingsFile, '\uFEFF' + JSON.stringify({
  schemaVersion: 3,
  onboardingCompleted: true,
  machineId: 'machine-1',
  serverUrl: 'https://relay.example.com',
}));

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function readSettingsFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsFile, 'utf8'));
}

describe('settings.json saved with a UTF-8 BOM', () => {
  it('is still read, by configuration.ts and by readSettings', async () => {
    const { configuration } = await import('../configuration');
    expect(configuration.serverUrl).toBe('https://relay.example.com');
    const { readSettings } = await import('../persistence');
    const settings = await readSettings();
    expect(settings.machineId).toBe('machine-1');
    expect(settings.serverUrl).toBe('https://relay.example.com');
  });
});

describe('normalizeServiceUrl', () => {
  it('drops what would double up when the CLI appends paths', async () => {
    const { normalizeServiceUrl } = await import('./authServer');
    expect(normalizeServiceUrl('https://relay.example.com/')).toBe('https://relay.example.com');
    expect(normalizeServiceUrl('  https://nfa-dev.github.io/happy//  ')).toBe('https://nfa-dev.github.io/happy');
    expect(normalizeServiceUrl('HTTPS://Example.COM:443/Path')).toBe('https://example.com/Path');
    expect(normalizeServiceUrl('http://127.0.0.1:3005')).toBe('http://127.0.0.1:3005');
  });

  it('rejects what the CLI cannot append paths to', async () => {
    const { normalizeServiceUrl } = await import('./authServer');
    for (const input of ['', 'relay.example.com', 'localhost:3005', 'ftp://example.com', 'https://example.com/?a=1', 'https://example.com/#top', 'https://user:pw@example.com']) {
      expect(normalizeServiceUrl(input)).toBeNull();
    }
  });
});

describe('withServiceUrls', () => {
  it('stores custom URLs and leaves every other setting alone', async () => {
    const { withServiceUrls } = await import('./authServer');
    const base = { schemaVersion: 3, onboardingCompleted: true, machineId: 'm' };
    expect(withServiceUrls(base, { serverUrl: 'https://relay.example.com', webappUrl: 'https://web.example.com/app' }))
      .toEqual({ ...base, serverUrl: 'https://relay.example.com', webappUrl: 'https://web.example.com/app' });
  });

  it('removes a URL that is reset or equal to the built-in default', async () => {
    const { withServiceUrls } = await import('./authServer');
    const { DEFAULT_WEBAPP_URL } = await import('../configuration');
    const base = { schemaVersion: 3, onboardingCompleted: true };
    const custom = { ...base, serverUrl: 'https://relay.example.com', webappUrl: 'https://web.example.com' };
    expect(withServiceUrls(custom, { serverUrl: null, webappUrl: DEFAULT_WEBAPP_URL })).toEqual(base);
  });
});

describe('effectiveServiceUrls', () => {
  it('follows the precedence of configuration.ts: env, then settings.json, then the default', async () => {
    const { effectiveServiceUrls } = await import('./authServer');
    const { DEFAULT_SERVER_URL, DEFAULT_WEBAPP_URL } = await import('../configuration');
    const base = { schemaVersion: 3, onboardingCompleted: true };
    expect(effectiveServiceUrls(base)).toEqual({
      serverUrl: { value: DEFAULT_SERVER_URL, source: 'default' },
      webappUrl: { value: DEFAULT_WEBAPP_URL, source: 'default' },
    });
    const stored = { ...base, serverUrl: 'https://relay.example.com' };
    expect(effectiveServiceUrls(stored).serverUrl).toEqual({ value: 'https://relay.example.com', source: 'settings' });
    try {
      process.env.HAPPY_SERVER_URL = 'https://from-env.example.com';
      expect(effectiveServiceUrls(stored).serverUrl).toEqual({ value: 'https://from-env.example.com', source: 'env' });
    } finally {
      delete process.env.HAPPY_SERVER_URL;
    }
  });
});

describe('happy auth server with flags', () => {
  it('saves normalized URLs without prompting and keeps the rest of settings.json', async () => {
    const { handleAuthServer } = await import('./authServer');
    await handleAuthServer(['--server-url', 'https://relay.example.com/', '--webapp-url', 'https://web.example.com/app/']);
    expect(readSettingsFile()).toMatchObject({
      machineId: 'machine-1',
      serverUrl: 'https://relay.example.com',
      webappUrl: 'https://web.example.com/app',
    });

    await handleAuthServer(['--webapp-url', 'https://web2.example.com']);
    expect(readSettingsFile()).toMatchObject({ serverUrl: 'https://relay.example.com', webappUrl: 'https://web2.example.com' });

    await handleAuthServer(['--reset']);
    const reset = readSettingsFile();
    expect(reset.serverUrl).toBeUndefined();
    expect(reset.webappUrl).toBeUndefined();
    expect(reset.machineId).toBe('machine-1');
  });
});
