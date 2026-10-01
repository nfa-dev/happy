/**
 * One-time move of Claude multi-account state out of the happy home
 *
 * Earlier builds kept everything multi-account inside ~/.happy: the registry
 * in settings.json (`claudeAccountSwitch`), the account config dirs under
 * ~/.happy/claude-accounts, the usage cache — and the machine-default login's
 * session history, adopted into ~/.happy/claude-shared/projects with
 * ~/.claude/projects left behind as a link to it. `happy auth logout` deletes
 * the happy home, which took every registered Claude login and all Claude
 * Code session history (every project, not only happy's) with it.
 *
 * migrateLegacyAccountLayout() moves that state out, idempotently and under a
 * lock (concurrent session starts race for it):
 *  1. history: ~/.claude/projects becomes a real directory again, holding
 *     what the legacy shared dir held;
 *  2. account dirs: moved under the accounts root, their projects links
 *     re-pointed at ~/.claude/projects. A link is left at each old path so a
 *     claude process already running under it keeps working (logout deletes
 *     such a link without following it). On macOS the keychain login, whose
 *     service name claude derives from the config dir path, is copied to the
 *     new path's service;
 *  3. registry: moved into accounts.json with the config dirs relocated;
 *  4. usage cache: moved along (a copy already at the new root wins).
 * Whatever cannot move yet (a dir in use on Windows, a name already taken at
 * the destination, another volume) stays where it is and is reported; the
 * next run retries it.
 */

import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { withFileLock } from '@/utils/fileLock';
import { LINK_TYPE, isLink, linkProjects, linkTarget, removeLink, samePath } from './dirs';
import {
  accountConfigDir,
  accountsRootDir,
  isWithinDir,
  legacyAccountsRootDir,
  legacySharedProjectsDir,
  moveRegistryToAccountsRoot,
  readAccountRegistry,
  registryFilePath,
  sharedProjectsDir,
} from './registry';
import { KEYCHAIN_ACCOUNT, keychainService, usageCachePath } from './usageCache';

export type AccountLayoutMigration = {
  /** What this run moved out of the happy home, for display */
  moved: string[];
  /** What is still inside the happy home (or otherwise unfinished) and why; the next run retries it */
  pending: string[];
  /** Legacy dirs that still hold data — `happy auth logout` must not delete them */
  keep: string[];
};

/** Where the registry should point an account from now on, or why its dir cannot move yet */
export type AccountDirMove = { configDir: string; moved: boolean } | { pending: string };

export async function migrateLegacyAccountLayout(): Promise<AccountLayoutMigration> {
  const result: AccountLayoutMigration = { moved: [], pending: [], keep: [] };
  try {
    if (!(await legacyLayoutPresent())) {
      return result;
    }
    mkdirSync(accountsRootDir(), { recursive: true });
    await withFileLock(join(accountsRootDir(), '.migrate.lock'), async () => {
      // Re-check under the lock: a concurrent session start may have just finished
      if (await legacyLayoutPresent()) {
        await migrate(result);
      }
    });
  } catch (error) {
    result.pending.push(`migration failed: ${error instanceof Error ? error.message : String(error)}`);
    logger.debug('[accounts] Legacy layout migration failed', error);
  }
  try {
    result.keep = await legacyDirsHoldingData();
  } catch (error) {
    // Can't tell what is left: protect both rather than let logout delete a login
    result.keep = [dirname(legacySharedProjectsDir()), legacyAccountsRootDir()];
    logger.debug('[accounts] Could not inspect the legacy layout', error);
  }
  return result;
}

/** Cheap enough for every session start: is anything of the old layout left? */
async function legacyLayoutPresent(): Promise<boolean> {
  const legacyShared = legacySharedProjectsDir();
  if (lstatSync(legacyShared, { throwIfNoEntry: false }) || pointsAt(sharedProjectsDir(), legacyShared)) {
    return true;
  }
  if (existsSync(join(legacyAccountsRootDir(), 'usage-cache.json')) || (await readSettings()).claudeAccountSwitch !== undefined) {
    return true;
  }
  return (await readAccountRegistry()).accounts.some((account) => {
    const dir = accountConfigDir(account);
    return dir !== null && isWithinDir(dir, legacyAccountsRootDir());
  });
}

