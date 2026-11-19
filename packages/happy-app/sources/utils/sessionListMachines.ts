import type { SessionListViewItem, SessionRowData } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { collectMachineChoices } from '@/sync/machineChoices';
import { narrowSessionListViewData } from './sessionListSearch';

/**
 * The home list's machine filter, and the machine name on its rows.
 *
 * Both go by the name a computer shows rather than by a machine id. A computer
 * collects machine ids over time: a daemon started from a fresh data directory
 * registers again (a reinstall, a migrated home), and Happy CLI and Happy Agent
 * register it once each. Keyed by id, the filter would offer one name several
 * times and lose a computer the next time it registered; keyed by the name on
 * the row, it follows the computer. Two computers that share a name cannot be
 * told apart on a row either, so they share one entry in the filter as well.
 */

/**
 * The name the list shows for a session's computer, or '' for a session that
 * never said where it runs.
 */
export type SessionMachineNamer = (session: Pick<SessionRowData, 'machineId' | 'machineName'>) => string;

export function createSessionMachineNamer(machines: readonly Machine[]): SessionMachineNamer {
    // A computer's daemons go by one name, the one the new-session picker
    // already offers them under, so a Happy Agent session and a Happy CLI
    // session on the same laptop land in the same entry.
    const names = new Map<string, string>();
    for (const choice of collectMachineChoices(machines)) {
        const named = choice.happyMachine ?? choice.rigMachine;
        if (!named?.metadata?.displayName && !named?.metadata?.host) continue;
        for (const id of choice.machineIds) names.set(id, choice.name);
    }
    // Otherwise the row's own name, which falls back to the host the session
    // reported: all there is once its machine has been deleted.
    return (session) => (
        (session.machineId ? names.get(session.machineId) : undefined) ?? session.machineName ?? ''
    ).trim();
}

/**
 * The computers the list's sessions run on, by name, in the order the filter
 * offers them: alphabetical with numbers compared as numbers, and sessions that
 * never said where they run last.
 */
export function collectSessionListMachines(
    items: readonly SessionListViewItem[],
    nameOf: SessionMachineNamer,
): string[] {
    const names = new Set(listSessions(items).map(nameOf));
    return [...names].sort(compareMachineNames);
}

export function compareMachineNames(a: string, b: string): number {
    if (a === '' || b === '') return Number(a === '') - Number(b === '');
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/** The list narrowed to the sessions on one computer, in the shape the list draws. */
export function filterSessionListViewDataByMachine(
    items: readonly SessionListViewItem[],
    machine: string,
    nameOf: SessionMachineNamer,
): SessionListViewItem[] {
    return narrowSessionListViewData(items, (session) => nameOf(session) === machine);
}

/** Whether the list holds an archived session on this computer. */
export function hasArchivedSessionsOnMachine(
    items: readonly SessionListViewItem[],
    machine: string,
    nameOf: SessionMachineNamer,
): boolean {
    return listSessions(items).some((session) => session.archived && nameOf(session) === machine);
}

/** Every session in the list, wherever it sits. */
function listSessions(items: readonly SessionListViewItem[]): SessionRowData[] {
    return items.flatMap((item) => {
        switch (item.type) {
            case 'bots':
            case 'active-sessions':
                return item.sessions;
            case 'project':
                return item.project.workspaces.flatMap((workspace) => workspace.sessions);
            case 'session':
                return [item.session];
            default:
                return [];
        }
    });
}
