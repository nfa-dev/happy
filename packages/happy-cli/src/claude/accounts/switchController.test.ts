import { describe, expect, it } from 'vitest';
import { accountUtilization, cooldownLooksSpurious, dynamicScore, modelCooldownActive, selectNextAccount, worthBalancing, type SelectionInput } from './switchController';
import type { ClaudeAccount, ClaudeAccountSwitchSettings } from './types';
import type { CachedAccountUsage, SwitchEvent } from './usageCache';

const NOW = 1_700_000_000_000;

function account(id: string, overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return { id, configDir: id === 'default' ? null : `~/.happy/claude-accounts/${id}`, enabled: true, cooldownUntil: null, cooldownSetAt: null, ...overrides };
}

function registry(accounts: ClaudeAccount[], overrides: Partial<ClaudeAccountSwitchSettings> = {}): ClaudeAccountSwitchSettings {
  return {
    enabled: true,
    strategy: 'auto',
    switchThreshold: 0.85,
    accounts,
    activeAccountId: null,
    lastUsedIndex: 0,
    guard: { noReturnWithinSec: 300, maxSwitchesPer24h: 12 },
    ...overrides,
  };
}

function usage(fiveHour: number, sevenDay: number, fetchedAt = NOW): CachedAccountUsage {
  return {
    fiveHour: { utilization: fiveHour, resetsAt: NOW + 3600_000 },
    sevenDay: { utilization: sevenDay, resetsAt: NOW + 86400_000 },
    fetchedAt,
  };
}

/** Account usage with a Fable weekly window */
function fableUsage(fable: number, fetchedAt = NOW, fiveHour = 10, sevenDay = 10): CachedAccountUsage {
  return {
    ...usage(fiveHour, sevenDay, fetchedAt),
    modelScoped: { fable: { label: 'Fable', utilization: fable, resetsAt: NOW + 86400_000 } },
  };
}

function input(overrides: Partial<SelectionInput>): SelectionInput {
  return {
    registry: registry([account('default'), account('team2'), account('team3')]),
    currentAccountId: 'default',
    usage: {},
    switches: [],
    now: NOW,
    excludeAboveThreshold: false,
    credentialCheck: () => true,
    ...overrides,
  };
}

describe('dynamicScore', () => {
  it('weights weekly 2x over five-hour', () => {
    expect(dynamicScore(usage(50, 10), NOW)).toBe(10 * 2 + 50);
    expect(dynamicScore(usage(10, 50), NOW)).toBe(50 * 2 + 10);
  });

  it('treats missing or stale data as neutral 65', () => {
    expect(dynamicScore(undefined, NOW)).toBe(65 * 2 + 65);
    expect(dynamicScore(usage(0, 0, NOW - 2 * 3600_000), NOW)).toBe(65 * 2 + 65);
  });
});

describe('selectNextAccount', () => {
  it('round-robins from lastUsedIndex+1 when usage data is cold', () => {
    const selection = selectNextAccount(input({ currentAccountId: 'default' }));
    expect(selection?.account.id).toBe('team2');
    expect(selection?.index).toBe(1);
  });

  it('round-robin wraps around and skips the current account', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2'), account('team3')], { lastUsedIndex: 2 }),
      currentAccountId: 'default',
    }));
    expect(selection?.account.id).toBe('team2');
  });

  it('uses dynamic scoring once fresh usage covers half the candidates', () => {
    const selection = selectNextAccount(input({
      usage: { team2: usage(80, 70), team3: usage(20, 10) },
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('excludes disabled, cooled-down and credential-less accounts', () => {
    const selection = selectNextAccount(input({
      registry: registry([
        account('default'),
        account('team2', { enabled: false }),
        account('team3', { cooldownUntil: NOW + 60_000 }),
        account('team4'),
      ]),
      credentialCheck: (a) => a.id !== 'team5',
    }));
    expect(selection?.account.id).toBe('team4');
  });

  it('expired cooldowns are usable again', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2', { cooldownUntil: NOW - 1 })]),
    }));
    expect(selection?.account.id).toBe('team2');
  });

  it('blocks ping-pong return to the account we just switched away from', () => {
    const switches: SwitchEvent[] = [{ at: NOW - 60_000, from: 'team2', to: 'default' }];
    const selection = selectNextAccount(input({ switches }));
    expect(selection?.account.id).toBe('team3');
  });

  it('allows returning after the no-return window has passed', () => {
    const switches: SwitchEvent[] = [{ at: NOW - 301_000, from: 'team2', to: 'default' }];
    const selection = selectNextAccount(input({ switches }));
    expect(selection?.account.id).toBe('team2');
  });

  it('proactive switches skip candidates already past the threshold', () => {
    const selection = selectNextAccount(input({
      usage: { team2: usage(90, 10), team3: usage(30, 20) },
      excludeAboveThreshold: true,
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('reactive switches may still use above-threshold candidates', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2')]),
      usage: { team2: usage(90, 10) },
      excludeAboveThreshold: false,
    }));
    expect(selection?.account.id).toBe('team2');
  });

  it('returns null when nothing is usable', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2', { cooldownUntil: NOW + 60_000 })]),
    }));
    expect(selection).toBeNull();
  });
});

