import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectory, loadConfig, normalizeRoot, saveConfig, startupConflict, timestampParts, validateRoot } from '../lib.mjs';

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'pi-temp-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('root has no default; expands home and relative paths', () => {
  assert.throws(() => normalizeRoot(' ', '/work'));
  assert.equal(normalizeRoot('~/scratch', '/work', '/home/me'), '/home/me/scratch');
  assert.equal(normalizeRoot('scratch', '/work'), '/work/scratch');
  assert.throws(() => normalizeRoot('~someone/scratch', '/work'));
});

test('config is persistent, replaceable and missing config has no default', async (t) => {
  const dir = await temporary(t);
  const path = join(dir, 'agent', 'temp-session.json');
  assert.equal(await loadConfig(path), undefined);
  await saveConfig(path, dir);
  assert.equal((await loadConfig(path)).root, dir);
  await saveConfig(path, join(dir, 'other'));
  assert.equal((await loadConfig(path)).root, join(dir, 'other'));
  await writeFile(path, '{}');
  await assert.rejects(loadConfig(path), /配置无效/);
  await writeFile(path, 'broken');
  await assert.rejects(loadConfig(path));
});

test('uses local timestamp, waits at collision and handles midnight', async (t) => {
  const root = await temporary(t);
  let date = new Date(2026, 0, 1, 23, 59, 59, 200);
  assert.deepEqual(timestampParts(date), { day: '2026-01-01', time: '23-59-59' });
  assert.equal(await createDirectory(root, { now: () => date }), join(root, '2026-01-01', '23-59-59'));
  let waits = 0;
  const path = await createDirectory(root, {
    now: () => date,
    sleep: async (ms) => { assert.equal(ms, 800); waits++; date = new Date(2026, 0, 2, 0, 0, 0); },
  });
  assert.equal(waits, 1);
  assert.equal(path, join(root, '2026-01-02', '00-00-00'));
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
  assert.equal(startupConflict(['--g', '--session=abc']), '--session=abc');
  assert.equal(startupConflict(['--g', '-c']), '-c');
  assert.equal(startupConflict(['--g', '--', '--session']), undefined);
});
