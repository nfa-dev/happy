import type { SessionListViewItem, SessionRowData } from '@/sync/storage';
import { filterProjectGroupSessions } from '@/sync/projectGroups';

/**
 * Session search for the home list. A query is matched against a session's
 * title and the names around it: subtitle, working directory, project,
 * worktree, branch, machine, bot handle and model.
 *
 * Every word of the query has to appear, in any order and in any of those
 * fields, but a single word never spans two fields. Matching ignores case and
 * compares NFKC forms, so a path a Mac stored decomposed still matches the
 * composed Hangul a keyboard types.
 */
export function sessionSearchTerms(query: string): string[] {
    return normalizeSearchText(query).split(/\s+/).filter(Boolean);
}

export function sessionMatchesSearch(
    session: SessionRowData,
    terms: readonly string[],
    context: readonly (string | null | undefined)[] = [],
): boolean {
    if (terms.length === 0) return true;
    const text = normalizeSearchText([
        session.name,
        session.subtitle,
        session.path,
        session.projectName,
        session.workspaceName,
        session.gitBranch,
        session.machineName,
        session.botUsername ? `@${session.botUsername}` : null,
        session.identityLine,
        session.modelName,
        ...context,
    ].filter(Boolean).join('\n'));
    return terms.every((term) => text.includes(term));
}

/**
 * The home list narrowed to the sessions a query matches. A project card is
 * matched by its own name and its worktrees' names too.
 *
 * Pass the whole list, archive included. Searching is how people find a chat
 * they archived, so it does not follow the setting that hides the archive.
 */
export function filterSessionListViewData(
    items: readonly SessionListViewItem[],
    query: string,
): SessionListViewItem[] {
    const terms = sessionSearchTerms(query);
    if (terms.length === 0) return [...items];
    return narrowSessionListViewData(items, (session, context) => sessionMatchesSearch(session, terms, context));
}

/**
 * The home list narrowed to the sessions `keep` accepts, in the shape the list
 * already draws: a project card keeps only those sessions, the active and bot
 * groups keep only those rows, a date heading in the archive tail stays only
 * with a row under it, and a projects heading goes once none of its projects
 * is left. A session inside a card is handed the names it inherits from the
 * card, the project's and the worktree's, as `context`.
 *
 * The search and the machine filter both narrow the list through this.
 */
export function narrowSessionListViewData(
    items: readonly SessionListViewItem[],
    keep: (session: SessionRowData, context: readonly (string | null | undefined)[]) => boolean,
): SessionListViewItem[] {
    const projects = new Map<number, SessionListViewItem>();
    const projectSources = new Set<'rig' | 'happy'>();
    for (const [index, item] of items.entries()) {
        if (item.type !== 'project') continue;
        const matched = new Set<string>();
        for (const workspace of item.project.workspaces) {
            for (const session of workspace.sessions) {
                if (keep(session, [item.project.name, workspace.name])) {
                    matched.add(session.id);
                }
            }
        }
        const project = filterProjectGroupSessions(item.project, (session) => matched.has(session.id));
        if (project) {
            projects.set(index, { ...item, project });
            projectSources.add(item.source);
        }
    }

    const result: SessionListViewItem[] = [];
    let pendingHeader: SessionListViewItem | null = null;
    for (const [index, item] of items.entries()) {
        if (item.type === 'header') {
            pendingHeader = item;
            continue;
        }
        if (item.type === 'session') {
            if (!keep(item.session, [])) continue;
            if (pendingHeader) {
                result.push(pendingHeader);
                pendingHeader = null;
            }
            result.push(item);
            continue;
        }
        pendingHeader = null;
        if (item.type === 'projects-header') {
            if (projectSources.has(item.source)) result.push(item);
        } else if (item.type === 'project') {
            const project = projects.get(index);
            if (project) result.push(project);
        } else if (item.type === 'active-sessions' || item.type === 'bots') {
            const sessions = item.sessions.filter((session) => keep(session, []));
            if (sessions.length > 0) result.push({ ...item, sessions });
        }
        // 'project-group' rows are headings with nothing of their own to match.
    }
    return result;
}

function normalizeSearchText(value: string): string {
    return value.normalize('NFKC').toLowerCase();
}