describe('accountUtilization', () => {
  it('is the most constrained window — max of 5h and 7d', () => {
    expect(accountUtilization(usage(45, 18), NOW)).toBe(45);
    expect(accountUtilization(usage(27, 33), NOW)).toBe(33);
  });

  it('is null for missing, stale, or windowless data', () => {
    expect(accountUtilization(undefined, NOW)).toBeNull();
    expect(accountUtilization(usage(45, 18, NOW - 2 * 3600_000), NOW)).toBeNull();
    expect(accountUtilization({ fetchedAt: NOW }, NOW)).toBeNull();
  });
});

describe('worthBalancing', () => {
  const GAP = 15; // threshold 0.15 in balance mode

  it('rebalances when the utilization gap reaches the threshold', () => {
    // current max 40 vs candidate max 20 → gap 20 ≥ 15
    expect(worthBalancing(40, usage(20, 15), NOW, GAP)).toBe(true);
  });

  it('stays put when the gap is below the threshold', () => {
    // current max 45 vs candidate max 33 → gap 12 < 15
    expect(worthBalancing(45, usage(27, 33), NOW, GAP)).toBe(false);
  });

  it('never rebalances onto missing or stale candidate data', () => {
    expect(worthBalancing(90, undefined, NOW, GAP)).toBe(false);
    expect(worthBalancing(90, usage(0, 0, NOW - 2 * 3600_000), NOW, GAP)).toBe(false);
  });
});

describe('selectNextAccount with balance strategy', () => {
  it('picks the lowest-scoring candidate (dynamic selection) without a balance input', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2'), account('team3')], { strategy: 'balance' }),
      usage: { team2: usage(80, 70), team3: usage(20, 10) },
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('rebalance picks the least-utilized candidate that passes the gap', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2'), account('team3')], { strategy: 'balance' }),
      usage: { team2: usage(30, 45), team3: usage(20, 25) },
      balance: { currentUtilization: 60, gapPct: 10 },
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('rebalance skips a dynamic-score winner that fails the gap in favor of one that passes', () => {
    // team2: weekly-light so dynamicScore favors it (5+2*5=15) but max util 55 → gap 5 < 10
    // team3: dynamicScore 40+2*40=120, max util 40 → gap 20 ≥ 10
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2'), account('team3')], { strategy: 'balance' }),
      usage: { team2: usage(55, 5), team3: usage(40, 40) },
      balance: { currentUtilization: 60, gapPct: 10 },
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('rebalance never lands on missing or stale candidate data', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2'), account('team3')], { strategy: 'balance' }),
      usage: { team2: usage(0, 0, NOW - 2 * 3600_000) }, // team2 stale, team3 unknown
      balance: { currentUtilization: 90, gapPct: 10 },
    }));
    expect(selection).toBeNull();
  });

  it('rebalance returns null when no candidate clears the gap', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2')], { strategy: 'balance' }),
      usage: { team2: usage(55, 30) },
      balance: { currentUtilization: 60, gapPct: 10 },
    }));
    expect(selection).toBeNull();
  });
});

