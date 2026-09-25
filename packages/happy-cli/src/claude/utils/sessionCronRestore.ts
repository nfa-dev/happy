/**
 * Session cron restore — keeps Claude Code's session-scoped scheduled work
 * alive across the query restarts that happy itself triggers.
 *
 * `/loop` without an interval (ScheduleWakeup), `/loop <interval>` and plain
 * CronCreate session jobs all live in the memory of the claude process:
 * nothing is written to disk and `--resume` does not bring them back. happy
 * ends that process whenever it restarts the query — account switch at a turn
 * boundary, mode change (model / permission mode / isolated commands),
 * reactive rate-limit switch — and only spawns the next one when a message
 * arrives, so a pending wakeup silently dies with the old process and the
 * loop stops.
 *
 * The Stop hook (generateHookSettings.ts → startHookServer.ts) reports
 * `session_crons` at every turn end. The snapshot from the last turn is
 * exactly what the killed process still had pending. After a happy-initiated
 * restart the restorer arms one timer per task and, at the fire time, pushes
 * the task's prompt into the message queue the way an app message arrives:
 *  - a dynamic-loop wakeup is pushed as `/loop …`, which re-enters the skill
 *    and lets the model re-arm its own wakeup inside the new process;
 *  - a recurring job is handed back as `/loop <interval> <prompt>` so the new
 *    process owns it again (CronList / CronDelete keep working); a schedule
 *    the skill cannot express is re-created through an explicit CronCreate
 *    instruction;
 *  - a one-shot job is pushed verbatim, which is what its own fire would do.
 *
 * Once the live process reports a task again (or the model ends the loop
 * with ScheduleWakeup({stop:true})), the matching pending timer is dropped
 * so nothing fires twice.
 */

import { logger } from '@/ui/logger';

export interface SessionCronTask {
    id: string;
    /** 5-field cron expression; one-shot wakeups pin minute/hour (and possibly dom/month) */
    schedule: string;
    recurring: boolean;
    /** Capped at 1000 chars by Claude Code; clipped values end with an `… [+N chars]` marker */
    prompt: string;
}

export interface RestoreSummary {
    reason: string;
    /** Tasks re-armed (deferred timers plus immediate pushes) */
    armed: number;
    /** Tasks whose fire time had already passed and were pushed right away */
    immediate: number;
    /** Tasks that could not be restored (unparseable schedule, too far away, over the cap, duplicates) */
    skipped: number;
    /** Earliest deferred fire time, null when nothing is deferred */
    nextFireAt: number | null;
}

export interface SessionCronRestorerDeps {
    /** Submit a prompt to the session as if the user had sent it */
    push: (text: string) => void;
    now?: () => number;
}

/** Sentinels the loop skill passes instead of a prompt; Claude Code expands them at fire time */
export const AUTONOMOUS_LOOP_SENTINEL = '<<autonomous-loop>>';
export const AUTONOMOUS_LOOP_DYNAMIC_SENTINEL = '<<autonomous-loop-dynamic>>';

const CLIP_MARKER = /… \[\+\d+ chars\]$/;
const LOOP_COMMAND = /^\/loop(\s|$)/;
const MAX_RESTORED_TASKS = 10;
const MAX_RESTORE_DELAY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_PROMPTS = 32;
const MINUTE_MS = 60_000;

/**
 * `session_crons` of a Stop hook payload. Null when the field is absent —
 * an older Claude Code that does not report session crons, in which case
 * there is nothing to restore.
 */
export function parseSessionCrons(data: unknown): SessionCronTask[] | null {
    if (!data || typeof data !== 'object') {
        return null;
    }
    const raw = (data as { session_crons?: unknown }).session_crons;
    if (!Array.isArray(raw)) {
        return null;
    }
    const tasks: SessionCronTask[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const { id, schedule, recurring, prompt } = entry as Record<string, unknown>;
        if (typeof schedule !== 'string' || typeof prompt !== 'string') continue;
        tasks.push({
            id: typeof id === 'string' ? id : '',
            schedule: schedule.trim(),
            recurring: recurring === true,
            prompt,
        });
    }
    return tasks;
}

export function isClippedPrompt(prompt: string): boolean {
    return CLIP_MARKER.test(prompt);
}

function clippedPrefix(prompt: string): string {
    return prompt.replace(CLIP_MARKER, '');
}

/** Equal prompts, or one being the clipped form of the other */
export function promptsMatch(a: string, b: string): boolean {
    if (a === b) return true;
    if (isClippedPrompt(a) && b.startsWith(clippedPrefix(a))) return true;
    if (isClippedPrompt(b) && a.startsWith(clippedPrefix(b))) return true;
    return false;
}

