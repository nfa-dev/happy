import { describe, expect, it } from 'vitest';
import { filterSessionListViewData, sessionMatchesSearch, sessionSearchTerms } from './sessionListSearch';
import type { SessionListViewItem, SessionRowData } from '@/sync/storage';

function row(overrides: Partial<SessionRowData> & { id: string }): SessionRowData {
    return {
        name: overrides.id,
        subtitle: '',
        avatarId: overrides.id,
        flavor: null,
        clientId: null,
        identityLine: null,
        providerKind: null,
        modelName: null,
        activitySummary: null,
        gitChangedFiles: null,
        gitCountsExact: true,
        gitDeletions: null,
        gitInsertions: null,
        state: 'waiting',
        createdAt: 0,
        lastActivityAt: 0,
        hasDraft: false,
        active: true,
        archived: false,
        machineId: 'machine',
        machineOffline: false,
        path: null,
        homeDir: null,
        completedTodosCount: 0,
        totalTodosCount: 0,
        hasUnread: false,
        projectId: null,
        projectName: null,
        workspaceId: null,
        workspaceName: null,
        ...overrides,
    };
}

function project(
    name: string,
    workspaces: { id: string; name: string | null; sessions: SessionRowData[] }[],
): SessionListViewItem {
    return {
        type: 'project',
        source: 'happy',
        project: {
            id: name,
            name,
            machineId: 'machine',
            workspaces,
            sessionCount: workspaces.reduce((total, w) => total + w.sessions.length, 0),
            activeCount: workspaces.reduce((total, w) => total + w.sessions.filter((s) => s.active).length, 0),
        },
    };
}

const ids = (items: SessionListViewItem[]): string[] => items.flatMap((item) => {
    switch (item.type) {
        case 'session': return [item.session.id];
        case 'bots':
        case 'active-sessions': return item.sessions.map((session) => session.id);
        case 'project': return item.project.workspaces.flatMap((w) => w.sessions.map((s) => s.id));
        case 'header': return [`header:${item.title}`];
        case 'projects-header': return [`projects-header:${item.source}`];
        default: return [];
    }
});

describe('sessionMatchesSearch', () => {
    it('needs every word, in any order and in any field, ignoring case', () => {
        const session = row({ id: 's', name: 'Fix login on Mac', path: '/Users/me/happy', gitBranch: 'pages' });
        expect(sessionMatchesSearch(session, sessionSearchTerms('mac LOGIN'))).toBe(true);
        expect(sessionMatchesSearch(session, sessionSearchTerms('happy pages'))).toBe(true);
        expect(sessionMatchesSearch(session, sessionSearchTerms('login windows'))).toBe(false);
    });

    it('never lets one word run across two fields', () => {
        const session = row({ id: 's', name: 'deploy', path: '/srv/web' });
        expect(sessionMatchesSearch(session, sessionSearchTerms('deploy/srv'))).toBe(false);
    });

    it('finds a decomposed Hangul path with the composed text a keyboard types', () => {
        const session = row({ id: 's', path: '/Users/me/검색'.normalize('NFD') });
        expect(sessionMatchesSearch(session, sessionSearchTerms('검색'))).toBe(true);
    });

    it('matches names the session inherits from its card', () => {
        const session = row({ id: 's', name: 'untitled' });
        expect(sessionMatchesSearch(session, sessionSearchTerms('billing'), ['billing-service'])).toBe(true);
    });
});

describe('filterSessionListViewData', () => {
    const list: SessionListViewItem[] = [
        { type: 'projects-header', source: 'happy' },
        project('happy', [
            { id: '', name: null, sessions: [row({ id: 'h1', name: 'search box' }), row({ id: 'h2', name: 'publish script' })] },
            { id: '/w/feat', name: 'feat-search', sessions: [row({ id: 'h3', name: 'tests' })] },
        ]),
        project('albo', [{ id: '', name: null, sessions: [row({ id: 'a1', name: 'board' })] }]),
        { type: 'active-sessions', sessions: [row({ id: 'act1', name: 'search index' }), row({ id: 'act2', name: 'other' })] },
        { type: 'bots', sessions: [row({ id: 'bot1', botId: 'b', botUsername: 'searcher' })] },
        { type: 'header', title: 'Yesterday' },
        { type: 'session', session: row({ id: 'arch1', name: 'old search', archived: true }) },
        { type: 'header', title: 'Last week' },
        { type: 'session', session: row({ id: 'arch2', name: 'unrelated', archived: true }) },
    ];

    it('returns the list as it is for an empty query', () => {
        expect(filterSessionListViewData(list, '   ')).toEqual(list);
    });

    it('keeps only matching rows and the headings that still have rows under them', () => {
        expect(ids(filterSessionListViewData(list, 'search'))).toEqual([
            'projects-header:happy',
            'h1',
            'h3',
            'act1',
            'bot1',
            'header:Yesterday',
            'arch1',
        ]);
    });

    it('narrows a project card and recounts it', () => {
        const [, happy] = filterSessionListViewData(list, 'publish');
        expect(happy.type === 'project' && happy.project).toMatchObject({ sessionCount: 1, activeCount: 1 });
        expect(ids([happy])).toEqual(['h2']);
    });

    it('matches every session of a project searched by its name', () => {
        expect(ids(filterSessionListViewData(list, 'albo'))).toEqual(['projects-header:happy', 'a1']);
    });

    it('drops the projects heading once no project is left', () => {
        expect(ids(filterSessionListViewData(list, 'unrelated'))).toEqual(['header:Last week', 'arch2']);
    });
});
