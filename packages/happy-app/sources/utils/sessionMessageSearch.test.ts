import { describe, expect, it } from 'vitest';
import { searchSessionMessages } from './sessionMessageSearch';
import type { Message, ToolCall } from '@/sync/typesMessage';

function user(id: string, text: string, createdAt = 0): Message {
    return { kind: 'user-text', id, localId: null, createdAt, text };
}

function agent(id: string, text: string, isThinking = false): Message {
    return { kind: 'agent-text', id, localId: null, createdAt: 0, text, isThinking };
}

function tool(id: string, overrides: Partial<ToolCall>, children: Message[] = []): Message {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 0,
        tool: {
            name: 'Bash',
            state: 'completed',
            input: {},
            createdAt: 0,
            startedAt: null,
            completedAt: null,
            description: null,
            ...overrides,
        },
        children,
    };
}

const ids = (result: ReturnType<typeof searchSessionMessages>) => result.hits.map((hit) => hit.messageId);

describe('searchSessionMessages', () => {
    const messages: Message[] = [
        user('u2', 'Can you add a search box to the sidebar?', 2),
        agent('a2', 'I added the Search field above the session list.'),
        agent('think', 'thinking about search', true),
        tool('t1', { name: 'Edit', title: 'Edit SidebarView.tsx', input: { file_path: '/app/SidebarView.tsx', new_string: 'search' } }),
        tool('t2', { name: 'Task', input: { prompt: 'review' } }, [agent('child', 'the search hook looks fine')]),
        tool('t3', { name: 'Read', input: {}, result: 'search inside output only' }),
        { kind: 'agent-event', id: 'e1', createdAt: 0, event: { type: 'message', message: 'search mode on' } },
        user('u1', '검색 기능 추가', 1),
    ];

    it('finds nothing for a blank query', () => {
        expect(searchSessionMessages(messages, '  ', 50)).toEqual({ hits: [], capped: false });
    });

    it('searches messages, tool fields and sub-messages but not thinking or tool output', () => {
        expect(ids(searchSessionMessages(messages, 'SEARCH', 50))).toEqual(['u2', 'a2', 't1', 't2']);
    });

    it('needs every word of the query in the same message', () => {
        expect(ids(searchSessionMessages(messages, 'sidebar box', 50))).toEqual(['u2']);
        expect(ids(searchSessionMessages(messages, '기능 검색', 50))).toEqual(['u1']);
    });

    it('labels hits and opens a sub-message match through its tool', () => {
        const [hit] = searchSessionMessages(messages, 'hook', 50).hits;
        expect(hit).toMatchObject({ messageId: 't2', kind: 'tool', toolName: 'Task' });
    });

    it('cuts long text down to the match with ellipses on one line', () => {
        const long = `${'a '.repeat(80)}needle\n${'b '.repeat(80)}`;
        const [hit] = searchSessionMessages([user('long', long)], 'needle', 50).hits;
        expect(hit.snippet.startsWith('…')).toBe(true);
        expect(hit.snippet.endsWith('…')).toBe(true);
        expect(hit.snippet).toContain('needle b');
        expect(hit.snippet).not.toContain('\n');
    });

    it('stops at the limit and says so', () => {
        const result = searchSessionMessages(messages, 'search', 2);
        expect(ids(result)).toEqual(['u2', 'a2']);
        expect(result.capped).toBe(true);
    });
});
