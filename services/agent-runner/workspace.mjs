// Materialises a product's repository into a run's workspace.
//
// The archive arrives as a signed, expiring URL minted by github-sync — the
// only place the org PAT is decrypted. Nothing in this container authenticates
// to GitHub, which is the property that makes it safe to give the harness a
// terminal: an agent that has read a private repository holds no credential it
// could push with, and its toolset has no fetch tool it could reuse the URL
// with even before the URL expires.
//
// The tree therefore arrives with no `.git`. That is deliberate rather than a
// limitation worked around: history is available through the
// `platform_repo_history` and `platform_file_at_ref` MCP tools, which read it
// through the control plane, and a pack file in the sandbox would be a push
// waiting for a credential to appear.
import {rm, mkdir, readdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';
import {join} from 'node:path';

// The subdirectory the working tree lands in. Kept separate from the workspace
// root so that scratch files an agent wrote in a previous turn survive, while
// the tree itself is replaced every run and can never drift from the ref it
// claims to be.
export const REPO_DIR = 'repo';

const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

function extract(destination, body, onBytes) {
  return new Promise((resolve, reject) => {
    // GitHub tarballs are wrapped in a single `owner-repo-sha/` directory.
    const tar = spawn('tar', ['-xzf', '-', '-C', destination, '--strip-components=1'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    tar.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(0, 4000);
    });
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`could not unpack the repository archive: ${stderr.trim() || `tar exited ${code}`}`));
    });

    let bytes = 0;
    const source = Readable.fromWeb(body);
    source.on('data', (chunk) => {
      bytes += chunk.length;
      onBytes?.(bytes);
      if (bytes > MAX_ARCHIVE_BYTES) {
        // A repository this large is a configuration mistake, and unpacking it
        // would fill the runner's disk for every other agent on the box.
        source.destroy(new Error(`the repository archive exceeded ${MAX_ARCHIVE_BYTES} bytes`));
        tar.kill('SIGKILL');
      }
    });
    source.on('error', (error) => {
      tar.kill('SIGKILL');
      reject(error);
    });
    source.pipe(tar.stdin);
  });
}

export async function materialiseRepo({workspace, repo, fetchImpl = fetch}) {
  const destination = join(workspace, REPO_DIR);

  // Replaced, never merged. A tree left over from a previous ref that is then
  // partially overwritten is the worst of both: it looks like the ref it claims
  // to be and is not.
  await rm(destination, {recursive: true, force: true});
  await mkdir(destination, {recursive: true});

  const response = await fetchImpl(repo.url, {redirect: 'follow'});
  if (!response.ok || !response.body) {
    throw new Error(`the repository archive could not be downloaded (HTTP ${response.status})`);
  }

  await extract(destination, response.body);

  const entries = await readdir(destination);
  return {path: destination, ref: repo.ref, repo: repo.repo, entries: entries.length};
}
