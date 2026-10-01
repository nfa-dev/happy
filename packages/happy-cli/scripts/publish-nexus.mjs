#!/usr/bin/env node

/**
 * Publish this package to the internal Nexus npm repository
 * (npm-release by default, npm-snapshot with --snapshot).
 *
 * The npm format on Nexus refuses `publish` over an existing version even
 * with an "allow redeploy" policy, so this script first deletes the component
 * of the version being published via the Nexus REST API (other versions
 * stay), then publishes the fresh tarball with `--tag latest` (mandatory for
 * prerelease versions like 1.2.0-navercorp). Installs should name the
 * version: npm-group merges this `latest` with the public npm one, and a
 * newer upstream release takes it over:
 *
 *   npm i -g happy@<version> --registry http://<nexus>/repository/npm-group/
 *
 * NEXUS_BASE_URL is required: the Nexus base URL, e.g. http://nexus.example.com.
 * NEXUS_REPO overrides the target repository.
 *
 * Usage:
 *   pnpm run publish:nexus              # build + pack + delete + publish (npm-release)
 *   pnpm run publish:nexus --snapshot   # target npm-snapshot instead
 *   pnpm run publish:nexus --with-wire  # also republish @slopus/happy-wire
 *   pnpm run publish:nexus --skip-build # pack current dist as-is
 *
 * Auth (deploy only — installs are anonymous):
 *   1. NEXUS_NPM_AUTH env var as "user:password", or
 *   2. an `//<host>/repository/<target repo>/:_auth=<base64>` line in ~/.npmrc
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NEXUS_BASE = process.env.NEXUS_BASE_URL;
if (!NEXUS_BASE) {
  console.error('✗ NEXUS_BASE_URL is not set — the Nexus base URL, e.g. http://nexus.example.com');
  process.exit(1);
}
const useSnapshot = process.argv.includes('--snapshot');
const TARGET_REPO = process.env.NEXUS_REPO || (useSnapshot ? 'npm-snapshot' : 'npm-release');
const TARGET_URL = `${NEXUS_BASE}/repository/${TARGET_REPO}/`;
const GROUP_URL = `${NEXUS_BASE}/repository/npm-group/`;

const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wireDir = resolve(cliDir, '..', 'happy-wire');
const withWire = process.argv.includes('--with-wire');
const skipBuild = process.argv.includes('--skip-build');

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    console.error(`\n✗ Failed: ${command} ${args.join(' ')} (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

function resolveAuthBase64() {
  if (process.env.NEXUS_NPM_AUTH) {
    return Buffer.from(process.env.NEXUS_NPM_AUTH).toString('base64');
  }
  const npmrcPath = join(homedir(), '.npmrc');
  if (existsSync(npmrcPath)) {
    const host = NEXUS_BASE.replace(/^https?:\/\//, '');
    const needle = `//${host}/repository/${TARGET_REPO}/:_auth=`;
    for (const line of readFileSync(npmrcPath, 'utf8').split(/\r?\n/)) {
      if (line.startsWith(needle)) {
        return line.slice(needle.length).trim();
      }
    }
  }
  console.error('✗ No Nexus deploy credentials.');
  console.error('  Set NEXUS_NPM_AUTH="user:password" or add to ~/.npmrc:');
  console.error(`  //${NEXUS_BASE.replace(/^https?:\/\//, '')}/repository/${TARGET_REPO}/:_auth=<base64 of user:password>`);
  process.exit(1);
}

/**
 * Delete the existing component of this exact version so it can be published
 * again. Other versions are left alone: installs pin a version, and an older
 * line (e.g. happy@1.2.2-navercorp) must keep resolving after a newer one is
 * published. Nexus stores scoped packages as { group: "slopus", name: "happy-wire" }.
 */
async function deleteComponent(authBase64, packageName, version) {
  const match = packageName.match(/^(?:@([^/]+)\/)?(.+)$/);
  const [, scope = '', name] = match;
  const headers = { Authorization: `Basic ${authBase64}` };
  let continuationToken = null;
  do {
    const url = new URL(`${NEXUS_BASE}/service/rest/v1/components`);
    url.searchParams.set('repository', TARGET_REPO);
    if (continuationToken) url.searchParams.set('continuationToken', continuationToken);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      console.error(`✗ Nexus component listing failed: HTTP ${response.status}`);
      process.exit(1);
    }
    const page = await response.json();
    for (const item of page.items) {
      if (item.name === name && (item.group || '') === scope && item.version === version) {
        const del = await fetch(`${NEXUS_BASE}/service/rest/v1/components/${item.id}`, { method: 'DELETE', headers });
        console.log(`  deleted ${packageName}@${item.version} from ${TARGET_REPO} (HTTP ${del.status})`);
      }
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
}

function packAndPublish(packageDir, authBase64) {
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const stageDir = mkdtempSync(join(tmpdir(), 'nexus-publish-'));
  try {
    console.log(`\n─── ${pkg.name}@${pkg.version} ───`);
    run('corepack', ['pnpm', 'pack', '--pack-destination', stageDir], packageDir);

    const tarballName = `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
    const tarballPath = join(stageDir, tarballName);
    if (!existsSync(tarballPath)) {
      console.error(`✗ Expected tarball not found: ${tarballPath}`);
      process.exit(1);
    }

    const host = NEXUS_BASE.replace(/^https?:\/\//, '');
    const npmrcPath = join(stageDir, '.npmrc');
    writeFileSync(npmrcPath, [
      `//${host}/repository/${TARGET_REPO}/:_auth=${authBase64}`,
      `//${host}/repository/${TARGET_REPO}/:always-auth=true`,
      '',
    ].join('\n'));

    run('npm', [
      'publish', tarballPath,
      '--tag', 'latest',
      '--registry', TARGET_URL,
      '--userconfig', npmrcPath,
    ], packageDir);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

const authBase64 = resolveAuthBase64();

if (!skipBuild) {
  console.log('─── build ───');
  if (withWire) {
    run('corepack', ['pnpm', 'run', 'build'], wireDir);
  }
  run('corepack', ['pnpm', 'run', 'build'], cliDir);
}

if (withWire) {
  const wirePkg = JSON.parse(readFileSync(join(wireDir, 'package.json'), 'utf8'));
  await deleteComponent(authBase64, wirePkg.name, wirePkg.version);
  packAndPublish(wireDir, authBase64);
}

const cliPkg = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf8'));
await deleteComponent(authBase64, cliPkg.name, cliPkg.version);
packAndPublish(cliDir, authBase64);

console.log(`\n✓ Published. Install with:`);
console.log(`  npm i -g ${cliPkg.name}@${cliPkg.version} --registry ${GROUP_URL}`);
console.log(`  (restore official: npm i -g ${cliPkg.name} --registry https://registry.npmjs.org/)`);
