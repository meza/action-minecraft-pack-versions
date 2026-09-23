import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import AdmZip from 'adm-zip';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const action = path.join(root, 'dist', 'index.js');
const mockFetch = path.join(root, 'test', 'mock-fetch.cjs');
const oldVersion = {
  id: '1.19.4',
  releaseTime: '2023-03-14T12:00:00+00:00',
  url: 'https://example.invalid/version.json'
};
const cutoffVersion = {
  id: '1.20.4',
  releaseTime: '2023-12-07T12:56:20+00:00',
  url: 'https://example.invalid/version.json'
};
const newVersion = {
  id: '1.21',
  releaseTime: '2024-06-13T09:24:03+01:00',
  url: 'https://example.invalid/version.json'
};

async function inTemporaryDirectory(run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pack-versions-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

async function runAction(dir, manifest) {
  const outputs = path.join(dir, 'outputs.txt');
  await writeFile(outputs, '');
  const result = spawnSync(process.execPath, ['--require', mockFetch, action], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: outputs,
      INPUT_OUTPUT_PATH: 'formats.json',
      INPUT_CUTOFF_VERSION: cutoffVersion.id,
      INPUT_COMMIT_ENABLED: 'false',
      INPUT_AUTO_MERGE: 'false',
      INPUT_CONCURRENCY: '1',
      TEST_MANIFEST: JSON.stringify(manifest)
    }
  });
  return {result, outputs: await readFile(outputs, 'utf8')};
}

test('backfills release times for existing entries, including entries before the cutoff', async () => {
  await inTemporaryDirectory(async (dir) => {
    const outputPath = path.join(dir, 'formats.json');
    await writeFile(outputPath, JSON.stringify({
      '1.19.4': {},
      '1.20.4': {datapack: 26, resourcepack: 22},
      unknown: {datapack: 1, resourcepack: 1}
    }));

    const manifest = {versions: [cutoffVersion, oldVersion]};
    const first = await runAction(dir, manifest);
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.match(first.outputs, /did_update<<[^\r\n]+\r?\ntrue\r?\n/);
    assert.doesNotMatch(first.outputs, /new_versions/);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), {
      '1.19.4': {releaseTime: oldVersion.releaseTime},
      '1.20.4': {datapack: 26, resourcepack: 22, releaseTime: cutoffVersion.releaseTime},
      unknown: {datapack: 1, resourcepack: 1}
    });

    const second = await runAction(dir, manifest);
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.match(second.outputs, /did_update<<[^\r\n]+\r?\nfalse\r?\n/);
  });
});

test('writes the manifest release time with a newly discovered version', async () => {
  await inTemporaryDirectory(async (dir) => {
    const outputPath = path.join(dir, 'formats.json');
    await writeFile(outputPath, JSON.stringify({
      '1.20.4': {datapack: 26, resourcepack: 22, releaseTime: cutoffVersion.releaseTime}
    }));
    const jar = new AdmZip();
    jar.addFile('version.json', Buffer.from(JSON.stringify({pack_version: {data: 48, resource: 34}})));
    const run = await runAction(dir, {
      versions: [newVersion, cutoffVersion],
      jar: jar.toBuffer().toString('base64')
    });
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.outputs, /new_versions<<[^\r\n]+\r?\n1\.21\r?\n/);
    assert.match(run.outputs, /did_update<<[^\r\n]+\r?\ntrue\r?\n/);
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8'))['1.21'], {
      datapack: 48,
      resourcepack: 34,
      releaseTime: newVersion.releaseTime
    });
  });
});

test('does not write a backfill when the manifest lacks a release time', async () => {
  await inTemporaryDirectory(async (dir) => {
    const outputPath = path.join(dir, 'formats.json');
    const original = JSON.stringify({'1.19.4': {datapack: 12, resourcepack: 13}});
    await writeFile(outputPath, original);

    const run = await runAction(dir, {
      versions: [cutoffVersion, {...oldVersion, releaseTime: undefined, time: oldVersion.releaseTime}]
    });
    assert.equal(run.result.status, 1);
    assert.match(run.result.stderr, /Release time missing for 1\.19\.4/);
    assert.equal(await readFile(outputPath, 'utf8'), original);
  });
});
