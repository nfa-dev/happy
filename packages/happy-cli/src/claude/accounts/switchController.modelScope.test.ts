/**
 * Model-scoped switching (the Fable limit) through the whole controller.
 *
 * Hermetic on purpose (unit runs do not isolate the home): the registry and
 * usage cache live in a temp accounts root, account dir syncs are stubbed,
 * the fake logins hold no token, every account — the disabled machine
 * default included — has fresh cached usage so no poll comes due, and fetch
 * is stubbed to fail in case one does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./dirs', () => ({
  syncMcpServersToAccountDir: vi.fn(),
  syncUserConfigToAccountDir: vi.fn(),
}));

import { createAccountSwitchController } from './switchController';
import { MODEL_SCOPED_WINDOW_ID } from '@/claude/utils/usageLimits';

const FABLE = 'claude-fable-5-1';
const ENV_KEYS = ['HAPPY_CLAUDE_ACCOUNTS_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

let root: string;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function writeFixture(fable: { a: number; b: number }, settings: { strategy?: string; switchThreshold?: number } = {}): void {
  const now = Date.now();
  const accounts = ['a', 'b'].map(id => {
    const configDir = join(root, id);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, '.credentials.json'), '{}'); // a login exists, but no token to poll with
    return { id, configDir, enabled: true, cooldownUntil: null, cooldownSetAt: null };
  });
  writeFileSync(join(root, 'accounts.json'), JSON.stringify({
    enabled: true,
    strategy: settings.strategy ?? 'auto',
    switchThreshold: settings.switchThreshold ?? 0.85,
    activeAccountId: 'a',
    lastUsedIndex: 0,
    guard: { noReturnWithinSec: 300, maxSwitchesPer24h: 0 },
    // The machine default's config dir is the real ~/.claude: keep it out
    accounts: [{ id: 'default', configDir: null, enabled: false, cooldownUntil: null, cooldownSetAt: null }, ...accounts],
  }));
  const usage = (fableUtilization: number) => ({
    fiveHour: { utilization: 10, resetsAt: now + 3600_000 },
    sevenDay: { utilization: 40, resetsAt: now + 86400_000 },
    modelScoped: { fable: { label: 'Fable', utilization: fableUtilization, resetsAt: now + 86400_000 } },
    fetchedAt: now,
  });
  writeFileSync(join(root, 'usage-cache.json'), JSON.stringify({
    accounts: { default: usage(0), a: usage(fable.a), b: usage(fable.b) },
    backoff: {},
    switches: [],
  }));
}

function registryAccount(id: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')).accounts.find((a: { id: string }) => a.id === id);
}

function activeAccountId(): string | null {
  return JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')).activeAccountId;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'happy-model-scope-'));
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env.HAPPY_CLAUDE_ACCOUNTS_DIR = root;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  vi.stubGlobal('fetch', vi.fn(async () => {
    throw new Error('network is off in this test');
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  rmSync(root, { recursive: true, force: true });
});

describe('model-scoped switching (Fable)', () => {
  it('moves a Fable session off an account whose Fable window is spent', async () => {
    writeFixture({ a: 100, b: 40 });
    const notify = vi.fn();
    const controller = createAccountSwitchController({ notify });
    controller.noteModel(FABLE);
    expect(await controller.maybeSwitchAtTurnBoundary()).toBe(true);
    expect(notify).toHaveBeenCalledWith('Account switch: a → b (Fable limit reached)');
    expect(activeAccountId()).toBe('b');
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(join(root, 'b'));
  });

  it('leaves an Opus session on the same account alone', async () => {
    writeFixture({ a: 100, b: 40 });
    const notify = vi.fn();
    const controller = createAccountSwitchController({ notify });
    controller.noteModel('claude-opus-5-5');
    expect(await controller.maybeSwitchAtTurnBoundary()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(activeAccountId()).toBe('a');
  });

  it('with Fable spent on every account, tells the session once and does not park', async () => {
    writeFixture({ a: 100, b: 100 });
    const notify = vi.fn();
    const controller = createAccountSwitchController({ notify });
    controller.noteModel(FABLE);
    expect(await controller.maybeSwitchAtTurnBoundary()).toBe(false);
    expect(await controller.maybeSwitchAtTurnBoundary()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/^Fable limit reached on every Claude account \(earliest reset .+\)\. Switch to another model to continue\.$/);
    const started = Date.now();
    await controller.waitIfParked(new AbortController().signal);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(activeAccountId()).toBe('a');
  });

  it('still moves a Fable session on an account-level rejection, to any healthy account when none has Fable room', async () => {
    writeFixture({ a: 50, b: 100 });
    const notify = vi.fn();
    const controller = createAccountSwitchController({ notify });
    controller.noteModel(FABLE);
    controller.noteUsageLimits({
      capturedAt: Date.now(),
      windows: [{ id: 'five_hour', status: 'rejected', utilization: 100, resetsAt: Date.now() + 3600_000 }],
    });
    expect(await controller.maybeSwitchAtTurnBoundary()).toBe(true);
    expect(notify).toHaveBeenCalledWith('Account switch: a → b (rate limit reached)');
    expect(registryAccount('a').cooldownUntil).not.toBeNull();
  });

  it('balances a Fable session on the live Fable window, not on 5h/7d', async () => {
    writeFixture({ a: 50, b: 30 }, { strategy: 'balance', switchThreshold: 0.1 });
    const notify = vi.fn();
    const controller = createAccountSwitchController({ notify });
    controller.noteModel(FABLE);
    // a looks idle on 5h/7d (1%/2% vs b's 10%/40%) but its Fable window is at 80%
    controller.noteUsageLimits({
      capturedAt: Date.now(),
      windows: [
        { id: 'five_hour', status: 'allowed', utilization: 1, resetsAt: null },
        { id: 'seven_day', utilization: 2, resetsAt: null },
        { id: MODEL_SCOPED_WINDOW_ID, utilization: 80, resetsAt: null },
      ],
    });
    expect(await controller.maybeSwitchAtTurnBoundary()).toBe(true);
    expect(notify).toHaveBeenCalledWith('Account switch: a → b (Fable usage balancing)');
  });

  it('records a mid-turn Fable rejection as a Fable cooldown, not an account cooldown, and switches', async () => {
    writeFixture({ a: 70, b: 40 });
    const controller = createAccountSwitchController({ notify: vi.fn() });
    controller.noteModel(FABLE);
    const resetsAt = Date.now() + 86400_000;
    expect(await controller.handleMidTurnRejection({ windowId: MODEL_SCOPED_WINDOW_ID, resetsAt })).toBe(true);
    expect(registryAccount('a').cooldownUntil).toBeNull();
    expect(registryAccount('a').modelCooldowns.fable.until).toBe(resetsAt);
    expect(activeAccountId()).toBe('b');
  });

  it('ignores a Fable rejection in a session that does not run Fable', async () => {
    writeFixture({ a: 70, b: 40 });
    const controller = createAccountSwitchController({ notify: vi.fn() });
    controller.noteModel('claude-opus-5-5');
    expect(await controller.handleMidTurnRejection({ windowId: MODEL_SCOPED_WINDOW_ID, resetsAt: null })).toBe(false);
    expect(registryAccount('a').modelCooldowns).toBeUndefined();
    expect(activeAccountId()).toBe('a');
  });

  it('reports when the session moves onto or off a model-scoped window', () => {
    const controller = createAccountSwitchController({ notify: vi.fn() });
    expect(controller.noteModel(FABLE)).toBe(true);
    expect(controller.noteModel('claude-fable-5-1')).toBe(false);
    expect(controller.noteModel('<synthetic>')).toBe(false);
    expect(controller.noteModel('claude-opus-5-5')).toBe(true);
    expect(controller.noteModel(undefined)).toBe(false);
  });
});
