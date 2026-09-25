import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
    AUTONOMOUS_LOOP_SENTINEL,
    SessionCronRestorer,
    cronToLoopInterval,
    nextCronFireAt,
    parseSessionCrons,
    promptsMatch,
} from './sessionCronRestore';

/** Local wall-clock instant, like Claude Code's own minute/hour pinning */
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe('parseSessionCrons', () => {
    it('returns null when the payload has no session_crons (older Claude Code)', () => {
        expect(parseSessionCrons({ hook_event_name: 'Stop' })).toBeNull();
        expect(parseSessionCrons(null)).toBeNull();
        expect(parseSessionCrons({ session_crons: 'x' })).toBeNull();
    });

    it('keeps well-formed entries and drops the rest', () => {
        const tasks = parseSessionCrons({
            session_crons: [
                { id: 'a', schedule: ' 16 20 * * * ', recurring: false, prompt: '/loop x' },
                { id: 'b', schedule: '*/3 * * * *', recurring: true, prompt: '/foo' },
                { id: 'c', schedule: 5, prompt: 'nope' },
                'garbage',
                { id: 'd', schedule: '0 9 * * *', prompt: 'no recurring field' },
            ],
        });
        expect(tasks).toEqual([
            { id: 'a', schedule: '16 20 * * *', recurring: false, prompt: '/loop x' },
            { id: 'b', schedule: '*/3 * * * *', recurring: true, prompt: '/foo' },
            { id: 'd', schedule: '0 9 * * *', recurring: false, prompt: 'no recurring field' },
        ]);
    });
});

describe('nextCronFireAt', () => {
    it('pinned minute/hour: same day while still ahead, next day once passed', () => {
        expect(nextCronFireAt('16 20 * * *', local(2026, 9, 25, 20, 12) + 59_000)).toBe(local(2026, 9, 25, 20, 16));
        expect(nextCronFireAt('16 20 * * *', local(2026, 9, 25, 20, 17))).toBe(local(2026, 9, 26, 20, 16));
    });

    it('a minute boundary equal to `from` counts as a match', () => {
        expect(nextCronFireAt('16 20 * * *', local(2026, 9, 25, 20, 16))).toBe(local(2026, 9, 25, 20, 16));
        expect(nextCronFireAt('16 20 * * *', local(2026, 9, 25, 20, 16) + 400)).toBe(local(2026, 9, 26, 20, 16));
    });

    it('step schedules pick the next boundary', () => {
        expect(nextCronFireAt('*/3 * * * *', local(2026, 9, 25, 20, 13) + 1_000)).toBe(local(2026, 9, 25, 20, 15));
        expect(nextCronFireAt('0 */2 * * *', local(2026, 9, 25, 20, 13))).toBe(local(2026, 9, 25, 22, 0));
        expect(nextCronFireAt('0 0 * * *', local(2026, 9, 25, 20, 13))).toBe(local(2026, 9, 26, 0, 0));
    });

    it('honours day-of-week ranges and the dom/dow OR rule', () => {
        // 2026-09-26 is a Saturday
        expect(nextCronFireAt('0 9 * * 1-5', local(2026, 9, 26, 10, 0))).toBe(local(2026, 9, 28, 9, 0));
        // 13th of the month or any Friday, whichever comes first (2026-10-02 is a Friday)
        expect(nextCronFireAt('0 0 13 * 5', local(2026, 9, 26, 10, 0))).toBe(local(2026, 10, 2, 0, 0));
        // 7 is Sunday too
        expect(nextCronFireAt('0 9 * * 7', local(2026, 9, 26, 10, 0))).toBe(local(2026, 9, 27, 9, 0));
    });

    it('rejects invalid or never-matching expressions', () => {
        expect(nextCronFireAt('16 20 * *', 0)).toBeNull();
        expect(nextCronFireAt('60 20 * * *', 0)).toBeNull();
        expect(nextCronFireAt('a b c d e', 0)).toBeNull();
        expect(nextCronFireAt('*/0 * * * *', 0)).toBeNull();
        expect(nextCronFireAt('0 0 31 2 *', local(2026, 1, 1, 0, 0))).toBeNull();
    });
});

describe('cronToLoopInterval', () => {
    it('recovers the /loop interval the skill generated', () => {
        expect(cronToLoopInterval('*/5 * * * *')).toBe('5m');
        expect(cronToLoopInterval('* * * * *')).toBe('1m');
        expect(cronToLoopInterval('0 * * * *')).toBe('1h');
        expect(cronToLoopInterval('0 */2 * * *')).toBe('2h');
        expect(cronToLoopInterval('0 0 * * *')).toBe('1d');
        expect(cronToLoopInterval('0 0 */3 * *')).toBe('3d');
    });

    it('gives up on schedules /loop cannot express', () => {
        expect(cronToLoopInterval('0 9 * * 1-5')).toBeNull();
        expect(cronToLoopInterval('30 */2 * * *')).toBeNull();
        expect(cronToLoopInterval('16 20 * * *')).toBeNull();
        expect(cronToLoopInterval('0 0 1 * *')).toBeNull();
    });
});

