/**
 * Dedicated HTTP server for receiving Claude session hooks
 *
 * This server receives notifications from Claude when sessions change
 * (new session, resume, compact, fork, etc.) via the SessionStart hook, and
 * the Stop hook payload at every turn end — it carries `session_crons`, the
 * scheduled work the claude process holds (see sessionCronRestore.ts).
 *
 * Separate from the MCP server to keep concerns isolated.
 *
 * ## Control Flow
 *
 * ### Startup
 * ```
 * runClaude.ts
 *     │
 *     ├─► startHookServer() ──► HTTP server on random port (e.g., 52290)
 *     │
 *     ├─► generateHookSettingsFile(port) ──► ~/.happy/tmp/hooks/session-hook-<pid>.json
 *     │   (contains SessionStart and Stop hooks pointing to our server)
 *     │
 *     └─► loop() ──► claudeLocal/claudeRemote
 *             │
 *             └─► spawn claude --settings <hook-settings-path>
 * ```
 *
 * ### Session Notification Flow
 * ```
 * Claude CLI (SessionStart event)
 *     │
 *     ├─► Reads hooks from --settings file
 *     │
 *     └─► Executes hook command (session_hook_forwarder.cjs)
 *             │
 *             ├─► Receives session data on stdin
 *             │
 *             └─► HTTP POST to http://127.0.0.1:<port>/hook/session-start
 *                     │
 *                     └─► startHookServer receives it
 *                             │
 *                             └─► onSessionHook(sessionId, data)
 *                                     │
 *                                     ├─► Updates Session.sessionId
 *                                     ├─► Updates API metadata
 *                                     └─► Notifies SessionScanner
 * ```
 * The Stop hook takes the same path with /hook/stop → onStopHook(data).
 * Claude waits for the hook command to exit before it ends the turn, so the
 * payload is in happy's hands before the SDK emits the turn's result.
 *
 * ### Triggered By
 * - `happy` (fresh start) - new session created
 * - `happy --continue` - continues last session (may fork)
 * - `happy --resume` - interactive picker, then resume
 * - `happy --resume <id>` - resume specific session
 * - `/compact` command - compacts and forks session
 * - Double-escape fork - user forks conversation in CLI
 *
 * ### Why Not Use File Watching?
 * File watching has race conditions when multiple Happy processes run.
 * With hooks, Claude directly tells THIS specific process about its session,
 * ensuring 1:1 mapping between Happy process and Claude session.
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import { logger } from '@/ui/logger';

export const SESSION_START_HOOK_PATH = '/hook/session-start';
export const STOP_HOOK_PATH = '/hook/stop';

/**
 * Data received from Claude's SessionStart hook
 */
export interface SessionHookData {
    session_id?: string;
    sessionId?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    source?: string;
    [key: string]: unknown;
}

/** Raw Stop hook payload; the shape is Claude Code's (session_crons, background_tasks, …) */
export type StopHookData = Record<string, unknown>;

export interface HookServerOptions {
    /** Called when a session hook is received with a valid session ID */
    onSessionHook: (sessionId: string, data: SessionHookData) => void;
    /** Called with the Stop hook payload at every turn end */
    onStopHook?: (data: StopHookData) => void;
}

export interface HookServer {
    /** The port the server is listening on */
    port: number;
    /** Stop the server */
    stop: () => void;
}

/**
 * Start a dedicated HTTP server for receiving Claude session hooks
 *
 * @param options - Server options including the hook callbacks
 * @returns Promise resolving to the server instance with port info
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
    const { onSessionHook, onStopHook } = options;

    return new Promise((resolve, reject) => {
        const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
            const route = req.method !== 'POST' ? null
                : req.url === SESSION_START_HOOK_PATH ? 'session-start'
                : req.url === STOP_HOOK_PATH ? 'stop'
                : null;
            if (!route) {
                // 404 for anything else
                res.writeHead(404).end('not found');
                return;
            }

            // Set timeout to prevent hanging if Claude doesn't close stdin
            const timeout = setTimeout(() => {
                if (!res.headersSent) {
                    logger.debug('[hookServer] Request timeout');
                    res.writeHead(408).end('timeout');
                }
            }, 5000);

            try {
                const chunks: Buffer[] = [];
                for await (const chunk of req) {
                    chunks.push(chunk as Buffer);
                }
                clearTimeout(timeout);

                const body = Buffer.concat(chunks).toString('utf-8');
                let data: Record<string, unknown> = {};
                try {
                    const parsed: unknown = JSON.parse(body);
                    if (parsed && typeof parsed === 'object') {
                        data = parsed as Record<string, unknown>;
                    }
                } catch (parseError) {
                    logger.debug(`[hookServer] Failed to parse ${route} hook data as JSON:`, parseError);
                }

                if (route === 'stop') {
                    // Every turn end — keep the log line short, the payload
                    // carries the whole last assistant message.
                    const crons = Array.isArray(data.session_crons) ? data.session_crons.length : 'n/a';
                    logger.debug(`[hookServer] Received stop hook: session_crons=${crons}`);
                    onStopHook?.(data);
                } else {
                    logger.debug('[hookServer] Received session hook:', body);
                    const sessionData = data as SessionHookData;
                    // Support both snake_case (from Claude) and camelCase
                    const sessionId = sessionData.session_id || sessionData.sessionId;
                    if (sessionId) {
                        logger.debug(`[hookServer] Session hook received session ID: ${sessionId}`);
                        onSessionHook(sessionId, sessionData);
                    } else {
                        logger.debug('[hookServer] Session hook received but no session_id found in data');
                    }
                }

                res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
            } catch (error) {
                clearTimeout(timeout);
                logger.debug(`[hookServer] Error handling ${route} hook:`, error);
                if (!res.headersSent) {
                    res.writeHead(500).end('error');
                }
            }
        });

        // Listen on random available port
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                reject(new Error('Failed to get server address'));
                return;
            }

            const port = address.port;
            logger.debug(`[hookServer] Started on port ${port}`);

            resolve({
                port,
                stop: () => {
                    server.close();
                    logger.debug('[hookServer] Stopped');
                }
            });
        });

        server.on('error', (err) => {
            logger.debug('[hookServer] Server error:', err);
            reject(err);
        });
    });
}
