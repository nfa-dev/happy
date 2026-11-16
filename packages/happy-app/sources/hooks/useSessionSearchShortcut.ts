import * as React from 'react';
import { Platform } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
    getPreferredShortcutModifier,
    matchesShortcutChord,
    SESSION_SEARCH_SHORTCUT,
} from '@/keyboard/shortcuts';

/**
 * ⌘F / Ctrl+F on web opens the session search instead of the browser's find.
 * The browser can only find what the chat has rendered, a short window of a
 * virtualized list, so its find misses most of the history.
 *
 * Bound only while the session screen has focus (the search screen pushed on
 * top must not open another one) and while `enabled`, which the caller turns
 * off when a diff or file view covers the chat: there the browser's find is
 * the right tool.
 */
export function useSessionSearchShortcut(sessionId: string | null, enabled: boolean): void {
    const router = useRouter();
    useFocusEffect(React.useCallback(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined' || !sessionId || !enabled) {
            return;
        }
        const modifier = getPreferredShortcutModifier(window.navigator);
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!matchesShortcutChord(event, modifier, SESSION_SEARCH_SHORTCUT)) {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            router.push(`/session/${sessionId}/search`);
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [enabled, router, sessionId]));
}
