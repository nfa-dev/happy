import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { startHookServer } from './startHookServer';

function post(port: number, path: string, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path,
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            },
            (res) => {
                res.resume();
                res.on('end', () => resolve(res.statusCode ?? 0));
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

describe('startHookServer', () => {
    it('routes SessionStart and Stop payloads to their callbacks', async () => {
        const sessions: string[] = [];
        const stops: unknown[] = [];
        const server = await startHookServer({
            onSessionHook: (sessionId) => sessions.push(sessionId),
            onStopHook: (data) => stops.push(data),
        });
        try {
            expect(await post(server.port, '/hook/session-start', JSON.stringify({ session_id: 'abc', hook_event_name: 'SessionStart' }))).toBe(200);
            expect(await post(server.port, '/hook/stop', JSON.stringify({ hook_event_name: 'Stop', session_crons: [] }))).toBe(200);
            expect(await post(server.port, '/hook/other', '{}')).toBe(404);
        } finally {
            server.stop();
        }
        expect(sessions).toEqual(['abc']);
        expect(stops).toEqual([{ hook_event_name: 'Stop', session_crons: [] }]);
    });

    it('answers a Stop hook with 200 even when nobody listens or the body is not JSON', async () => {
        const server = await startHookServer({ onSessionHook: () => {} });
        try {
            expect(await post(server.port, '/hook/stop', 'not json')).toBe(200);
            expect(await post(server.port, '/hook/stop', 'null')).toBe(200);
        } finally {
            server.stop();
        }
    });
});