async function migrate(result: AccountLayoutMigration): Promise<void> {
  const legacyShared = legacySharedProjectsDir();
  const history = reclaimProjects(sharedProjectsDir(), legacyShared);
  if (history.moved) {
    result.moved.push(`session history → ${sharedProjectsDir()}`);
  }
  if (history.pending) {
    result.pending.push(`session history is still in ${legacyShared}: ${history.pending}`);
  }

  const relocations = new Map<string, string>();
  for (const account of (await readAccountRegistry()).accounts) {
    let dir = accountConfigDir(account);
    if (account.configDir === null || dir === null) {
      continue;
    }
    if (isWithinDir(dir, legacyAccountsRootDir())) {
      const move = moveAccountDir(dir, join(accountsRootDir(), basename(dir)));
      if ('pending' in move) {
        result.pending.push(`account '${account.id}' is still in ${dir}: ${move.pending}`);
        continue;
      }
      // Until the login is reachable under the new path, keep the registry on
      // the old one (now a link) — the next run retries the copy
      const keychainProblem = process.platform === 'darwin' ? copyKeychainLogin(dir, move.configDir) : null;
      if (keychainProblem) {
        result.pending.push(`account '${account.id}' moved to ${move.configDir}, but ${keychainProblem}`);
      } else {
        relocations.set(account.configDir, move.configDir);
      }
      if (move.moved) {
        result.moved.push(`account '${account.id}' → ${move.configDir}`);
      }
      dir = move.configDir;
    }
    try {
      repointProjectsLink(dir, legacyShared);
    } catch (error) {
      result.pending.push(`account '${account.id}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if ((await readSettings()).claudeAccountSwitch !== undefined || relocations.size > 0) {
    const outcome = await moveRegistryToAccountsRoot(configDir => (configDir === null ? null : relocations.get(configDir) ?? configDir));
    if (outcome === 'moved') {
      result.moved.push(`account registry → ${registryFilePath()}`);
    }
  }

  const legacyCache = join(legacyAccountsRootDir(), 'usage-cache.json');
  if (existsSync(legacyCache)) {
    if (existsSync(usageCachePath())) {
      unlinkSync(legacyCache);
    } else {
      renameSync(legacyCache, usageCachePath());
    }
  }

  for (const emptied of [dirname(legacyShared), legacyAccountsRootDir()]) {
    try {
      rmdirSync(emptied); // only succeeds once empty
    } catch {
      // still holds something, or already gone
    }
  }
}

/**
 * Make the default login's projects dir a real directory again, holding what
 * the legacy shared dir held. Covers the adopted layout (a link to the legacy
 * dir), a link left dangling by a logout that deleted the legacy dir, and a
 * partial adoption (entries on both sides). A link pointing anywhere else is
 * the user's own arrangement and stays.
 */
export function reclaimProjects(projectsPath: string, legacyDir: string): { moved: boolean; pending: string | null } {
  const legacyExists = lstatSync(legacyDir, { throwIfNoEntry: false })?.isDirectory() === true;
  if (isLink(projectsPath)) {
    const target = linkTarget(projectsPath);
    if (!samePath(target, legacyDir)) {
      return { moved: false, pending: legacyExists ? `${projectsPath} links to ${target} instead — merge it by hand` : null };
    }
    removeLink(projectsPath);
  }
  if (!legacyExists) {
    mkdirSync(projectsPath, { recursive: true }); // the link dangled: that history is already gone
    return { moved: false, pending: null };
  }
  if (!existsSync(projectsPath)) {
    try {
      mkdirSync(dirname(projectsPath), { recursive: true });
      renameSync(legacyDir, projectsPath);
      return { moved: true, pending: null };
    } catch (error) {
      if (!existsSync(projectsPath)) {
        symlinkSync(legacyDir, projectsPath, LINK_TYPE); // back to the adopted layout until the next run
        return { moved: false, pending: describeMoveFailure(error) };
      }
      // A claude process recreated projectsPath in the gap: merge into it below
    }
  }
  const left = moveEntries(legacyDir, projectsPath);
  return left.length === 0
    ? { moved: true, pending: null }
    : { moved: false, pending: `not merged (same name on both sides, or in use): ${left.join(', ')}` };
}

/**
 * Move one account dir out of the legacy root, leaving a link at the old path
 * for claude processes still running under it.
 */
export function moveAccountDir(oldDir: string, newDir: string): AccountDirMove {
  if (isLink(oldDir)) {
    // Left behind by an earlier run, or made by the user: follow it while it leads somewhere
    const target = linkTarget(oldDir);
    return { configDir: statSync(target, { throwIfNoEntry: false }) ? target : newDir, moved: false };
  }
  if (!existsSync(oldDir)) {
    return { configDir: newDir, moved: false }; // nothing left to move; a fresh login goes to the new root
  }
  if (lstatSync(newDir, { throwIfNoEntry: false })) {
    return { pending: `${newDir} already exists — keep one of the two and delete the other` };
  }
  try {
    mkdirSync(dirname(newDir), { recursive: true });
    renameSync(oldDir, newDir);
  } catch (error) {
    return { pending: describeMoveFailure(error) };
  }
  try {
    symlinkSync(newDir, oldDir, LINK_TYPE);
  } catch (error) {
    logger.debug(`[accounts] Could not leave a link at ${oldDir}`, error);
  }
  return { configDir: newDir, moved: true };
}

/** Re-point an account's projects link that still targets the legacy shared dir */
export function repointProjectsLink(configDir: string, legacyDir: string): void {
  const projectsPath = join(configDir, 'projects');
  if (pointsAt(projectsPath, legacyDir)) {
    removeLink(projectsPath);
    linkProjects(configDir);
  }
}

function pointsAt(linkPath: string, target: string): boolean {
  return isLink(linkPath) && samePath(linkTarget(linkPath), target);
}

/**
 * Move every entry of fromDir into toDir, merging one level down when a
 * project dir exists on both sides, and remove fromDir once empty. Returns
 * the entries left behind (a name taken on both sides, or a failed move).
 */
function moveEntries(fromDir: string, toDir: string): string[] {
  const left: string[] = [];
  for (const entry of readdirSync(fromDir)) {
    const from = join(fromDir, entry);
    const to = join(toDir, entry);
    try {
      if (!lstatSync(to, { throwIfNoEntry: false })) {
        renameSync(from, to);
        continue;
      }
      if (lstatSync(from).isDirectory() && lstatSync(to).isDirectory()) {
        for (const inner of readdirSync(from)) {
          if (!lstatSync(join(to, inner), { throwIfNoEntry: false })) {
            renameSync(join(from, inner), join(to, inner));
          }
        }
        if (readdirSync(from).length === 0) {
          rmdirSync(from);
          continue;
        }
      }
    } catch (error) {
      logger.debug(`[accounts] Could not move ${from} into ${toDir}`, error);
    }
    left.push(entry);
  }
  if (left.length === 0) {
    rmdirSync(fromDir);
  }
  return left;
}

function describeMoveFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EXDEV') {
    return 'it is on a different volume than its destination — move it by hand';
  }
  if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
    return 'in use by a running claude — close claude/happy sessions, then run `happy accounts list`';
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Copy an account's macOS keychain login to the service claude derives from
 * the new config dir path. The old item stays: a claude process still running
 * under the old path keeps refreshing through it. A login already stored for
 * the new path is never overwritten. Returns why the copy failed, or null.
 */
function copyKeychainLogin(fromDir: string, toDir: string): string | null {
  // null = no such item. Anything else (timeout, access denied) throws: a login
  // that merely could not be read must not be mistaken for an absent one.
  const read = (service: string): string | null => {
    try {
      const out = execFileSync('security', ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-w', '-s', service], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      // security prints password data it considers non-printable as hex
      return /^([0-9a-f]{2})+$/i.test(out) ? Buffer.from(out, 'hex').toString('utf8') : out;
    } catch (error) {
      if ((error as { status?: number }).status === 44) {
        return null; // errSecItemNotFound
      }
      throw error;
    }
  };
  try {
    const toService = keychainService(toDir);
    if (read(toService) !== null) {
      return null;
    }
    const secret = read(keychainService(fromDir));
    if (!secret) {
      return null; // no keychain login (file credentials moved with the dir)
    }
    // Via `security -i` on stdin, hex-encoded the way claude writes it, so the token never shows up in argv
    execFileSync('security', ['-i'], {
      input: `add-generic-password -U -a "${KEYCHAIN_ACCOUNT}" -s "${toService}" -X "${Buffer.from(secret, 'utf8').toString('hex')}"\n`,
      timeout: 5000,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    return read(toService) === secret ? null : 'copying its macOS keychain login failed (read-back mismatch)';
  } catch (error) {
    return `copying its macOS keychain login failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Legacy dirs still holding data after a run: history not reclaimed, registered account dirs not moved */
async function legacyDirsHoldingData(): Promise<string[]> {
  const keep: string[] = [];
  if (lstatSync(legacySharedProjectsDir(), { throwIfNoEntry: false })?.isDirectory()) {
    keep.push(dirname(legacySharedProjectsDir()));
  }
  const unmoved = (await readAccountRegistry()).accounts.some((account) => {
    const dir = accountConfigDir(account);
    return dir !== null && isWithinDir(dir, legacyAccountsRootDir()) && !isLink(dir) && existsSync(dir);
  });
  if (unmoved) {
    keep.push(legacyAccountsRootDir());
  }
  return keep;
}
