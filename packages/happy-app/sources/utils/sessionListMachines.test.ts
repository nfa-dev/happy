import { describe, expect, it } from 'vitest';
import {
    collectSessionListMachines,
    createSessionMachineNamer,
    filterSessionListViewDataByMachine,
    hasArchivedSessionsOnMachine,
} from './sessionListMachines';
import type { SessionListViewItem, SessionRowData } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';

function machine(id: string, metadata: Record<string, unknown> | null, active = true): Machine {
    return { id, metadata, active, activeAt: 0, createdAt: 0 } as unknown as Machine;
}

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
        machineId: null,
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

function project(name: string, machineId: string, sessions: SessionRowData[]): SessionListViewItem {
    return {
        type: 'project',
        source: 'happy',
        project: {
            id: `${machineId}:${name}`,
            name,
            machineId,
            workspaces: [{ id: '', name: null, sessions }],
            sessionCount: sessions.length,
            activeCount: sessions.filter((session) => session.active).length,
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

const machines = [
    machine('studio', { host: 'studio.local' }),
    // The same computer, registered again by a daemon with a fresh data directory.
    machine('studio-old', { host: 'studio.local' }, false),
    machine('laptop', { host: 'laptop.local', displayName: 'MacBook' }),
    machine('laptop-agent', {
        host: 'laptop.local',
        displayName: 'laptop.local — Happy Agent',
        machineKind: 'rig',
        rigOnly: true,
        siblingMachineId: 'laptop',
    }),
    machine('blank', null),
];
const nameOf = createSessionMachineNamer(machines);

describe('createSessionMachineNamer', () => {
    it('names a session by its machine: the display name first, then the host', () => {
        expect(nameOf(row({ id: 's', machineId: 'laptop' }))).toBe('MacBook');
        expect(nameOf(row({ id: 's', machineId: 'studio' }))).toBe('studio.local');
    });

    it('gives a Happy Agent session the name of the computer it shares with Happy CLI', () => {
        expect(nameOf(row({ id: 's', machineId: 'laptop-agent', machineName: 'laptop.local — Happy Agent' })))
            .toBe('MacBook');
    });

    it('falls back to the host the session reported once its machine is gone', () => {
        expect(nameOf(row({ id: 's', machineId: 'deleted', machineName: 'old-pc ' }))).toBe('old-pc');
        expect(nameOf(row({ id: 's', machineId: 'blank', machineName: 'build-box' }))).toBe('build-box');
    });

    it('has no name for a session that never said where it runs', () => {
        expect(nameOf(row({ id: 's', machineId: null }))).toBe('');
    });
});

describe('collectSessionListMachines', () => {
    const list: SessionListViewItem[] = [
        { type: 'bots', sessions: [row({ id: 'bot', machineId: 'laptop-agent' })] },
        { type: 'projects-header', source: 'happy' },
        project('happy', 'studio', [row({ id: 'h1', machineId: 'studio' })]),
        project('happy', 'studio-old', [row({ id: 'h2', machineId: 'studio-old' })]),
        { type: 'active-sessions', sessions: [row({ id: 'pc10', machineId: null, machineName: 'pc10' })] },
        { type: 'header', title: 'Yesterday' },
        { type: 'session', session: row({ id: 'pc9', machineName: 'pc9', archived: true }) },
        { type: 'session', session: row({ id: 'nowhere', archived: true }) },
    ];

    it('offers a computer once, however many machine ids it registered under', () => {
        expect(collectSessionListMachines(list, nameOf).filter((name) => name === 'studio.local')).toHaveLength(1);
    });

    it('sorts by name with numbers compared as numbers, and the nameless last', () => {
        expect(collectSessionListMachines(list, nameOf)).toEqual(['MacBook', 'pc9', 'pc10', 'studio.local', '']);
    });
});

describe('filterSessionListViewDataByMachine', () => {
    const list: SessionListViewItem[] = [
        { type: 'bots', sessions: [row({ id: 'bot', machineId: 'laptop-agent' })] },
        { type: 'projects-header', source: 'happy' },
        project('happy', 'studio', [row({ id: 'h1', machineId: 'studio' })]),
        project('happy', 'studio-old', [row({ id: 'h2', machineId: 'studio-old' })]),
        project('notes', 'laptop', [row({ id: 'n1', machineId: 'laptop' })]),
        { type: 'header', title: 'Yesterday' },
        { type: 'session', session: row({ id: 'a1', machineId: 'laptop', archived: true }) },
        { type: 'header', title: 'Last week' },
        { type: 'session', session: row({ id: 'a2', machineId: 'studio-old', archived: true }) },
        { type: 'session', session: row({ id: 'a3', archived: true }) },
    ];

    it('keeps every machine id the computer goes by, and drops headings left empty', () => {
        expect(ids(filterSessionListViewDataByMachine(list, 'studio.local', nameOf))).toEqual([
            'projects-header:happy',
            'h1',
            'h2',
            'header:Last week',
            'a2',
        ]);
    });

    it('counts Happy Agent sessions as the computer they run on', () => {
        expect(ids(filterSessionListViewDataByMachine(list, 'MacBook', nameOf))).toEqual([
            'bot',
            'projects-header:happy',
            'n1',
            'header:Yesterday',
            'a1',
        ]);
    });

    it('narrows to the sessions that never said where they run', () => {
        expect(ids(filterSessionListViewDataByMachine(list, '', nameOf))).toEqual(['header:Last week', 'a3']);
    });

    it('knows which computers have something in the archive', () => {
        expect(hasArchivedSessionsOnMachine(list, 'MacBook', nameOf)).toBe(true);
        expect(hasArchivedSessionsOnMachine(list, 'elsewhere', nameOf)).toBe(false);
    });
});
