import * as React from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';

const PAGE_SIZE = 500;
// Decrypting a page holds the thread for a moment; the gap lets a frame in.
const PAGE_GAP_MS = 50;
const WAIT_MS = 250;
const RETRY_MS = 1000;
// About a minute of waiting for the first page or for a page the chat is
// already fetching, and a handful of requests in a row that moved nothing.
const MAX_WAITS = 240;
const MAX_STALLS = 10;

/**
 * Pulls a session's whole history into the store while the caller is mounted,
 * so a search covers every message and not only the window the chat keeps.
 *
 * The chat loads the latest page, prefetches a few more and pages the rest in
 * as you scroll up. This keeps asking for the next older page until the server
 * has none left, yielding between pages. A page the chat is already fetching
 * is waited out instead of requested twice, and a failed page is asked for
 * again after a pause, as the rest of sync does. It gives up after a run of
 * requests that moved nothing, so a stuck cursor cannot keep it going.
 */
export function useLoadFullSessionHistory(sessionId: string): void {
    React.useEffect(() => {
        let cancelled = false;
        const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
        (async () => {
            let waits = 0;
            let stalls = 0;
            while (!cancelled && waits < MAX_WAITS && stalls < MAX_STALLS) {
                const state = storage.getState().sessionMessages[sessionId];
                if (state?.isLoaded && !state.hasMoreOlder) return;
                if (!state?.isLoaded || state.isLoadingOlder) {
                    waits += 1;
                    await pause(WAIT_MS);
                    continue;
                }
                try {
                    stalls = await sync.loadOlderMessages(sessionId, PAGE_SIZE) ? 0 : stalls + 1;
                    await pause(PAGE_GAP_MS);
                } catch {
                    stalls += 1;
                    await pause(RETRY_MS);
                }
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId]);
}
