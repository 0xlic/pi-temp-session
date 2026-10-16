import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDirectory, isHomeDirectory, startupConflict, timestampParts, validateRoot } from '../lib.mjs';

async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'pi-temp-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('creates a missing agent pi-temp-sessions root using native paths', async (t) => {
  const dir = await temporary(t);
  const root = join(dir, '.pi', 'agent', 'pi-temp-sessions');
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

test('home detection matches only home itself, including canonical aliases', async (t) => {
  const root = await temporary(t);
  const home = join(root, 'home');
  const project = join(home, 'project');
  await mkdir(project, { recursive: true });
  assert.equal(await isHomeDirectory(home, home), true);
  assert.equal(await isHomeDirectory(join(home, '.'), home), true);
  assert.equal(await isHomeDirectory(project, home), false);
  assert.equal(await isHomeDirectory(root, home), false);
  assert.equal(await isHomeDirectory(join(root, 'home-other'), home), false);
  const alias = join(root, 'alias');
  await symlink(home, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await isHomeDirectory(alias, home), true);
});

test('startup rejects session selection but ignores prompt text after --', () => {
  assert.equal(startupConflict(['--t', '--session=abc']), '--session=abc');
  assert.equal(startupConflict(['--t', '-c']), '-c');
  assert.equal(startupConflict(['--t', '--', '--session']), undefined);
});

test('pi-go startup takes precedence over automatic and explicit temp sessions', () => {
  assert.equal(startupConflict(['--g']), '--g');
  assert.equal(startupConflict(['--g', '--t']), '--g');
  assert.equal(startupConflict(['--t', '--g']), '--g');
  assert.equal(startupConflict(['--g=true']), '--g=true');
  assert.equal(startupConflict(['--', '--g']), undefined);
  assert.equal(startupConflict(['--g-other']), undefined);
});
