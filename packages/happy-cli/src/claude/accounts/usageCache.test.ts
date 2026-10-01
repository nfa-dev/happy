import { describe, expect, it } from 'vitest';
import {
  backoffActive,
  backoffWaitSec,
  modelScopeFor,
  modelScopeKey,
  modelScopeLabel,
  parseUsageResponseBody,
  usageFetchDue,
  type UsageCacheFile,
} from './usageCache';

// Real 200 response shape, captured from the usage endpoint
const REAL_200 = `{
  "five_hour":{"utilization":54.0,"resets_at":"2026-06-08T01:50:00.258614+00:00"},
  "seven_day":{"utilization":61.0,"resets_at":"2026-06-09T13:00:01.258635+00:00"},
  "seven_day_opus":null,
  "seven_day_sonnet":{"utilization":7.0,"resets_at":"2026-06-09T13:00:00.258642+00:00"},
  "extra_usage":{"is_enabled":false}
}`;

// Live 200 shape, 2026-10-01 (trimmed): the Fable weekly window exists only as a limits[] row
const REAL_2026_10 = `{
  "five_hour":{"utilization":5,"resets_at":"2026-10-01T08:30:00.115642+00:00","limit_dollars":null,"locked_reason":null},
  "seven_day":{"utilization":52,"resets_at":"2026-10-02T10:00:00.115664+00:00","limit_dollars":null,"locked_reason":null},
  "seven_day_opus":null,
  "seven_day_sonnet":null,
  "limits":[
    {"kind":"session","group":"session","percent":5,"severity":"normal","resets_at":"2026-10-01T08:30:00.115642+00:00","scope":null,"is_active":false},
    {"kind":"weekly_all","group":"weekly","percent":52,"severity":"normal","resets_at":"2026-10-02T10:00:00.115664+00:00","scope":null,"is_active":false},
    {"kind":"weekly_scoped","group":"weekly","percent":100,"severity":"critical","resets_at":"2026-10-02T10:00:00.115922+00:00","scope":{"model":{"id":null,"display_name":"Fable"},"surface":null},"is_active":true}
  ]
}`;

describe('parseUsageResponseBody', () => {
  it('parses account windows and normalizes resets_at to epoch ms', () => {
    const parsed = parseUsageResponseBody(REAL_200);
    expect(parsed?.fiveHour?.utilization).toBe(54);
    expect(parsed?.fiveHour?.resetsAt).toBe(Date.parse('2026-06-08T01:50:00.258614+00:00'));
    expect(parsed?.sevenDay?.utilization).toBe(61);
  });

  it('ignores the top-level seven_day_<model> fields and extra_usage', () => {
    const parsed = parseUsageResponseBody(REAL_200);
    expect(parsed && 'seven_day_sonnet' in parsed).toBe(false);
    expect(parsed?.modelScoped).toBeUndefined();
    const onlyModel = parseUsageResponseBody('{"seven_day_sonnet":{"utilization":7.0},"extra_usage":{"is_enabled":false}}');
    expect(onlyModel).toBeNull();
  });

  it('reads the weekly windows of models capped on their own from limits[] (Fable)', () => {
    const parsed = parseUsageResponseBody(REAL_2026_10);
    expect(parsed?.fiveHour?.utilization).toBe(5);
    expect(parsed?.sevenDay?.utilization).toBe(52);
    expect(parsed?.modelScoped).toEqual({
      fable: { label: 'Fable', utilization: 100, resetsAt: Date.parse('2026-10-02T10:00:00.115922+00:00') },
    });
    const onlyFable = parseUsageResponseBody('{"limits":[{"kind":"weekly_scoped","percent":3,"scope":{"model":{"display_name":"Fable"}}}]}');
    expect(onlyFable?.modelScoped?.fable?.utilization).toBe(3);
  });

  it('skips limits[] rows that do not cap a model', () => {
    const parsed = parseUsageResponseBody(JSON.stringify({
      five_hour: { utilization: 1 },
      limits: [
        { kind: 'weekly_scoped', percent: 40, scope: { model: null, surface: { display_name: 'Claude Code' } } },
        { kind: 'weekly_all', percent: 52, scope: null },
        { kind: 'weekly_scoped', percent: 'n/a', scope: { model: { display_name: 'Fable' } } },
        null,
      ],
    }));
    expect(parsed?.fiveHour?.utilization).toBe(1);
    expect(parsed?.modelScoped).toBeUndefined();
  });

  it('handles numeric resets_at (unix seconds) and missing resets_at', () => {
    const parsed = parseUsageResponseBody('{"five_hour":{"utilization":80.0,"resets_at":1765152000}}');
    expect(parsed?.fiveHour?.resetsAt).toBe(1765152000_000);
    const noReset = parseUsageResponseBody('{"five_hour":{"utilization":80.0}}');
    expect(noReset?.fiveHour).toEqual({ utilization: 80, resetsAt: null });
  });

  it('rejects garbage and clamps utilization to 0-100', () => {
    expect(parseUsageResponseBody('not json')).toBeNull();
    expect(parseUsageResponseBody('{}')).toBeNull();
    expect(parseUsageResponseBody('{"five_hour":{"utilization":120}}')?.fiveHour?.utilization).toBe(100);
  });
});

