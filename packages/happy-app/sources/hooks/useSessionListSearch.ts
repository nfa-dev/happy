import * as React from 'react';
import { create } from 'zustand';
import { useSessionListViewData, type SessionListViewItem } from '@/sync/storage';
import { filterSessionListViewData, sessionSearchTerms } from '@/utils/sessionListSearch';
import { useVisibleSessionListViewData } from './useVisibleSessionListViewData';

/**
 * The query in the session search field. There is one for the whole app and it
 * lives in memory only: the sidebar and the phone list share it, it survives
 * moving between sessions, and a reload clears it.
 */
export const useSessionListSearchStore = create<{
    query: string;
    setQuery: (query: string) => void;
}>((set) => ({
    query: '',
    setQuery: (query) => set({ query }),
}));

/** Whether a search is narrowing the home list right now (blank queries are not). */
export function useIsSessionListSearching(): boolean {
    return useSessionListSearchStore((state) => sessionSearchTerms(state.query).length > 0);
}

/**
 * The rows the home list draws. Without a search they are the visible rows,
 * with the archive shown or hidden by its setting. With one they are the whole
 * list, archive included, narrowed to the matches: someone looking for an
 * archived chat should not have to unhide the archive first.
 *
 * Empty states keep reading `useVisibleSessionListViewData`, so a search that
 * matches nothing shows "no results" in the list instead of the first-run
 * screens.
 */
export function useSearchedSessionListViewData(): SessionListViewItem[] | null {
    const query = useSessionListSearchStore((state) => state.query);
    const visible = useVisibleSessionListViewData();
    const all = useSessionListViewData();
    return React.useMemo(() => {
        if (sessionSearchTerms(query).length === 0) return visible;
        return all && filterSessionListViewData(all, query);
    }, [all, query, visible]);
}