describe('promptsMatch', () => {
    it('treats a clipped prompt as matching its full text', () => {
        expect(promptsMatch('abc', 'abc')).toBe(true);
        expect(promptsMatch('abc… [+5 chars]', 'abcdefgh')).toBe(true);
        expect(promptsMatch('abcdefgh', 'abc… [+5 chars]')).toBe(true);
        expect(promptsMatch('abc… [+5 chars]', 'xyz')).toBe(false);
        expect(promptsMatch('abc', 'abcd')).toBe(false);
    });
});

describe('SessionCronRestorer', () => {
    let pushed: string[];
    let restorer: SessionCronRestorer;
    /** Stop hook of the turn that scheduled a 20:16 wakeup */
    const T0 = local(2026, 9, 25, 20, 12) + 59_000;
    const wakeup = { id: 'w1', schedule: '16 20 * * *', recurring: false, prompt: '/loop keep going' };
    const stop = (crons: unknown[]) => restorer.noteStopHook({ hook_event_name: 'Stop', session_crons: crons });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        pushed = [];
        restorer = new SessionCronRestorer({ push: (text) => pushed.push(text) });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('re-arms a dynamic-loop wakeup lost in a restart and pushes it at the scheduled minute', () => {
        expect(stop([wakeup])).toBe(true);
        vi.setSystemTime(T0 + 2_000); // the switch is decided right after the turn ends
        const summary = restorer.restoreAfterRestart('account switch');
        expect(summary).toMatchObject({ armed: 1, immediate: 0, skipped: 0, nextFireAt: local(2026, 9, 25, 20, 16) });
        expect(restorer.pendingTasks().map((entry) => entry.text)).toEqual(['/loop keep going']);

        vi.advanceTimersByTime(local(2026, 9, 25, 20, 16) - (T0 + 2_000) - 1);
        expect(pushed).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(pushed).toEqual(['/loop keep going']);
        expect(restorer.pendingTasks()).toEqual([]);
    });

    it('pushes right away when the fire time passed while no process was alive', () => {
        stop([wakeup]);
        vi.setSystemTime(local(2026, 9, 25, 20, 17));
        const summary = restorer.restoreAfterRestart('rate-limit account switch');
        expect(summary).toMatchObject({ armed: 1, immediate: 1, nextFireAt: null });
        expect(pushed).toEqual(['/loop keep going']);
        expect(restorer.pendingTasks()).toEqual([]);
    });

    it('recognises a wakeup by its ScheduleWakeup call and re-enters /loop with the prompt', () => {
        restorer.noteToolUse('ScheduleWakeup', { delaySeconds: 180, prompt: 'check the deploy' });
        stop([{ ...wakeup, prompt: 'check the deploy' }]);
        restorer.restoreAfterRestart('account switch');
        expect(restorer.pendingTasks()[0]).toMatchObject({ loop: true, text: '/loop check the deploy' });
    });

    it('maps the loop sentinels back to the bare /loop forms', () => {
        stop([
            { ...wakeup, prompt: AUTONOMOUS_LOOP_DYNAMIC_SENTINEL },
            { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: AUTONOMOUS_LOOP_SENTINEL },
        ]);
        restorer.restoreAfterRestart('mode change');
        expect(restorer.pendingTasks().map((entry) => entry.text).sort()).toEqual(['/loop', '/loop 5m']);
    });

    it('hands a recurring job back as /loop <interval> <prompt> at its next boundary', () => {
        stop([{ id: 'c1', schedule: '*/3 * * * *', recurring: true, prompt: '/babysit-prs' }]);
        vi.setSystemTime(local(2026, 9, 25, 20, 13) + 1_000);
        const summary = restorer.restoreAfterRestart('account switch');
        expect(summary.nextFireAt).toBe(local(2026, 9, 25, 20, 15));
        vi.advanceTimersByTime(2 * 60_000);
        expect(pushed).toEqual(['/loop 3m /babysit-prs']);
    });

    it('re-creates a schedule /loop cannot express through an explicit CronCreate instruction', () => {
        stop([{ id: 'c1', schedule: '0 9 * * 1-5', recurring: true, prompt: 'post the standup summary' }]);
        restorer.restoreAfterRestart('mode change');
        const [entry] = restorer.pendingTasks();
        expect(entry.text).toContain('CronCreate');
        expect(entry.text).toContain('"0 9 * * 1-5"');
        expect(entry.text.endsWith('post the standup summary')).toBe(true);
    });

    it('pushes a one-shot reminder verbatim at its pinned time', () => {
        stop([{ id: 'o1', schedule: '30 20 25 9 *', recurring: false, prompt: 'remind: stand up' }]);
        restorer.restoreAfterRestart('mode change');
        expect(restorer.pendingTasks()[0]).toMatchObject({
            loop: false,
            text: 'remind: stand up',
            fireAt: local(2026, 9, 25, 20, 30),
        });
    });

    it('restores the full prompt when the hook clipped it', () => {
        const full = '/loop ' + 'x'.repeat(1200);
        restorer.noteToolUse('ScheduleWakeup', { delaySeconds: 180, prompt: full });
        stop([{ ...wakeup, prompt: full.slice(0, 1000) + '… [+206 chars]' }]);
        restorer.restoreAfterRestart('account switch');
        expect(restorer.pendingTasks()[0].text).toBe(full);
    });

    it('drops a restored wakeup once the live session schedules its own', () => {
        stop([wakeup]);
        restorer.restoreAfterRestart('account switch');
        expect(restorer.pendingTasks()).toHaveLength(1);

        stop([]); // a user turn in the new process that did not touch the loop
        expect(restorer.pendingTasks()).toHaveLength(1);

        stop([{ id: 'w2', schedule: '20 20 * * *', recurring: false, prompt: '/loop something else' }]);
        expect(restorer.pendingTasks()).toEqual([]);
        vi.advanceTimersByTime(60 * 60_000);
        expect(pushed).toEqual([]);
    });

    it('drops a restored cron job the live session reports again', () => {
        stop([{ id: 'c1', schedule: '*/3 * * * *', recurring: true, prompt: '/babysit-prs' }]);
        restorer.restoreAfterRestart('mode change');
        expect(restorer.pendingTasks()).toHaveLength(1);
        stop([{ id: 'c9', schedule: '*/3 * * * *', recurring: true, prompt: '/babysit-prs' }]);
        expect(restorer.pendingTasks()).toEqual([]);
    });

    it('honours ScheduleWakeup({stop:true}) for a restored loop', () => {
        stop([wakeup]);
        restorer.restoreAfterRestart('account switch');
        restorer.noteToolUse('ScheduleWakeup', { stop: true });
        expect(restorer.pendingTasks()).toEqual([]);
    });

    it('consumes the snapshot on restore and forgets it on discard', () => {
        stop([wakeup]);
        expect(restorer.restoreAfterRestart('account switch').armed).toBe(1);
        expect(restorer.restoreAfterRestart('mode change').armed).toBe(0);
        expect(restorer.pendingTasks()).toHaveLength(1);

        restorer.cancelAll();
        stop([wakeup]);
        restorer.discard('user abort');
        expect(restorer.restoreAfterRestart('mode change').armed).toBe(0);
        expect(restorer.pendingTasks()).toEqual([]);
    });

    it('does nothing when the payload lacks session_crons', () => {
        expect(restorer.noteStopHook({ hook_event_name: 'Stop' })).toBe(false);
        expect(restorer.restoreAfterRestart('account switch').armed).toBe(0);
    });

    it('cancelAll clears pending timers', () => {
        stop([wakeup]);
        restorer.restoreAfterRestart('account switch');
        restorer.cancelAll();
        expect(restorer.pendingTasks()).toEqual([]);
        vi.advanceTimersByTime(24 * 60 * 60_000);
        expect(pushed).toEqual([]);
    });

    it('survives a push that throws (queue already closed)', () => {
        const failing = new SessionCronRestorer({ push: () => { throw new Error('closed'); } });
        failing.noteStopHook({ session_crons: [wakeup] });
        vi.setSystemTime(local(2026, 9, 25, 20, 17));
        expect(() => failing.restoreAfterRestart('account switch')).not.toThrow();
    });

    it('skips duplicates and caps the number of restored tasks', () => {
        const many = Array.from({ length: 12 }, (_, i) => ({
            id: `c${i}`,
            schedule: `${(i * 5) % 60} 21 * * *`,
            recurring: false,
            prompt: `job ${i}`,
        }));
        stop([...many, many[0]]);
        const summary = restorer.restoreAfterRestart('mode change');
        expect(summary.armed).toBe(10);
        expect(summary.skipped).toBe(3);
        expect(restorer.pendingTasks()).toHaveLength(10);
    });
});
