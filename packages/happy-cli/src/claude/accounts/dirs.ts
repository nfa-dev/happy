/**
 * Claude account directory infrastructure
 *
 * Each registered account gets its own config directory under the accounts
 * root (~/.claude-accounts/<id>, see registry.ts). Session history must
 * survive account switches (`claude --resume` reads <configDir>/projects), so
 * every account's projects directory is a link to the machine-default login's
 * own projects dir (~/.claude/projects), which stays a real directory. On
 * Windows the link is a directory junction (no admin rights needed),
 * elsewhere a symlink. Deleting an account dir, or the whole accounts root,
 * removes the link and never the history behind it.
 *
 * Everything else claude reads from a config dir at user scope — MCP
 * registrations (.claude.json), settings.json with its hooks, CLAUDE.md,
 * rules/ and skills/ — is synced one way from the default login into each
 * account dir (syncMcpServersToAccountDir, syncUserConfigToAccountDir).
 */

import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { logger } from '@/ui/logger';
import {
  accountConfigDir,
  defaultClaudeConfigDir,
  expandHome,
  isHappyManagedConfigDir,
  sharedProjectsDir,
} from './registry';
import type { ClaudeAccount } from './types';

export const LINK_TYPE = 'junction'; // only honored on Windows; ignored on POSIX

