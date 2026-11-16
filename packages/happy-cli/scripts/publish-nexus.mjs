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
 * When npm-snapshot and npm-release both hold a version, npm-group hands out
 * the npm-snapshot copy, so a leftover snapshot hides a fresh release from
 * every install. A release publish therefore deletes the npm-snapshot copy of
 * its version, a snapshot publish refuses a version npm-release already has,
 * and both end by checking that npm-group serves the tarball just published.
 *
 * NEXUS_BASE_URL is required: the Nexus base URL, e.g. http://nexus.example.com.
 * NEXUS_REPO overrides the target repository; npm-group is then left unchecked.
 *
 * Usage:
 *   pnpm run publish:nexus              # build + pack + delete + publish (npm-release)
 *   pnpm run publish:nexus --snapshot   # target npm-snapshot instead
 *   pnpm run publish:nexus --with-wire  # also republish @slopus/happy-wire
 *   pnpm run publish:nexus --skip-build # pack current dist as-is
 *
 * Auth (deploy only — installs are anonymous):
 *   1. NEXUS_NPM_AUTH env var as "user:password", or
 *   2. an `//<host>/repository/<repo>/:_auth=<base64>` line in ~/.npmrc for the
 *      target repo, and for npm-snapshot when a release deletes a copy there
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NEXUS_BASE = process.env.NEXUS_BASE_URL;
if (!NEXUS_BASE) {
  console.error('✗ NEXUS_BASE_URL is not set — the Nexus base URL, e.g. http://nexus.example.com');
  process.exit(1);
}
const RELEASE_REPO = 'npm-release';
const SNAPSHOT_REPO = 'npm-snapshot';
const GROUP_REPO = 'npm-group';
const useSnapshot = process.argv.includes('--snapshot');
const TARGET_REPO = process.env.NEXUS_REPO || (useSnapshot ? SNAPSHOT_REPO : RELEASE_REPO);
const TARGET_URL = `${NEXUS_BASE}/repository/${TARGET_REPO}/`;
const GROUP_URL = `${NEXUS_BASE}/repository/${GROUP_REPO}/`;
// A NEXUS_REPO override need not be a member of npm-group
const checksGroup = TARGET_REPO === RELEASE_REPO || TARGET_REPO === SNAPSHOT_REPO;

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

