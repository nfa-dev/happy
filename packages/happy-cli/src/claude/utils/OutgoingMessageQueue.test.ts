import { describe, it, expect } from 'vitest';
import { OutgoingMessageQueue } from './OutgoingMessageQueue';

// The queue hands off between AsyncLock waiters and its own processing with
// setTimeout(0) hops, so "eventually" assertions poll instead of sleeping a
// fixed amount; "not yet" assertions use a short fixed wait.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error('waitUntil: condition not met within ' + timeoutMs + 'ms');
        }
        await sleep(5);
    }
}

function makeQueue() {
    const sent: string[] = [];
    const queue = new OutgoingMessageQueue((message) => {
        sent.push(`msg:${message.uuid}`);
    });
    return { queue, sent };
}

describe('OutgoingMessageQueue', () => {
    it('sends messages in enqueue order', async () => {
        const { queue, sent } = makeQueue();
        queue.enqueue({ type: 'assistant', uuid: 'a1' });
        queue.enqueue({ type: 'user', uuid: 'u1' });
        queue.enqueue({ type: 'assistant', uuid: 'a2' });
        await waitUntil(() => sent.length === 3);
        expect(sent).toEqual(['msg:a1', 'msg:u1', 'msg:a2']);
        queue.destroy();
    });

    it('runs a control item strictly after the messages enqueued before it (turn-end ordering)', async () => {
        const { queue, sent } = makeQueue();
        // Final assistant text of a turn, immediately followed by the result →
        // turn-end. Before enqueueControl the turn-end bypassed the queue and
        // could reach the server first, leaving the text to open a phantom turn.
        queue.enqueue({ type: 'assistant', uuid: 'final-text' });
        queue.enqueueControl(() => sent.push('turn-end'));
        queue.enqueue({ type: 'assistant', uuid: 'next-turn' });
        await waitUntil(() => sent.length === 3);
        expect(sent).toEqual(['msg:final-text', 'turn-end', 'msg:next-turn']);
        queue.destroy();
    });

    it('holds a control item behind a delayed tool call until the tool result releases it', async () => {
        const { queue, sent } = makeQueue();
        queue.enqueue({ type: 'assistant', uuid: 'tool-call' }, { delay: 5_000, toolCallIds: ['call_1'] });
        queue.enqueueControl(() => sent.push('turn-end'));
        await sleep(50);
        expect(sent).toEqual([]);

        await queue.releaseToolCall('call_1');
        await waitUntil(() => sent.length === 2);
        expect(sent).toEqual(['msg:tool-call', 'turn-end']);
        queue.destroy();
    });

    it('holds a control item behind a delayed tool call until the delay expires', async () => {
        const { queue, sent } = makeQueue();
        queue.enqueue({ type: 'assistant', uuid: 'tool-call' }, { delay: 60, toolCallIds: ['call_1'] });
        queue.enqueueControl(() => sent.push('turn-end'));
        await sleep(15);
        expect(sent).toEqual([]);

        await waitUntil(() => sent.length === 2);
        expect(sent).toEqual(['msg:tool-call', 'turn-end']);
        queue.destroy();
    });

    it('flush() releases delayed messages and runs pending control items in order', async () => {
        const { queue, sent } = makeQueue();
        queue.enqueue({ type: 'assistant', uuid: 'tool-call' }, { delay: 60_000, toolCallIds: ['call_1'] });
        queue.enqueue({ type: 'user', uuid: 'interrupted-result' });
        queue.enqueueControl(() => sent.push('turn-end:cancelled'));
        await queue.flush();
        expect(sent).toEqual(['msg:tool-call', 'msg:interrupted-result', 'turn-end:cancelled']);
        queue.destroy();
    });

    it('skips system messages but still runs control items that follow them', async () => {
        const { queue, sent } = makeQueue();
        queue.enqueue({ type: 'system', uuid: 's1' });
        queue.enqueueControl(() => sent.push('control'));
        await waitUntil(() => sent.length === 1);
        expect(sent).toEqual(['control']);
        queue.destroy();
    });

    it('keeps accepting work after destroy() (the launcher reuses one queue across launches)', async () => {
        const { queue, sent } = makeQueue();
        queue.enqueue({ type: 'assistant', uuid: 'a1' });
        queue.enqueueControl(() => sent.push('turn-end'));
        await queue.flush();
        queue.destroy();
        expect(sent).toEqual(['msg:a1', 'turn-end']);

        queue.enqueue({ type: 'assistant', uuid: 'a2' });
        queue.enqueueControl(() => sent.push('turn-end-2'));
        await waitUntil(() => sent.length === 4);
        expect(sent).toEqual(['msg:a1', 'turn-end', 'msg:a2', 'turn-end-2']);
        queue.destroy();
    });
});
