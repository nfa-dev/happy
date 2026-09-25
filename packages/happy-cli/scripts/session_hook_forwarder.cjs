#!/usr/bin/env node
/**
 * Session Hook Forwarder
 *
 * This script is executed by Claude's hooks (SessionStart, Stop).
 * It reads JSON data from stdin and forwards it to Happy's hook server.
 *
 * Usage: echo '{"session_id":"..."}' | node session_hook_forwarder.cjs <port> [event]
 *   event: session-start (default) → POST /hook/session-start
 *          stop                    → POST /hook/stop
 *   The route is named, not passed as a path: on Windows, Claude runs hook
 *   commands through Git Bash, whose MSYS path conversion would rewrite a
 *   leading-slash argument like /hook/stop into C:\Program Files\Git\hook\stop.
 */

const http = require('http');

const port = parseInt(process.argv[2], 10);
const path = process.argv[3] === 'stop' ? '/hook/stop' : '/hook/session-start';

if (!port || isNaN(port)) {
    process.exit(1);
}

const chunks = [];

process.stdin.on('data', (chunk) => {
    chunks.push(chunk);
});

process.stdin.on('end', () => {
    const body = Buffer.concat(chunks);

    const req = http.request({
        host: '127.0.0.1',
        port: port,
        method: 'POST',
        path: path,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': body.length
        }
    }, (res) => {
        res.resume(); // Drain response
    });

    req.on('error', () => {
        // Silently ignore errors - don't break Claude
    });

    req.end(body);
});

process.stdin.resume();