interface CronSpec {
    minutes: Set<number>;
    hours: Set<number>;
    /** null = unrestricted (`*`); matters for the dom/dow OR rule */
    doms: Set<number> | null;
    months: Set<number>;
    dows: Set<number> | null;
}

function parseCronField(field: string, min: number, max: number): Set<number> | null {
    const values = new Set<number>();
    for (const part of field.split(',')) {
        const [rangePart, stepPart, ...rest] = part.split('/');
        if (rest.length > 0 || rangePart === '' || (stepPart !== undefined && !/^\d+$/.test(stepPart))) {
            return null;
        }
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (step < 1) return null;
        let lo: number;
        let hi: number;
        if (rangePart === '*') {
            lo = min;
            hi = max;
        } else if (/^\d+$/.test(rangePart)) {
            lo = Number(rangePart);
            hi = stepPart === undefined ? lo : max;
        } else {
            const range = /^(\d+)-(\d+)$/.exec(rangePart);
            if (!range) return null;
            lo = Number(range[1]);
            hi = Number(range[2]);
        }
        if (lo < min || hi > max || lo > hi) return null;
        for (let v = lo; v <= hi; v += step) {
            values.add(v);
        }
    }
    return values;
}

export function parseCronSchedule(schedule: string): CronSpec | null {
    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const minutes = parseCronField(fields[0], 0, 59);
    const hours = parseCronField(fields[1], 0, 23);
    const doms = parseCronField(fields[2], 1, 31);
    const months = parseCronField(fields[3], 1, 12);
    const dows = parseCronField(fields[4], 0, 7);
    if (!minutes || !hours || !doms || !months || !dows) return null;
    if (dows.has(7)) {
        dows.delete(7);
        dows.add(0);
    }
    return {
        minutes,
        hours,
        doms: fields[2] === '*' ? null : doms,
        months,
        dows: fields[4] === '*' ? null : dows,
    };
}

function cronDayMatches(spec: CronSpec, d: Date): boolean {
    const domOk = spec.doms === null || spec.doms.has(d.getDate());
    const dowOk = spec.dows === null || spec.dows.has(d.getDay());
    // Vixie cron: when both fields are restricted, either one matching is enough
    if (spec.doms !== null && spec.dows !== null) return domOk || dowOk;
    return domOk && dowOk;
}

/**
 * Earliest minute boundary at or after `fromMs` (local time, like Claude
 * Code's own scheduler) that matches the schedule; null when the schedule is
 * invalid or nothing matches within 400 days.
 */
export function nextCronFireAt(schedule: string, fromMs: number): number | null {
    const spec = parseCronSchedule(schedule);
    if (!spec) return null;
    const d = new Date(Math.ceil(fromMs / MINUTE_MS) * MINUTE_MS);
    const limit = d.getTime() + 400 * 24 * 60 * MINUTE_MS;
    for (let guard = 0; guard < 1_000_000 && d.getTime() < limit; guard++) {
        if (!spec.months.has(d.getMonth() + 1)) {
            d.setMonth(d.getMonth() + 1, 1);
            d.setHours(0, 0, 0, 0);
            continue;
        }
        if (!cronDayMatches(spec, d)) {
            d.setDate(d.getDate() + 1);
            d.setHours(0, 0, 0, 0);
            continue;
        }
        if (!spec.hours.has(d.getHours())) {
            d.setHours(d.getHours() + 1, 0, 0, 0);
            continue;
        }
        if (!spec.minutes.has(d.getMinutes())) {
            d.setMinutes(d.getMinutes() + 1, 0, 0);
            continue;
        }
        return d.getTime();
    }
    return null;
}

/**
 * The `/loop` interval token that produces this cron expression, for the
 * schedules the loop skill itself generates: every N minutes → `Nm`, minute
 * 0 of every N hours → `Nh`, midnight of every N days → `Nd`. Null for
 * anything else.
 */
export function cronToLoopInterval(schedule: string): string | null {
    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const [minute, hour, dom, month, dow] = fields;
    if (month !== '*' || dow !== '*') return null;
    const every = (field: string): string | null => {
        if (field === '*') return '1';
        const m = /^\*\/(\d+)$/.exec(field);
        return m ? String(Number(m[1])) : null;
    };
    if (hour === '*' && dom === '*') {
        const n = every(minute);
        if (n) return `${n}m`;
    }
    if (minute !== '0') return null;
    if (dom === '*') {
        const n = every(hour);
        if (n) return `${n}h`;
    }
    if (hour !== '0') return null;
    const n = every(dom);
    return n ? `${n}d` : null;
}

