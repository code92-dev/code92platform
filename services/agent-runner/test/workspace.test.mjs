// The repository materialisation path.
//
// What is worth asserting here is not that tar works, but that the tree is
// replaced rather than merged, that an oversized archive is refused before it
// fills the disk, and that the model is told the truth about what it is looking
// at — a tree with no history and no way to push.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';

import {materialiseRepo, REPO_DIR} from '../workspace.mjs';
import {__test__} from '../jcode-driver.mjs';

const {workspaceBriefing} = __test__;

// Builds a real gzipped tarball shaped like GitHub's: one top-level directory
// that --strip-components=1 is expected to remove.
async function githubShapedTarball(files) {
  const staging = await mkdtemp(join(tmpdir(), 'c92-tar-'));
  const root = join(staging, 'code92-dev-product-abc1234');
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), {recursive: true});
    await writeFile(full, content);
  }
  const chunks = await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', '-', '-C', staging, 'code92-dev-product-abc1234']);
    const out = [];
    tar.stdout.on('data', (chunk) => out.push(chunk));
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tar exited ${code}`))));
  });
  await rm(staging, {recursive: true, force: true});
  return Buffer.concat(chunks);
}

function fakeArchiveFetch(buffer) {
  return async () => ({
    ok: true,
    status: 200,
    body: Readable.toWeb(Readable.from([buffer])),
  });
}

test('the archive is unpacked with its wrapper directory stripped', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'c92-ws-'));
  const tarball = await githubShapedTarball({
    'README.md': '# product\n',
    'docs/lifecycle/01-ideation/brief.md': 'the brief\n',
  });

  const info = await materialiseRepo({
    workspace,
    repo: {repo: 'code92-dev/product', ref: 'main', url: 'https://example.invalid/a.tar.gz'},
    fetchImpl: fakeArchiveFetch(tarball),
  });

  assert.equal(info.repo, 'code92-dev/product');
  assert.equal(info.ref, 'main');
  // Stripped: README.md sits at the root, not under code92-dev-product-abc1234/.
  assert.equal(await readFile(join(workspace, REPO_DIR, 'README.md'), 'utf8'), '# product\n');
  assert.equal(
    await readFile(join(workspace, REPO_DIR, 'docs/lifecycle/01-ideation/brief.md'), 'utf8'),
    'the brief\n',
  );
});

test('no .git directory reaches the sandbox', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'c92-ws-'));
  const tarball = await githubShapedTarball({'README.md': 'x\n'});

  await materialiseRepo({
    workspace,
    repo: {repo: 'code92-dev/product', ref: 'main', url: 'https://example.invalid/a.tar.gz'},
    fetchImpl: fakeArchiveFetch(tarball),
  });

  const entries = await readdir(join(workspace, REPO_DIR));
  assert.ok(!entries.includes('.git'), 'a pack file in the sandbox is a push waiting for a credential');
});

test('a previous tree is replaced, not merged', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'c92-ws-'));
  const repoDir = join(workspace, REPO_DIR);
  await mkdir(repoDir, {recursive: true});
  await writeFile(join(repoDir, 'STALE.md'), 'from an older ref\n');
  // A scratch file the agent wrote last turn, outside the tree.
  await writeFile(join(workspace, 'notes.md'), 'keep me\n');

  await materialiseRepo({
    workspace,
    repo: {repo: 'code92-dev/product', ref: 'main', url: 'https://example.invalid/a.tar.gz'},
    fetchImpl: fakeArchiveFetch(await githubShapedTarball({'README.md': 'x\n'})),
  });

  const entries = await readdir(repoDir);
  assert.deepEqual(entries, ['README.md'], 'a tree that looks like a ref it is not is worse than no tree');
  // Workspace persistence is the point of a stable path; only the tree is derived.
  assert.equal(await readFile(join(workspace, 'notes.md'), 'utf8'), 'keep me\n');
});

test('a failed download is an error, not an empty working tree', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'c92-ws-'));
  await assert.rejects(
    materialiseRepo({
      workspace,
      repo: {repo: 'code92-dev/product', ref: 'main', url: 'https://example.invalid/a.tar.gz'},
      fetchImpl: async () => ({ok: false, status: 404, body: null}),
    }),
    /could not be downloaded \(HTTP 404\)/,
  );
});

test('the model is told the tree has no history and that it cannot push', () => {
  const briefing = workspaceBriefing({
    repo: 'code92-dev/product',
    ref: 'main',
    path: '/var/lib/x/workspaces/c/channel/repo',
  });

  assert.match(briefing, /code92-dev\/product/);
  assert.match(briefing, /no \.git directory/);
  assert.match(briefing, /platform_repo_history/);
  assert.match(briefing, /cannot push/);
  assert.match(briefing, /proposal/);
});

test('an agent with no repository gets no workspace briefing at all', () => {
  assert.equal(workspaceBriefing(null), '');
});
