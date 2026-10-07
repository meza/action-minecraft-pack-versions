import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const action = path.join(root, 'dist', 'index.js');
const mockFetch = path.join(root, 'test', 'mock-github-fetch.cjs');
const release = {
  id: '1.20.4',
  releaseTime: '2023-12-07T12:56:20+00:00',
  url: 'https://example.invalid/version.json'
};

async function runAction(scenario) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pack-pr-'));
  const output = path.join(dir, 'outputs.txt');
  const log = path.join(dir, 'github-log.json');
  await writeFile(output, '');
  await writeFile(path.join(dir, 'formats.json'), JSON.stringify({
    [release.id]: {datapack: 26, resourcepack: 22}
  }));

  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port;
  await new Promise((resolve, reject) => portProbe.close(err => err ? reject(err) : resolve()));

  const result = spawnSync(process.execPath, ['--require', mockFetch, action], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      GITHUB_REPOSITORY: 'acme/repo',
      INPUT_OUTPUT_PATH: 'formats.json',
      INPUT_CUTOFF_VERSION: release.id,
      INPUT_COMMIT_ENABLED: 'true',
      INPUT_COMMIT_TYPE: 'chore',
      INPUT_COMMIT_SCOPE: '',
      INPUT_COMMIT_TEMPLATE: '{{type}}: update pack-format map',
      INPUT_PR_BRANCH: 'bot/pack-format',
      INPUT_PR_BASE: 'main',
      INPUT_AUTO_MERGE: 'false',
      INPUT_GITHUB_TOKEN: 'test-token',
      INPUT_CONCURRENCY: '1',
      TEST_MANIFEST: JSON.stringify({versions: [release]}),
      TEST_GITHUB_SCENARIO: JSON.stringify(scenario),
      TEST_GITHUB_LOG: log,
      TEST_GITHUB_PORT: String(port)
    }
  });

  let github;
  try {
    github = JSON.parse(await readFile(log, 'utf8'));
  } catch (err) {
    throw new Error(`GitHub fake did not record a request.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`, {cause: err});
  }
  await rm(dir, {recursive: true, force: true});
  return {result, github};
}

function event(github, method, path) {
  return github.events.find(item => item.method === method && item.path === path);
}

test('updates an existing PR branch only after its complete commit exists', async () => {
  const {result, github} = await runAction({branchExists: true, existingPr: true});
  assert.equal(result.status, 0, result.stderr);

  const tree = event(github, 'POST', '/repos/acme/repo/git/trees');
  assert.equal(tree.body.base_tree, 'base-tree-sha');
  assert.deepEqual(tree.body.tree, [{path: 'formats.json', mode: '100644', type: 'blob', sha: 'blob-sha'}]);

  const commit = event(github, 'POST', '/repos/acme/repo/git/commits');
  assert.equal(commit.body.tree, 'tree-sha');
  assert.deepEqual(commit.body.parents, ['base-sha']);

  const mutations = github.events.filter(item =>
    (item.method === 'PATCH' || item.method === 'POST') && item.path.includes('/git/refs')
  );
  assert.deepEqual(mutations.map(item => [item.method, item.body.sha]), [['PATCH', 'commit-sha']]);
  assert.equal(github.pullRequestOpen, true);
  assert.equal(event(github, 'POST', '/repos/acme/repo/pulls'), undefined);
  assert.ok(github.events.indexOf(commit) < github.events.indexOf(mutations[0]));
});

test('creates a missing branch at the complete commit', async () => {
  const {result, github} = await runAction({branchExists: false, existingPr: false});
  assert.equal(result.status, 0, result.stderr);

  const createRef = event(github, 'POST', '/repos/acme/repo/git/refs');
  assert.deepEqual(createRef.body, {ref: 'refs/heads/bot/pack-format', sha: 'commit-sha'});
  assert.ok(event(github, 'POST', '/repos/acme/repo/pulls'));
});

test('does not mutate a ref when commit construction fails', async () => {
  const {result, github} = await runAction({
    branchExists: true,
    existingPr: true,
    failAt: 'createCommit'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /commit failed/);
  assert.equal(github.events.some(item => item.path.includes('/git/refs')), false);
  assert.equal(github.events.some(item => item.path === '/repos/acme/repo/pulls'), false);
  assert.equal(github.pullRequestOpen, true);
});

