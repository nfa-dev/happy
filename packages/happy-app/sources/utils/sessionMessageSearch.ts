import type { Message } from '@/sync/typesMessage';
import { sessionSearchTerms } from './sessionListSearch';

export interface SessionMessageSearchHit {
    /** The chat-level message to open; a match inside a tool's sub-messages opens the tool. */
    messageId: string;
    kind: 'user' | 'agent' | 'tool';
    /** The tool's title or name, for tool hits. */
    toolName: string | null;
    createdAt: number;
    /** The matching text with some context around it, on one line. */
    snippet: string;
}

// Tool inputs can hold whole files; a match that far into one is not worth
// the cost of scanning it on every keystroke.
const MAX_INPUT_TEXT = 4000;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 100;

/**
 * Finds the messages of one session that contain every word of a query, the
 * same words-in-any-order rule the session list search uses.
 *
 * It searches what someone wrote or read in the chat: user messages, agent
 * replies (not their thinking), and a tool call's title, description, name,
 * the strings of its input and its sub-messages. Tool output is left out: it
 * is mostly file contents and command output, and would bury the messages.
 *
 * Hits keep the order of `messages`, so the newest-first chat history gives
 * the latest matches first. `capped` says the limit cut the list short.
 */
export function searchSessionMessages(
    messages: readonly Message[],
    query: string,
    limit: number,
): { hits: SessionMessageSearchHit[]; capped: boolean } {
    const terms = sessionSearchTerms(query);
    const hits: SessionMessageSearchHit[] = [];
    if (terms.length === 0) return { hits, capped: false };

    for (const message of messages) {
        const text = messageSearchText(message).normalize('NFKC');
        if (!text) continue;
        const lower = text.toLowerCase();
        if (!terms.every((term) => lower.includes(term))) continue;
        if (hits.length === limit) return { hits, capped: true };

        const index = Math.min(...terms.map((term) => lower.indexOf(term)));
        const matchLength = terms.find((term) => lower.indexOf(term) === index)!.length;
        hits.push({
            messageId: message.id,
            kind: message.kind === 'user-text' ? 'user' : message.kind === 'tool-call' ? 'tool' : 'agent',
            toolName: message.kind === 'tool-call' ? message.tool.title || message.tool.name : null,
            createdAt: message.createdAt,
            snippet: snippetAround(text, index, matchLength),
        });
    }
    return { hits, capped: false };
}

function messageSearchText(message: Message): string {
    switch (message.kind) {
        case 'user-text':
            return message.displayText ?? message.text;
        case 'agent-text':
            return message.isThinking ? '' : message.text;
        case 'tool-call':
            return [
                message.tool.title,
                message.tool.description,
                message.tool.name,
                ...inputStrings(message.tool.input, 0),
                ...message.children.map(messageSearchText),
            ].filter(Boolean).join('\n');
        case 'agent-event':
            return '';
    }
}

function inputStrings(value: unknown, depth: number): string[] {
    if (typeof value === 'string') return [value.slice(0, MAX_INPUT_TEXT)];
    if (depth >= 2 || value === null || typeof value !== 'object') return [];
    return Object.values(value).flatMap((child) => inputStrings(child, depth + 1));
}

function snippetAround(text: string, index: number, length: number): string {
    const start = Math.max(0, index - SNIPPET_BEFORE);
    const end = Math.min(text.length, index + length + SNIPPET_AFTER);
    const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
    return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}