interface PendingRestore {
    key: string;
    task: SessionCronTask;
    /** A dynamic-loop wakeup (ScheduleWakeup) rather than a cron job */
    loop: boolean;
    text: string;
    fireAt: number;
    timer: NodeJS.Timeout | null;
}

function remember(list: string[], prompt: string): void {
    const index = list.indexOf(prompt);
    if (index !== -1) list.splice(index, 1);
    list.push(prompt);
    while (list.length > MAX_REMEMBERED_PROMPTS) list.shift();
}

function taskKey(task: SessionCronTask): string {
    return `${task.recurring ? 'recurring' : 'once'}|${task.schedule}|${task.prompt}`;
}

export class SessionCronRestorer {
    private readonly push: (text: string) => void;
    private readonly now: () => number;
    /** Session crons reported by the most recent Stop hook — what the running process holds */
    private snapshot: { tasks: SessionCronTask[]; capturedAt: number } | null = null;
    private pending: PendingRestore[] = [];
    /** Full prompt texts seen in ScheduleWakeup / CronCreate tool calls (the hook clips at 1000 chars) */
    private readonly wakeupPrompts: string[] = [];
    private readonly cronPrompts: string[] = [];

    constructor(deps: SessionCronRestorerDeps) {
        this.push = deps.push;
        this.now = deps.now ?? Date.now;
    }

    /**
     * Stop hook payload of a finished turn. Returns false when the payload
     * carries no `session_crons` (Claude Code too old to report them).
     */
    noteStopHook(data: unknown): boolean {
        const tasks = parseSessionCrons(data);
        if (tasks === null) {
            return false;
        }
        this.snapshot = { tasks, capturedAt: this.now() };
        if (this.pending.length > 0) {
            // The live process scheduling a wakeup supersedes any restored
            // one (a session has a single dynamic loop); a cron job that the
            // live process reports again is owned by it once more.
            const liveHasLoop = tasks.some((task) => this.isLoopWakeup(task));
            this.cancelPending(
                (entry) => (entry.loop && liveHasLoop) || tasks.some((task) => promptsMatch(task.prompt, entry.task.prompt)),
                'the live session holds it again'
            );
        }
        return true;
    }

    /** Assistant tool calls: remembers full prompts and honours ScheduleWakeup({stop:true}) */
    noteToolUse(name: string, input: unknown): void {
        if (!input || typeof input !== 'object') return;
        const fields = input as Record<string, unknown>;
        if (name === 'ScheduleWakeup') {
            if (fields.stop === true) {
                this.cancelPending((entry) => entry.loop, 'the model ended the loop');
                return;
            }
            if (typeof fields.prompt === 'string') remember(this.wakeupPrompts, fields.prompt);
        } else if (name === 'CronCreate' && typeof fields.prompt === 'string') {
            remember(this.cronPrompts, fields.prompt);
        }
    }

    /**
     * The query is being restarted by happy: the process that held the
     * snapshot's tasks is going away, so take them over. Consumes the
     * snapshot; a later restart without a new Stop hook arms nothing more.
     */
    restoreAfterRestart(reason: string): RestoreSummary {
        const snapshot = this.snapshot;
        this.snapshot = null;
        const summary: RestoreSummary = { reason, armed: 0, immediate: 0, skipped: 0, nextFireAt: null };
        if (!snapshot || snapshot.tasks.length === 0) {
            return summary;
        }
        const now = this.now();
        const seen = new Set(this.pending.map((entry) => entry.key));
        for (const task of snapshot.tasks) {
            const key = taskKey(task);
            if (seen.has(key)) {
                summary.skipped++;
                continue;
            }
            seen.add(key);
            if (summary.armed >= MAX_RESTORED_TASKS) {
                summary.skipped++;
                continue;
            }
            const loop = this.isLoopWakeup(task);
            const prompt = this.unclip(task.prompt);
            // A one-shot fires at its first match after the snapshot; if that
            // already passed while no process was alive, it was missed — fire
            // now. A recurring job just picks up at its next boundary.
            const fireAt = nextCronFireAt(task.schedule, task.recurring ? now : snapshot.capturedAt);
            if (fireAt === null) {
                summary.skipped++;
                logger.debug(`[cronRestore] Cannot restore task ${task.id}: unparseable schedule '${task.schedule}'`);
                continue;
            }
            const delay = Math.max(0, fireAt - now);
            if (delay > MAX_RESTORE_DELAY_MS) {
                summary.skipped++;
                logger.debug(`[cronRestore] Not restoring task ${task.id}: next fire of '${task.schedule}' is more than 7 days away`);
                continue;
            }
            const entry: PendingRestore = {
                key,
                task,
                loop,
                text: this.restoreText(task, prompt, loop, reason),
                fireAt,
                timer: null,
            };
            summary.armed++;
            if (delay === 0) {
                summary.immediate++;
                logger.debug(`[cronRestore] Task ${task.id} ('${task.schedule}') was due while no process was running — pushing now (${reason})`);
                this.fire(entry);
                continue;
            }
            entry.timer = setTimeout(() => this.fire(entry), delay);
            entry.timer.unref?.();
            this.pending.push(entry);
            summary.nextFireAt = summary.nextFireAt === null ? fireAt : Math.min(summary.nextFireAt, fireAt);
            const kind = loop ? 'loop wakeup' : task.recurring ? 'recurring' : 'one-shot';
            logger.debug(`[cronRestore] Re-armed task ${task.id} ('${task.schedule}', ${kind}) for ${new Date(fireAt).toISOString()} (${reason})`);
        }
        return summary;
    }

