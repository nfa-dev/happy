import { describe, expect, it } from 'vitest';
import {
    CHAT_LIST_KEYBOARD_JUMP,
    CHAT_LIST_KEYBOARD_LINE_SCROLL,
    getInvertedChatListKeyboardScrollDelta,
} from './chatListKeyboardScroll';

const VIEWPORT_HEIGHT = 720;

function keyboardEvent(
    key: string,
    overrides: Partial<Parameters<typeof getInvertedChatListKeyboardScrollDelta>[0]> = {},
) {
    return {
        key,
        defaultPrevented: false,
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...overrides,
    };
}

describe('inverted chat list keyboard scrolling', () => {
    it('maps standard reading-navigation keys to the inverse DOM scroll delta', () => {
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('ArrowDown'), VIEWPORT_HEIGHT))
            .toBe(-CHAT_LIST_KEYBOARD_LINE_SCROLL);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('ArrowUp'), VIEWPORT_HEIGHT))
            .toBe(CHAT_LIST_KEYBOARD_LINE_SCROLL);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('PageDown'), VIEWPORT_HEIGHT))
            .toBe(-VIEWPORT_HEIGHT);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('PageUp'), VIEWPORT_HEIGHT))
            .toBe(VIEWPORT_HEIGHT);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent(' '), VIEWPORT_HEIGHT))
            .toBe(-VIEWPORT_HEIGHT);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('Spacebar'), VIEWPORT_HEIGHT))
            .toBe(-VIEWPORT_HEIGHT);
    });

    it('leaves handled, modified, and unrelated key events alone', () => {
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { defaultPrevented: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { metaKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { ctrlKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { altKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('ArrowDown', { shiftKey: true }),
            VIEWPORT_HEIGHT,
        )).toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('Tab'), VIEWPORT_HEIGHT))
            .toBeNull();
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('a'), VIEWPORT_HEIGHT))
            .toBeNull();
    });

    it('pages back on Shift+Space, the one key where Shift is ours', () => {
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent(' ', { shiftKey: true }),
            VIEWPORT_HEIGHT,
        )).toBe(VIEWPORT_HEIGHT);
        expect(getInvertedChatListKeyboardScrollDelta(
            keyboardEvent('Spacebar', { shiftKey: true }),
            VIEWPORT_HEIGHT,
        )).toBe(VIEWPORT_HEIGHT);
        // ...and still pages forward without it.
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent(' '), VIEWPORT_HEIGHT))
            .toBe(-VIEWPORT_HEIGHT);
    });

    // The list is inverted: the DOM's far end is the oldest message, so Home has
    // to drive scrollTop up and End down. The deltas are clamped by the scrollTop
    // setter, which is why they only need to be large and finite.
    it('sends Home to the oldest message and End to the newest', () => {
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('Home'), VIEWPORT_HEIGHT))
            .toBe(CHAT_LIST_KEYBOARD_JUMP);
        expect(getInvertedChatListKeyboardScrollDelta(keyboardEvent('End'), VIEWPORT_HEIGHT))
            .toBe(-CHAT_LIST_KEYBOARD_JUMP);
        expect(Number.isFinite(CHAT_LIST_KEYBOARD_JUMP)).toBe(true);
        expect(CHAT_LIST_KEYBOARD_JUMP).toBeGreaterThan(VIEWPORT_HEIGHT);
    });
});
