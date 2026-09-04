#!/usr/bin/env node

/**
 * Write dist/build-info.json after pkgroll — the npm tarball carries no git
 * metadata, so this records the commit it was built from for `happy --version`
 * and `happy doctor`. Tolerates a missing git repo (fields become null).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim() || null;
  } catch {
    return null;
  }
}

const commit = git(['rev-parse', '--short', 'HEAD']);
const dirty = commit != null && git(['status', '--porcelain', '-uno']) != null;
const info = {
  commit: commit ? commit + (dirty ? '+dirty' : '') : null,
  commitDate: git(['log', '-1', '--format=%cI']),
  builtAt: new Date().toISOString(),
};

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
console.log(`build-info: ${info.commit ?? 'no git metadata'} (built ${info.builtAt})`);