    /** Forget the snapshot without restoring (user abort, /clear, launch failure) */
    discard(reason: string): void {
        if (this.snapshot && this.snapshot.tasks.length > 0) {
            logger.debug(`[cronRestore] Dropping ${this.snapshot.tasks.length} session cron(s): ${reason}`);
        }
        this.snapshot = null;
    }

    /** Drop everything, pending timers included (launcher exit) */
    cancelAll(): void {
        this.cancelPending(() => true, 'cancelled');
        this.snapshot = null;
    }

    /** Tasks with a pending timer, earliest first (for tests and diagnostics) */
    pendingTasks(): Array<{ task: SessionCronTask; text: string; fireAt: number; loop: boolean }> {
        return [...this.pending]
            .sort((a, b) => a.fireAt - b.fireAt)
            .map(({ task, text, fireAt, loop }) => ({ task, text, fireAt, loop }));
    }

    private isLoopWakeup(task: SessionCronTask): boolean {
        if (task.recurring) return false;
        return task.prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL
            || LOOP_COMMAND.test(task.prompt)
            || this.wakeupPrompts.some((prompt) => promptsMatch(prompt, task.prompt));
    }

    private unclip(prompt: string): string {
        if (!isClippedPrompt(prompt)) return prompt;
        const prefix = clippedPrefix(prompt);
        for (const list of [this.wakeupPrompts, this.cronPrompts]) {
            for (let i = list.length - 1; i >= 0; i--) {
                if (list[i].startsWith(prefix)) return list[i];
            }
        }
        return prompt;
    }

    private restoreText(task: SessionCronTask, prompt: string, loop: boolean, reason: string): string {
        if (!task.recurring) {
            if (!loop) return prompt;
            if (prompt === AUTONOMOUS_LOOP_DYNAMIC_SENTINEL) return '/loop';
            return LOOP_COMMAND.test(prompt) ? prompt : `/loop ${prompt}`;
        }
        const interval = cronToLoopInterval(task.schedule);
        if (interval) {
            return prompt === AUTONOMOUS_LOOP_SENTINEL ? `/loop ${interval}` : `/loop ${interval} ${prompt}`;
        }
        return `A recurring session cron job was lost when happy restarted the Claude process (${reason}). `
            + `Re-create it now: call CronCreate with cron "${task.schedule}", recurring: true and exactly the prompt below, `
            + `then run that prompt once as this tick.\n\n${prompt}`;
    }

    private fire(entry: PendingRestore): void {
        this.pending = this.pending.filter((pending) => pending !== entry);
        try {
            this.push(entry.text);
            logger.debug(`[cronRestore] Pushed restored task ${entry.task.id} ('${entry.task.schedule}')`);
        } catch (error) {
            logger.debug(`[cronRestore] Failed to push restored task ${entry.task.id}`, error);
        }
    }

    private cancelPending(matches: (entry: PendingRestore) => boolean, reason: string): void {
        const keep: PendingRestore[] = [];
        for (const entry of this.pending) {
            if (!matches(entry)) {
                keep.push(entry);
                continue;
            }
            if (entry.timer) clearTimeout(entry.timer);
            logger.debug(`[cronRestore] Dropped restored task ${entry.task.id} ('${entry.task.schedule}'): ${reason}`);
        }
        this.pending = keep;
    }
}