describe('model-scoped mode (Fable)', () => {
  it('measures an account by its Fable window alone', () => {
    expect(accountUtilization(fableUsage(70, NOW, 90, 95), NOW, 'fable')).toBe(70);
    expect(accountUtilization(usage(90, 95), NOW, 'fable')).toBeNull();
    expect(dynamicScore(fableUsage(70, NOW, 90, 95), NOW, 'fable')).toBe(70);
    expect(dynamicScore(usage(90, 95), NOW, 'fable')).toBe(65);
  });

  it('ranks candidates by their Fable window, not 5h/7d', () => {
    const selection = selectNextAccount(input({
      usage: { team2: fableUsage(80, NOW, 5, 5), team3: fableUsage(20, NOW, 90, 90) },
      modelScope: 'fable',
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('never lands on a candidate whose Fable window is spent', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2'), account('team3')], { strategy: 'dynamic' }),
      usage: { team2: fableUsage(100), team3: fableUsage(99) },
      modelScope: 'fable',
    }));
    expect(selection?.account.id).toBe('team3');
    const none = selectNextAccount(input({
      registry: registry([account('default'), account('team2')]),
      usage: { team2: fableUsage(100) },
      modelScope: 'fable',
    }));
    expect(none).toBeNull();
  });

  it('proactive switches skip candidates past the threshold on Fable, whatever their 5h', () => {
    const selection = selectNextAccount(input({
      usage: { team2: fableUsage(90, NOW, 5, 5), team3: fableUsage(30, NOW, 95, 20) },
      excludeAboveThreshold: true,
      modelScope: 'fable',
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('skips candidates with an active Fable cooldown', () => {
    const selection = selectNextAccount(input({
      registry: registry([
        account('default'),
        account('team2', { modelCooldowns: { fable: { until: NOW + 60_000, setAt: NOW - 60_000 } } }),
        account('team3'),
      ]),
      usage: { team2: fableUsage(10, NOW - 120_000), team3: fableUsage(50) },
      modelScope: 'fable',
    }));
    expect(selection?.account.id).toBe('team3');
  });

  it('balance rebalances on the Fable gap even when 5h/7d point the other way', () => {
    const selection = selectNextAccount(input({
      registry: registry([account('default'), account('team2')], { strategy: 'balance' }),
      usage: { team2: fableUsage(20, NOW, 80, 80) },
      balance: { currentUtilization: 75, gapPct: 10 },
      modelScope: 'fable',
    }));
    expect(selection?.account.id).toBe('team2');
    expect(worthBalancing(75, fableUsage(20, NOW, 80, 80), NOW, 10)).toBe(false); // account-level view
  });
});

describe('modelCooldownActive', () => {
  const cooled = account('team2', { modelCooldowns: { fable: { until: NOW + 3600_000, setAt: NOW - 60_000 } } });

  it('holds until its reset while no newer usage data contradicts it', () => {
    expect(modelCooldownActive(cooled, 'fable', undefined, NOW)).toBe(true);
    expect(modelCooldownActive(cooled, 'fable', fableUsage(10, NOW - 120_000), NOW)).toBe(true); // fetched before it
    expect(modelCooldownActive(cooled, 'fable', fableUsage(100), NOW)).toBe(true); // confirmed spent
  });

  it('lapses on newer usage data that shows room, and once expired', () => {
    expect(modelCooldownActive(cooled, 'fable', fableUsage(40), NOW)).toBe(false);
    expect(modelCooldownActive(cooled, 'fable', fableUsage(100), NOW + 3600_001)).toBe(false);
  });

  it('only concerns its own model', () => {
    expect(modelCooldownActive(cooled, 'mythos', fableUsage(100), NOW)).toBe(false);
  });
});

describe('cooldownLooksSpurious', () => {
  const THRESHOLD = 85;
  const cooled = (overrides: Partial<ClaudeAccount> = {}) =>
    account('default', { cooldownUntil: NOW + 3600_000, cooldownSetAt: NOW - 60_000, ...overrides });

  it('heals a cooldown contradicted by fresh post-cooldown usage under the threshold', () => {
    expect(cooldownLooksSpurious(cooled(), usage(32, 13), NOW, THRESHOLD)).toBe(true);
  });

  it('keeps a cooldown when usage confirms exhaustion', () => {
    expect(cooldownLooksSpurious(cooled(), usage(100, 30), NOW, THRESHOLD)).toBe(false);
  });

  it('keeps a cooldown when usage is at or above the threshold', () => {
    expect(cooldownLooksSpurious(cooled(), usage(85, 30), NOW, THRESHOLD)).toBe(false);
  });

  it('keeps a cooldown when the weekly window is exhausted', () => {
    expect(cooldownLooksSpurious(cooled(), usage(32, 100), NOW, THRESHOLD)).toBe(false);
  });

  it('requires usage fetched after the cooldown was recorded', () => {
    const preCooldownFetch = usage(32, 13, NOW - 120_000); // older than cooldownSetAt
    expect(cooldownLooksSpurious(cooled(), preCooldownFetch, NOW, THRESHOLD)).toBe(false);
  });

  it('legacy cooldowns without cooldownSetAt heal on any fresh data', () => {
    expect(cooldownLooksSpurious(cooled({ cooldownSetAt: null }), usage(32, 13, NOW - 120_000), NOW, THRESHOLD)).toBe(true);
  });

  it('ignores missing, stale, or windowless usage data', () => {
    expect(cooldownLooksSpurious(cooled(), undefined, NOW, THRESHOLD)).toBe(false);
    expect(cooldownLooksSpurious(cooled({ cooldownSetAt: NOW - 3 * 3600_000 }), usage(32, 13, NOW - 2 * 3600_000), NOW, THRESHOLD)).toBe(false);
    expect(cooldownLooksSpurious(cooled(), { fetchedAt: NOW }, NOW, THRESHOLD)).toBe(false);
  });

  it('never heals an inactive or expired cooldown', () => {
    expect(cooldownLooksSpurious(account('default'), usage(32, 13), NOW, THRESHOLD)).toBe(false);
    expect(cooldownLooksSpurious(cooled({ cooldownUntil: NOW - 1 }), usage(32, 13), NOW, THRESHOLD)).toBe(false);
  });
});

describe('isHappyManagedConfigDir', () => {
  it('detects dirs under the accounts root regardless of separators/case', async () => {
    const { isHappyManagedConfigDir, accountConfigDirFor, accountsRootDir } = await import('./registry');
    expect(isHappyManagedConfigDir(accountConfigDirFor('team2'))).toBe(true);
    expect(isHappyManagedConfigDir(accountsRootDir())).toBe(true);
    expect(isHappyManagedConfigDir(accountConfigDirFor('team2').toUpperCase())).toBe(process.platform === 'win32');
    expect(isHappyManagedConfigDir('~/.claude')).toBe(false);
    expect(isHappyManagedConfigDir('C:\some\custom\claude-config')).toBe(false);
  });
});