function resolveAuthBase64(repo) {
  if (process.env.NEXUS_NPM_AUTH) {
    return Buffer.from(process.env.NEXUS_NPM_AUTH).toString('base64');
  }
  const npmrcPath = join(homedir(), '.npmrc');
  if (existsSync(npmrcPath)) {
    const host = NEXUS_BASE.replace(/^https?:\/\//, '');
    const needle = `//${host}/repository/${repo}/:_auth=`;
    for (const line of readFileSync(npmrcPath, 'utf8').split(/\r?\n/)) {
      if (line.startsWith(needle)) {
        return line.slice(needle.length).trim();
      }
    }
  }
  console.error(`✗ No Nexus deploy credentials for ${repo}.`);
  console.error('  Set NEXUS_NPM_AUTH="user:password" or add to ~/.npmrc:');
  console.error(`  //${NEXUS_BASE.replace(/^https?:\/\//, '')}/repository/${repo}/:_auth=<base64 of user:password>`);
  process.exit(1);
}

/**
 * fetch, retried when the connection drops. pack and publish run through
 * spawnSync, which blocks the event loop meanwhile, so the next request can go
 * out on a keep-alive socket the server has closed by then (ECONNRESET).
 */
async function nexusFetch(url, init) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

/**
 * dist.shasum (sha1) of the version in a repository's package metadata, or
 * null when the repository does not hold that version. Read anonymously, the
 * way installs read it.
 */
async function servedShasum(repo, packageName, version) {
  const response = await nexusFetch(`${NEXUS_BASE}/repository/${repo}/${packageName.replace('/', '%2f')}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    console.error(`✗ Reading ${packageName} from ${repo} failed: HTTP ${response.status}`);
    process.exit(1);
  }
  const packument = await response.json();
  return packument.versions?.[version]?.dist?.shasum ?? null;
}

/**
 * Delete the existing component of this exact version so it can be published
 * again. Other versions are left alone: installs pin a version, and an older
 * line (e.g. happy@1.2.2-navercorp) must keep resolving after a newer one is
 * published. Nexus stores scoped packages as { group: "slopus", name: "happy-wire" }.
 */
async function deleteComponent(repo, authBase64, packageName, version) {
  const match = packageName.match(/^(?:@([^/]+)\/)?(.+)$/);
  const [, scope = '', name] = match;
  const headers = { Authorization: `Basic ${authBase64}` };
  let continuationToken = null;
  do {
    const url = new URL(`${NEXUS_BASE}/service/rest/v1/components`);
    url.searchParams.set('repository', repo);
    if (continuationToken) url.searchParams.set('continuationToken', continuationToken);
    const response = await nexusFetch(url, { headers });
    if (!response.ok) {
      console.error(`✗ Nexus component listing failed: HTTP ${response.status}`);
      process.exit(1);
    }
    const page = await response.json();
    for (const item of page.items) {
      if (item.name === name && (item.group || '') === scope && item.version === version) {
        const del = await nexusFetch(`${NEXUS_BASE}/service/rest/v1/components/${item.id}`, { method: 'DELETE', headers });
        console.log(`  deleted ${packageName}@${item.version} from ${repo} (HTTP ${del.status})`);
      }
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);
}

/** Pack and publish to the target repo; returns the tarball's sha1 (npm's dist.shasum) */
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
    const shasum = createHash('sha1').update(readFileSync(tarballPath)).digest('hex');

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
    return shasum;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/**
 * Installs resolve through npm-group, so a publish has only landed once
 * npm-group hands out this tarball. Allow it a few seconds to merge.
 */
async function verifyGroupServes(packageName, version, shasum) {
  let served = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    served = await servedShasum(GROUP_REPO, packageName, version);
    if (served === shasum) {
      console.log(`  ${GROUP_REPO} serves ${packageName}@${version} (${shasum})`);
      return;
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  console.error(`✗ ${GROUP_REPO} serves ${packageName}@${version} as ${served ?? 'nothing'}, not the tarball just published (${shasum}).`);
  console.error('  Installs keep getting that copy until the member of npm-group that holds it is cleaned up.');
  process.exit(1);
}

function packageAt(dir) {
  const { name, version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  return { dir, name, version };
}

const cliPkg = packageAt(cliDir);
const packages = withWire ? [packageAt(wireDir), cliPkg] : [cliPkg];
const authBase64 = resolveAuthBase64(TARGET_REPO);

// Settle what npm-group will hand out before anything is deleted (see the header)
const staleSnapshots = [];
for (const pkg of packages) {
  if (TARGET_REPO === SNAPSHOT_REPO && await servedShasum(RELEASE_REPO, pkg.name, pkg.version)) {
    console.error(`✗ ${pkg.name}@${pkg.version} is already in ${RELEASE_REPO}, and ${GROUP_REPO} would hand out this snapshot to every install instead.`);
    console.error('  Publish the snapshot under another version.');
    process.exit(1);
  }
  if (TARGET_REPO === RELEASE_REPO && await servedShasum(SNAPSHOT_REPO, pkg.name, pkg.version)) {
    staleSnapshots.push(pkg);
  }
}
const snapshotAuthBase64 = staleSnapshots.length > 0 ? resolveAuthBase64(SNAPSHOT_REPO) : null;

if (!skipBuild) {
  console.log('─── build ───');
  for (const pkg of packages) {
    run('corepack', ['pnpm', 'run', 'build'], pkg.dir);
  }
}

for (const pkg of packages) {
  await deleteComponent(TARGET_REPO, authBase64, pkg.name, pkg.version);
  const shasum = packAndPublish(pkg.dir, authBase64);
  if (staleSnapshots.includes(pkg)) {
    await deleteComponent(SNAPSHOT_REPO, snapshotAuthBase64, pkg.name, pkg.version);
  }
  if (checksGroup) {
    await verifyGroupServes(pkg.name, pkg.version, shasum);
  }
}

console.log(`\n✓ Published. Install with:`);
console.log(`  npm i -g ${cliPkg.name}@${cliPkg.version} --registry ${GROUP_URL}`);
console.log(`  (restore official: npm i -g ${cliPkg.name} --registry https://registry.npmjs.org/)`);