describe('model scopes', () => {
  it('keys a window by the first word of its label', () => {
    expect(modelScopeKey('Fable')).toBe('fable');
    expect(modelScopeKey('Fable 5.1')).toBe('fable');
    expect(modelScopeKey('5.1')).toBeNull();
  });

  it('maps model ids and aliases onto the window that caps them, on whole words only', () => {
    expect(modelScopeFor('claude-fable-5-1')).toBe('fable');
    expect(modelScopeFor('fable')).toBe('fable');
    expect(modelScopeFor('claude-opus-5-5[1m]')).toBeNull();
    expect(modelScopeFor('claude-fableish-1')).toBeNull();
    expect(modelScopeFor(undefined)).toBeNull();
  });

  it('learns windows the usage endpoint reports beyond the built-in Fable', () => {
    const cache: UsageCacheFile = {
      accounts: { a: { fetchedAt: 0, modelScoped: { mythos: { label: 'Mythos', utilization: 1, resetsAt: null } } } },
      backoff: {},
      switches: [],
    };
    expect(modelScopeFor('claude-mythos-1')).toBeNull();
    expect(modelScopeFor('claude-mythos-1', cache)).toBe('mythos');
    expect(modelScopeLabel('mythos', cache)).toBe('Mythos');
    expect(modelScopeLabel('fable')).toBe('Fable');
  });
});

describe('backoff', () => {
  it('doubles from 30s and caps at 3600s', () => {
    expect(backoffWaitSec(0)).toBe(30);
    expect(backoffWaitSec(1)).toBe(60);
    expect(backoffWaitSec(3)).toBe(240);
    expect(backoffWaitSec(7)).toBe(3600);
    expect(backoffWaitSec(50)).toBe(3600);
  });

  it('is active within the wait+jitter window and inactive after', () => {
    const state = { lastAttemptedAt: 1_000_000, consecutiveFailures: 3, jitterSec: 60 };
    // wait = 240 + 60 = 300s
    expect(backoffActive(state, 1_000_000 + 299_000)).toBe(true);
    expect(backoffActive(state, 1_000_000 + 300_000)).toBe(false);
    expect(backoffActive(undefined, 0)).toBe(false);
  });
});

describe('usageFetchDue', () => {
  const cache = (accounts: UsageCacheFile['accounts'], backoff: UsageCacheFile['backoff'] = {}): UsageCacheFile =>
    ({ accounts, backoff, switches: [] });

  it('is due with no cache entry and past the TTL, not within it', () => {
    const now = 1_000_000_000;
    expect(usageFetchDue(cache({}), 'a', now)).toBe(true);
    const fresh = cache({ a: { fetchedAt: now - 100_000 } });
    expect(usageFetchDue(fresh, 'a', now)).toBe(false);
    const stale = cache({ a: { fetchedAt: now - 301_000 } });
    expect(usageFetchDue(stale, 'a', now)).toBe(true);
  });

  it('is suppressed while backoff is active', () => {
    const now = 1_000_000_000;
    const c = cache({}, { a: { lastAttemptedAt: now - 10_000, consecutiveFailures: 1, jitterSec: 0 } });
    expect(usageFetchDue(c, 'a', now)).toBe(false);
  });
});
