/**
 * Revision identification for `happy --version` and `happy doctor`.
 *
 * Installed packages: the build step writes dist/build-info.json
 * (scripts/write-build-info.mjs) with the commit the tarball was built from —
 * preferred even in a source checkout, since it describes the dist actually
 * being run. Source runs without a build (tsx) fall back to asking git
 * directly. Neither available → null, display degrades to the bare version.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';

export function describeBuild(): string | null {
  try {
    const info = JSON.parse(readFileSync(join(projectPath(), 'dist', 'build-info.json'), 'utf8'));
    if (typeof info?.commit === 'string' && info.commit.length > 0) {
      const builtAt = typeof info.builtAt === 'string' ? `, built ${info.builtAt}` : '';
      return `rev ${info.commit}${builtAt}`;
    }
  } catch { }
  try {
    const gitAt = (args: string[]) =>
      execFileSync('git', args, { cwd: projectPath(), encoding: 'utf8', windowsHide: true }).trim();
    const commit = gitAt(['rev-parse', '--short', 'HEAD']);
    if (commit) {
      const dirty = gitAt(['status', '--porcelain', '-uno']).length > 0;
      return `rev ${commit}${dirty ? '+dirty' : ''}, source checkout`;
    }
  } catch { }
  return null;
}
