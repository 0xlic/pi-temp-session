import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectory, startupConflict, timestampParts, validateRoot } from '../lib.mjs';

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'pi-temp-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('creates a missing agent temp-sessions root using native paths', async (t) => {
  const dir = await temporary(t);
  const root = join(dir, '.pi', 'agent', 'temp-sessions');
  await validateRoot(root);
  const path = await createDirectory(root, { now: () => new Date(2026, 0, 1, 12, 0, 0) });
  assert.equal(path, join(root, '2026-01-01_12-00-00'));
  assert.doesNotMatch('2026-01-01_12-00-00', /[<>:"/\\|?*]/);
});

test('uses local timestamp, waits at collision and handles midnight', async (t) => {
  const root = await temporary(t);
  let date = new Date(2026, 0, 1, 23, 59, 59, 200);
  assert.deepEqual(timestampParts(date), { day: '2026-01-01', time: '23-59-59' });
  assert.equal(await createDirectory(root, { now: () => date }), join(root, '2026-01-01_23-59-59'));
  let waits = 0;
  const path = await createDirectory(root, {
    now: () => date,
    sleep: async (ms) => { assert.equal(ms, 800); waits++; date = new Date(2026, 0, 2, 0, 0, 0); },
  });
  assert.equal(waits, 1);
  assert.equal(path, join(root, '2026-01-02_00-00-00'));
  assert.deepEqual((await readdir(root)).sort(), ['2026-01-01_23-59-59', '2026-01-02_00-00-00']);
});

test('same-named file fails immediately; invalid root fails', async (t) => {
  const root = await temporary(t);
  const now = () => new Date(2026, 0, 1, 12, 0, 0);
  const directory = await createDirectory(root, { now });
  await rm(directory, { recursive: true });
  await writeFile(directory, 'not a directory');
  await assert.rejects(createDirectory(root, { now, sleep: () => { throw new Error('must not wait'); } }), /同名文件/);
  await assert.rejects(validateRoot(directory));
  assert.equal(await readFile(directory, 'utf8'), 'not a directory');
});

test('startup rejects session selection but ignores prompt text after --', () => {
  assert.equal(startupConflict(['--t', '--session=abc']), '--session=abc');
  assert.equal(startupConflict(['--t', '-c']), '-c');
  assert.equal(startupConflict(['--t', '--', '--session']), undefined);
});
