interface KeyboardScrollEvent {
    key: string;
    defaultPrevented: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

export const CHAT_LIST_KEYBOARD_LINE_SCROLL = 48;

/**
 * Sends the list to one end. `scrollTop` clamps to `[0, scrollHeight -
 * clientHeight]` on assignment, so any sufficiently large finite delta lands
 * exactly on the end.
 *
 * It has to be finite: CSSOM normalizes a non-finite `scrollTop` to zero, so
 * `Infinity` would send Home to the *newest* message — the opposite of what it
 * means.
 */
export const CHAT_LIST_KEYBOARD_JUMP = Number.MAX_SAFE_INTEGER;

export function getInvertedChatListKeyboardScrollDelta(
    event: KeyboardScrollEvent,
    viewportHeight: number,
): number | null {
    if (event.defaultPrevented) return null;
    // Leave OS and browser shortcuts alone.
    if (event.altKey || event.ctrlKey || event.metaKey) return null;

    // Shift means something on exactly one of these keys — Shift+Space. Anywhere
    // else it is a selection gesture and not ours to take.
    const isSpace = event.key === ' ' || event.key === 'Spacebar';
    if (event.shiftKey && !isSpace) return null;

    switch (event.key) {
        case 'ArrowDown':
            return -CHAT_LIST_KEYBOARD_LINE_SCROLL;
        case 'ArrowUp':
            return CHAT_LIST_KEYBOARD_LINE_SCROLL;
        case 'PageDown':
            return -viewportHeight;
        case 'PageUp':
            return viewportHeight;
        // Browser convention: Space pages toward what you have not read yet,
        // Shift+Space pages back.
        case ' ':
        case 'Spacebar':
            return event.shiftKey ? viewportHeight : -viewportHeight;
        // The list is inverted, so the DOM's far end holds the oldest message.
        // End goes to the newest (offset 0), Home to the oldest.
        case 'Home':
            return CHAT_LIST_KEYBOARD_JUMP;
        case 'End':
            return -CHAT_LIST_KEYBOARD_JUMP;
        default:
            return null;
    }
}
