import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRanges, executeCleanup, parseDirectoryTimestamp, planCleanup, timestampParts } from '../lib.mjs';

async function setup(t) {
  const sandbox = await mkdtemp(join(tmpdir(), 'pi-temp-clean-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const root = join(sandbox, 'temp-sessions');
  await mkdir(root);
  const now = new Date(2026, 9, 12, 12, 0, 0);
  const add = async (ageDays) => {
    const date = new Date(now.getTime() - ageDays * 86400000);
    const { day, time } = timestampParts(date);
    const path = join(root, `${day}_${time}`);
    await mkdir(join(path, '.pi', 'sessions'), { recursive: true });
    await writeFile(join(path, '.pi', 'sessions', 'history.jsonl'), 'history');
    await writeFile(join(path, 'work.txt'), 'work');
    return path;
  };
  return { sandbox, root, now, add };
}

test('parses only valid timestamp directory names', () => {
  assert.ok(parseDirectoryTimestamp('2026-10-12_12-00-00'));
  for (const name of ['2026-02-30_12-00-00', '2026-13-01_12-00-00', '2026-10-12_24-00-00', 'notes', '../2026-10-12_12-00-00']) {
    assert.equal(parseDirectoryTimestamp(name), undefined);
  }
});

test('cleanup ranges select recently created workspaces, including cutoff; all includes future dates', async (t) => {
  const { root, now, add } = await setup(t);
  for (const days of [0, 1, 3, 15, 180, 500, -1]) await add(days);
  const counts = [2, 3, 4, 5, 7];
  for (const [index, range] of cleanupRanges.entries()) {
    const plan = await planCleanup(root, { days: range.days, now });
    assert.equal(plan.directories.length, counts[index], range.label);
  }
  await assert.rejects(planCleanup(root, { days: 2, now }), /无效/);
});

test('skips active workspace, active history, unrelated names, files and directory symlinks', async (t) => {
  const { sandbox, root, now, add } = await setup(t);
  const current = await add(0);
  const activeHistory = await add(1);
  const deletable = await add(3);
  await mkdir(join(current, 'nested'));
  await mkdir(join(root, 'notes'));
  await mkdir(join(root, '2026-02-30_12-00-00'));
  await writeFile(join(root, '2026-10-10_12-00-00'), 'file');
  const outside = join(sandbox, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  await symlink(outside, join(root, '2026-10-08_12-00-00'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await planCleanup(root, {
    days: null, now, cwd: join(current, 'nested'), sessionFile: join(activeHistory, '.pi', 'sessions', 'history.jsonl'),
  });
  assert.equal(plan.skippedActive, 2);
  assert.equal(plan.directories.length, 1);
  const result = await executeCleanup(plan);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.failures, []);
  await assert.rejects(access(deletable));
  await access(current);
  await access(activeHistory);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('does not delete a directory swapped for a link after confirmation', async (t) => {
  const { sandbox, root, now, add } = await setup(t);
  const path = await add(0);
  const plan = await planCleanup(root, { days: null, now });
  const outside = join(sandbox, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  await rm(path, { recursive: true });
  await symlink(outside, path, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await executeCleanup(plan);
  assert.equal(result.deleted, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('missing root is empty and not created by cleanup', async (t) => {
  const { sandbox, now } = await setup(t);
  const missing = join(sandbox, 'missing');
  const plan = await planCleanup(missing, { days: null, now });
  assert.equal(plan.directories.length, 0);
  await assert.rejects(access(missing));
});