export function isLink(path: string): boolean {
  try {
    const stats = lstatSync(path);
    // Windows junctions report as symbolic links through lstat
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Absolute path a link points at (a relative symlink resolves against the link's own dir) */
export function linkTarget(path: string): string {
  return resolve(dirname(path), readlinkSync(path));
}

export function ensureSharedProjectsDir(): string {
  const shared = sharedProjectsDir();
  mkdirSync(shared, { recursive: true });
  return shared;
}

/**
 * Link <configDir>/projects → shared projects dir. A live link is kept
 * wherever it points; a dangling one is re-pointed. Throws if a real
 * (non-link) projects directory is in the way — it may hold history that a
 * link must not hide.
 */
export function linkProjects(configDir: string): void {
  const projectsPath = join(configDir, 'projects');
  if (isLink(projectsPath)) {
    // stat, not existsSync: on Windows existsSync reports a dangling junction as present
    if (statSync(projectsPath, { throwIfNoEntry: false })) {
      return;
    }
    removeLink(projectsPath);
  } else if (existsSync(projectsPath)) {
    throw new Error(`${projectsPath} exists and is not a link`);
  }
  symlinkSync(ensureSharedProjectsDir(), projectsPath, LINK_TYPE);
}

/**
 * Seed a fresh account config dir so claude's first run in it doesn't stop at
 * interactive onboarding. Merges over an existing .claude.json if present.
 */
function seedClaudeJson(configDir: string): void {
  const claudeJsonPath = join(configDir, '.claude.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(claudeJsonPath)) {
    try {
      existing = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
    } catch {
      // corrupt file: claude will regenerate; don't make it worse
      return;
    }
  }
  if (existing.hasCompletedOnboarding === true) {
    return;
  }
  writeFileSync(claudeJsonPath, JSON.stringify({ ...existing, hasCompletedOnboarding: true }, null, 2));
}

/** Create (or repair) a registered account's config directory */
export function ensureAccountDir(configDir: string): void {
  mkdirSync(configDir, { recursive: true });
  seedClaudeJson(configDir);
  linkProjects(configDir);
  syncMcpServersToAccountDir(configDir);
  try {
    syncUserConfigToAccountDir(configDir);
  } catch (e) {
    logger.debug(`[accounts] User config sync into ${configDir} failed (continuing)`, e);
  }
}

/**
 * Where the machine-default login keeps its .claude.json. With no
 * CLAUDE_CONFIG_DIR claude stores it at ~/.claude.json (home root, NOT inside
 * ~/.claude); with a user-provided config dir it lives inside that dir.
 */
function machineDefaultClaudeJsonPath(): string {
  const dir = defaultClaudeConfigDir();
  return dir === join(homedir(), '.claude') ? join(homedir(), '.claude.json') : join(dir, '.claude.json');
}

/**
 * One-way sync of MCP registrations from the machine-default .claude.json
 * into an account's config dir. Claude resolves user-scope mcpServers (and
 * project-local ones) from $CLAUDE_CONFIG_DIR/.claude.json, so without this a
 * switched-to account sees no MCP servers at all. The default login is the
 * source of truth: manage MCPs there (`claude mcp add` with no
 * CLAUDE_CONFIG_DIR) — account-local edits are overwritten on the next sync.
 * Exported for tests via the explicit-path variant below.
 */
export function syncMcpServersToAccountDir(configDir: string): boolean {
  return syncMcpServers(machineDefaultClaudeJsonPath(), join(configDir, '.claude.json'));
}

export function syncMcpServers(sourcePath: string, targetPath: string): boolean {
  let source: Record<string, any>;
  try {
    source = JSON.parse(readFileSync(sourcePath, 'utf8'));
  } catch {
    return false; // no default login config (or unreadable) — nothing to sync
  }
  let target: Record<string, any> = {};
  if (existsSync(targetPath)) {
    try {
      target = JSON.parse(readFileSync(targetPath, 'utf8'));
    } catch {
      return false; // don't clobber a file claude may be mid-rewrite on
    }
  }
  const before = JSON.stringify({ mcpServers: target.mcpServers, projects: target.projects });

  // User-scope servers: wholesale replace (default login is the source of truth)
  target.mcpServers = source.mcpServers && typeof source.mcpServers === 'object' ? source.mcpServers : {};

  // Project-local servers + their .mcp.json approval state. Only projects that
  // actually carry MCP config are touched; the rest of the target's project
  // state (history, trust of unrelated projects) is left alone.
  if (source.projects && typeof source.projects === 'object') {
    for (const [projectPath, project] of Object.entries<Record<string, any>>(source.projects)) {
      if (!project || typeof project !== 'object') continue;
      const hasMcpConfig = (project.mcpServers && Object.keys(project.mcpServers).length > 0)
        || (Array.isArray(project.enabledMcpjsonServers) && project.enabledMcpjsonServers.length > 0)
        || (Array.isArray(project.disabledMcpjsonServers) && project.disabledMcpjsonServers.length > 0);
      if (!hasMcpConfig) continue;
      target.projects = target.projects && typeof target.projects === 'object' ? target.projects : {};
      const existing = target.projects[projectPath] && typeof target.projects[projectPath] === 'object'
        ? target.projects[projectPath]
        : {};
      target.projects[projectPath] = {
        ...existing,
        ...(project.mcpServers !== undefined ? { mcpServers: project.mcpServers } : {}),
        ...(project.enabledMcpjsonServers !== undefined ? { enabledMcpjsonServers: project.enabledMcpjsonServers } : {}),
        ...(project.disabledMcpjsonServers !== undefined ? { disabledMcpjsonServers: project.disabledMcpjsonServers } : {}),
        ...(project.hasTrustDialogAccepted !== undefined && existing.hasTrustDialogAccepted === undefined
          ? { hasTrustDialogAccepted: project.hasTrustDialogAccepted }
          : {}),
      };
    }
  }

  if (JSON.stringify({ mcpServers: target.mcpServers, projects: target.projects }) === before) {
    return false;
  }
  writeFileSync(targetPath, JSON.stringify(target, null, 2));
  logger.debug(`[accounts] Synced MCP servers into ${targetPath}`);
  return true;
}

export type UserFileCopyResult = 'written' | 'unchanged' | 'absent';
export type UserDirLinkResult = 'linked' | 'kept' | 'skipped' | 'absent';

export interface UserConfigSyncResult {
  settings: UserFileCopyResult;
  claudeMd: UserFileCopyResult;
  rules: UserDirLinkResult;
  skills: UserDirLinkResult;
}

export function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const full = resolve(expandHome(p)).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? full.toLowerCase() : full;
  };
  return normalize(a) === normalize(b);
}

/**
 * Which dirs the user-config sync may write into: only account dirs happy
 * created itself, and never the default login (the source) — copying it onto
 * itself or linking rules/ to rules/ must be impossible however the env looks.
 */
export function isUserConfigSyncTarget(configDir: string, defaultDir: string = defaultClaudeConfigDir()): boolean {
  return !samePath(configDir, defaultDir) && isHappyManagedConfigDir(configDir);
}

/**
 * One-way sync of the rest of the user-scope config into an account dir.
 * Claude reads settings.json (hooks, model, theme…), CLAUDE.md, rules/ and
 * skills/ from $CLAUDE_CONFIG_DIR, so an account dir holding only credentials
 * runs with no hooks, no global instructions and no user skills. Same contract
 * as the MCP sync: the default login is the source of truth and account-local
 * edits are overwritten on the next sync. Files are copied; rules/ and skills/
 * become links to the default login's paths (not their resolved targets), so
 * an account keeps following the default login even when that side is itself
 * a link. Returns null when the dir is not a sync target.
 */
export function syncUserConfigToAccountDir(configDir: string): UserConfigSyncResult | null {
  const defaultDir = defaultClaudeConfigDir();
  if (!isUserConfigSyncTarget(configDir, defaultDir)) {
    logger.debug(`[accounts] User config sync skipped for ${configDir} (default login or not a happy-managed dir)`);
    return null;
  }
  const result = syncUserConfig(defaultDir, configDir);
  logger.debug(
    `[accounts] Synced user config into ${configDir}: settings=${result.settings}, claudeMd=${result.claudeMd}, rules=${result.rules}, skills=${result.skills}`
  );
  return result;
}

/** Explicit-path variant of syncUserConfigToAccountDir without the target guard — for tests */
export function syncUserConfig(sourceDir: string, targetDir: string): UserConfigSyncResult {
  mkdirSync(targetDir, { recursive: true });
  return {
    settings: copyUserFile(sourceDir, targetDir, 'settings.json'),
    claudeMd: copyUserFile(sourceDir, targetDir, 'CLAUDE.md'),
    rules: linkUserDir(sourceDir, targetDir, 'rules'),
    skills: linkUserDir(sourceDir, targetDir, 'skills'),
  };
}

/**
 * Copy <source>/<name> over <target>/<name> when the bytes differ. Written via
 * a temp file + rename so a claude process reading mid-sync never sees a
 * partial file. A missing source leaves the target alone.
 */
function copyUserFile(sourceDir: string, targetDir: string, name: string): UserFileCopyResult {
  let content: Buffer;
  try {
    content = readFileSync(join(sourceDir, name));
  } catch {
    return 'absent';
  }
  const targetPath = join(targetDir, name);
  try {
    if (readFileSync(targetPath).equals(content)) {
      return 'unchanged';
    }
  } catch {
    // no readable target yet — write it
  }
  const tmpPath = `${targetPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, content);
  try {
    renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best effort: don't mask the rename failure
    }
    throw error;
  }
  return 'written';
}

/**
 * Link <target>/<name> → <source>/<name>. Only a missing entry, an empty real
 * directory or a dangling link is (re)linked: a live link is kept wherever it
 * points, and a real directory with content is never touched — it may hold
 * things the user put into the account deliberately.
 */
function linkUserDir(sourceDir: string, targetDir: string, name: string): UserDirLinkResult {
  const sourcePath = join(sourceDir, name);
  // stat follows links, so a dangling link on the default side counts as absent
  if (!statSync(sourcePath, { throwIfNoEntry: false })?.isDirectory()) {
    return 'absent';
  }
  const targetPath = join(targetDir, name);
  const existing = lstatSync(targetPath, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink()) {
    // Live link → keep wherever it points. Checked with stat, not existsSync:
    // on Windows existsSync uses GetFileAttributes, which does not follow a
    // junction and so reports a dangling one as present.
    if (statSync(targetPath, { throwIfNoEntry: false })) {
      return 'kept';
    }
    removeLink(targetPath); // dangling — re-point at the default login
  } else if (existing?.isDirectory() && readdirSync(targetPath).length === 0) {
    rmdirSync(targetPath);
  } else if (existing) {
    return 'skipped';
  }
  symlinkSync(sourcePath, targetPath, LINK_TYPE);
  return 'linked';
}

/** Remove a link without touching its target (a Windows junction may need rmdir where unlink refuses) */
export function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

/**
 * Repair missing or dangling projects links of registered accounts and report
 * what cannot be repaired. The default login needs no link: its own projects
 * dir is the shared history (a link left there by the old in-happy-home
 * layout is migrate.ts's business).
 */
export function verifyAccountLinks(accounts: ClaudeAccount[]): string[] {
  const problems: string[] = [];
  for (const account of accounts) {
    const dir = accountConfigDir(account);
    if (!dir || !existsSync(dir)) {
      continue;
    }
    try {
      linkProjects(dir);
    } catch (error) {
      problems.push(`${account.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}
