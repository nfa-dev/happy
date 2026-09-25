/**
 * Generate temporary settings file with Claude hooks for session tracking
 *
 * Creates a settings.json file that configures Claude's hooks to notify our
 * HTTP server: SessionStart when sessions change (new session, resume,
 * compact, etc.) and Stop at every turn end, whose payload lists the
 * session-scoped cron tasks the claude process holds (sessionCronRestore.ts).
 */

import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

export interface HookSettings {
    hooks: {
        SessionStart: Array<{ matcher: string; hooks: Array<{ type: 'command'; command: string }> }>;
        Stop: Array<{ hooks: Array<{ type: 'command'; command: string }> }>;
    };
}

/**
 * Settings content: every hook runs the forwarder against the hook server's
 * port. The forwarder gets the event as a bare name, never as a URL path — on
 * Windows the hook command runs under Git Bash, whose MSYS path conversion
 * rewrites a leading-slash argument (`/hook/stop`) into a Windows path.
 */
export function buildHookSettings(port: number, forwarderScript: string): HookSettings {
    const command = (event: 'session-start' | 'stop') => `node "${forwarderScript}" ${port} ${event}`;
    return {
        hooks: {
            SessionStart: [
                {
                    matcher: '*',
                    hooks: [{ type: 'command', command: command('session-start') }],
                },
            ],
            Stop: [
                {
                    hooks: [{ type: 'command', command: command('stop') }],
                },
            ],
        },
    };
}

/**
 * Generate a temporary settings file with the hook configuration
 *
 * @param port - The port where Happy server is listening
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const settings = buildHookSettings(port, forwarderScript);

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 *
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}
