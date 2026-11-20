import * as React from 'react';
import { Platform, type GestureResponderEvent, type ViewStyle } from 'react-native';
import type { SessionActionsAnchor } from '@/components/SessionActionsPopover';
import { useSessionActionAlert, type UseSessionQuickActionsOptions } from '@/hooks/useSessionQuickActions';

/**
 * A finger, not a mouse, is the screen's main pointer: phones and tablets, but
 * not a laptop that also has a touchscreen. The composer asks the same
 * question to tell an on-screen keyboard's Enter from a hardware one.
 */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/** One live query for every row; `matches` follows the device as it changes. */
let coarsePointerQuery: MediaQueryList | null | undefined;

function getCoarsePointerQuery(): MediaQueryList | null {
    if (coarsePointerQuery === undefined) {
        coarsePointerQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(COARSE_POINTER_QUERY)
            : null;
    }
    return coarsePointerQuery;
}

function subscribeToCoarsePointer(onChange: () => void): () => void {
    const query = getCoarsePointerQuery();
    query?.addEventListener('change', onChange);
    return () => query?.removeEventListener('change', onChange);
}

function readCoarsePointer(): boolean {
    return getCoarsePointerQuery()?.matches ?? false;
}

const subscribeToNothing = () => () => { };
const readFalse = () => false;

/** Always false off the web, where a long press already has its own menu. */
function useTouchFirstWebScreen(): boolean {
    const web = Platform.OS === 'web';
    return React.useSyncExternalStore(
        web ? subscribeToCoarsePointer : subscribeToNothing,
        web ? readCoarsePointer : readFalse,
        readFalse,
    );
}

/**
 * For the row a finger is holding. iOS starts a text selection under a still
 * finger at about the moment the long press is due, and react-native-web ends
 * the press as soon as the selection changes, so the menu would never open.
 * The callout is the sheet iOS raises for the avatar's image.
 */
const TOUCH_MENU_PRESSABLE_STYLE = {
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
} as unknown as ViewStyle;

/**
 * The finger that opened the menu is still down when the menu appears, and the
 * menu's backdrop now lies under it. Cancelling that finger's touchend stops a
 * browser from turning the lift into a click on the backdrop, which would close
 * the menu as it opened, or on whichever item the lift landed on.
 */
function swallowLiftOfHeldFinger() {
    const swallow = (event: TouchEvent) => {
        if (event.cancelable) {
            event.preventDefault();
        }
        stop();
    };
    const stop = () => {
        window.removeEventListener('touchend', swallow, true);
        window.removeEventListener('touchcancel', stop, true);
    };
    window.addEventListener('touchend', swallow, { capture: true, passive: false });
    window.addEventListener('touchcancel', stop, true);
}

export interface SessionActionsMenuPopoverProps {
    anchor: SessionActionsAnchor | null;
    visible: boolean;
    onClose: () => void;
    openedByTouch: boolean;
}

/**
 * How a session row or tab opens its actions, Archive among them.
 *
 * Native keeps the long press that shows the action sheet. The web opens the
 * same actions as a popover on a right click, which phones and tablets do not
 * have, and iOS Safari never turns a long press into a `contextmenu` event. So
 * on a touch-first screen a long press opens the popover too, beside the row
 * instead of under the finger.
 *
 * The long press is wired on touch-first screens only. Once `onLongPress` is
 * set, react-native-web reads any press held past half a second as a long press
 * and swallows its click, so on a laptop a slow click would stop opening the
 * chat.
 *
 * Spread `menuProps` onto the row's Pressable, add `pressableStyle` to its
 * style, and hand `popoverProps` to its `SessionActionsPopover`.
 */
export function useSessionActionsMenu(sessionId: string, options: UseSessionQuickActionsOptions = {}) {
    const showActionAlert = useSessionActionAlert(sessionId, options);
    const touchFirst = useTouchFirstWebScreen();
    const [anchor, setAnchor] = React.useState<SessionActionsAnchor | null>(null);
    const [openedByTouch, setOpenedByTouch] = React.useState(false);

    const handleContextMenu = React.useCallback((event: any) => {
        // Android browsers send contextmenu for a long press as well. With
        // onLongPress set, react-native-web's Pressable cancels that event
        // before this handler runs and the long press opens the menu; opening
        // it here too would pin it under the finger.
        if (event.defaultPrevented || event.nativeEvent?.defaultPrevented) {
            return;
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        setOpenedByTouch(false);
        setAnchor({
            type: 'point',
            x: event.nativeEvent?.clientX ?? event.nativeEvent?.pageX ?? 0,
            y: event.nativeEvent?.clientY ?? event.nativeEvent?.pageY ?? 0,
        });
    }, []);

    const handleLongPress = React.useCallback((event: GestureResponderEvent) => {
        const native = event.nativeEvent as GestureResponderEvent['nativeEvent'] & { type?: string };
        const touch = native.type === 'touchstart';
        if (touch) {
            swallowLiftOfHeldFinger();
        }
        // The row the press began on. Docking the menu to it keeps the finger,
        // which is somewhere on that row, clear of the menu.
        const node = event.currentTarget as unknown as Element | null;
        const rect = node && typeof node.getBoundingClientRect === 'function'
            ? node.getBoundingClientRect()
            : null;
        setOpenedByTouch(touch);
        setAnchor(rect
            ? { type: 'rect', x: rect.left, y: rect.top, width: rect.width, height: rect.height }
            : { type: 'point', x: native.pageX, y: native.pageY });
    }, []);

    const closeMenu = React.useCallback(() => setAnchor(null), []);

    const menuProps: Record<string, unknown> = Platform.OS !== 'web'
        ? { onLongPress: showActionAlert }
        : touchFirst
            ? { onContextMenu: handleContextMenu, onLongPress: handleLongPress }
            : { onContextMenu: handleContextMenu };

    const popoverProps: SessionActionsMenuPopoverProps = {
        anchor,
        visible: anchor !== null,
        onClose: closeMenu,
        openedByTouch,
    };

    return {
        menuProps,
        pressableStyle: touchFirst ? TOUCH_MENU_PRESSABLE_STYLE : undefined,
        popoverProps,
    };
}
