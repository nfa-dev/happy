import * as React from 'react';
import { storage, useAllMachines, useLocalSetting, useSessionListViewData, type SessionListViewItem } from '@/sync/storage';
import {
    collectSessionListMachines,
    compareMachineNames,
    createSessionMachineNamer,
    filterSessionListViewDataByMachine,
    hasArchivedSessionsOnMachine,
    type SessionMachineNamer,
} from '@/utils/sessionListMachines';
import { useHasArchivedSessions, useVisibleSessionListViewData } from './useVisibleSessionListViewData';
import { useSearchedSessionListViewData } from './useSessionListSearch';

/** Names each session's computer the way the list shows it. */
export function useSessionMachineNamer(): SessionMachineNamer {
    // Offline machines too: most of the archive ran on a computer that is off now.
    const machines = useAllMachines({ includeOffline: true });
    return React.useMemo(() => createSessionMachineNamer(machines), [machines]);
}

export interface SessionListMachineFilter {
    /**
     * The computer the list is narrowed to, by name ('' for sessions that never
     * said where they run), or null for every computer.
     */
    selected: string | null;
    /** Every computer the list runs on, archive included. */
    machines: string[];
    nameOf: SessionMachineNamer;
}

/**
 * The machine filter in force.
 *
 * The choice is kept per device, in local settings: the computer a browser
 * sits next to is often the one worth seeing there, and the sidebar and the
 * phone list share it. A stored name that no session in the list carries any
 * more, because the computer was renamed or its sessions were deleted, counts
 * as no filter, so the list never hides everything behind a choice nobody can
 * see or undo.
 */
export function useSessionListMachineFilter(): SessionListMachineFilter {
    const stored = useLocalSetting('sessionListMachineFilter');
    const all = useSessionListViewData();
    const nameOf = useSessionMachineNamer();
    const machines = useStableNames(React.useMemo(
        () => collectSessionListMachines(all ?? [], nameOf),
        [all, nameOf],
    ));
    const selected = stored !== null && machines.includes(stored) ? stored : null;
    return React.useMemo(() => ({ selected, machines, nameOf }), [machines, nameOf, selected]);
}

export function setSessionListMachineFilter(machine: string | null): void {
    storage.getState().applyLocalSettings({ sessionListMachineFilter: machine });
}

/**
 * The computers the filter offers: the ones the list on screen runs on, so a
 * computer whose sessions all sit in the hidden archive does not crowd the
 * menu, plus the chosen one, which stays on offer to be seen and undone.
 */
export function useSessionListMachineOptions(): { options: string[]; selected: string | null } {
    const { selected, nameOf } = useSessionListMachineFilter();
    const visible = useVisibleSessionListViewData();
    const options = useStableNames(React.useMemo(() => {
        const names = collectSessionListMachines(visible ?? [], nameOf);
        if (selected === null || names.includes(selected)) return names;
        return [...names, selected].sort(compareMachineNames);
    }, [nameOf, selected, visible]));
    return { options, selected };
}

/**
 * The rows the home list draws: the search's (see useSearchedSessionListViewData),
 * narrowed to the chosen computer.
 */
export function useNarrowedSessionListViewData(): SessionListViewItem[] | null {
    const searched = useSearchedSessionListViewData();
    const { selected, nameOf } = useSessionListMachineFilter();
    return React.useMemo(() => {
        if (!searched || selected === null) return searched;
        return filterSessionListViewDataByMachine(searched, selected, nameOf);
    }, [nameOf, searched, selected]);
}

/**
 * The list on screen narrowed to the chosen computer, without the search. The
 * session shortcuts number these, so ⌘1 never opens a chat the filter hides.
 */
export function useMachineFilteredSessionListViewData(): SessionListViewItem[] | null {
    const visible = useVisibleSessionListViewData();
    const { selected, nameOf } = useSessionListMachineFilter();
    return React.useMemo(() => {
        if (!visible || selected === null) return visible;
        return filterSessionListViewDataByMachine(visible, selected, nameOf);
    }, [nameOf, selected, visible]);
}

/**
 * Whether the archive holds anything on the chosen computer: with nothing
 * there, the control that shows the archive would reveal nothing.
 */
export function useHasArchivedSessionsOnFilteredMachine(): boolean {
    const hasArchivedSessions = useHasArchivedSessions();
    const all = useSessionListViewData();
    const { selected, nameOf } = useSessionListMachineFilter();
    return React.useMemo(() => {
        if (selected === null) return hasArchivedSessions;
        return hasArchivedSessionsOnMachine(all ?? [], selected, nameOf);
    }, [all, hasArchivedSessions, nameOf, selected]);
}

/**
 * The same list of names keeps the same array. The session list is rebuilt
 * every time any session changes, and the names on it almost never do.
 */
function useStableNames(names: string[]): string[] {
    const key = JSON.stringify(names);
    return React.useMemo(() => JSON.parse(key) as string[], [key]);
}
