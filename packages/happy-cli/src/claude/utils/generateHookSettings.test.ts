import { describe, expect, it } from 'vitest';
import { buildHookSettings } from './generateHookSettings';

describe('buildHookSettings', () => {
    it('points the SessionStart and Stop hooks at the forwarder with their event names', () => {
        const settings = buildHookSettings(4321, '/opt/happy/scripts/session_hook_forwarder.cjs');
        expect(settings.hooks.SessionStart).toEqual([
            {
                matcher: '*',
                hooks: [{ type: 'command', command: 'node "/opt/happy/scripts/session_hook_forwarder.cjs" 4321 session-start' }],
            },
        ]);
        expect(settings.hooks.Stop).toEqual([
            {
                hooks: [{ type: 'command', command: 'node "/opt/happy/scripts/session_hook_forwarder.cjs" 4321 stop' }],
            },
        ]);
    });

    it('never passes a leading-slash path to the forwarder (MSYS would rewrite it on Windows)', () => {
        const settings = buildHookSettings(1, 'fwd.cjs');
        const commands = [...settings.hooks.SessionStart, ...settings.hooks.Stop].flatMap((entry) => entry.hooks.map((hook) => hook.command));
        for (const command of commands) {
            expect(command).not.toMatch(/ \/hook\//);
        }
    });
});
