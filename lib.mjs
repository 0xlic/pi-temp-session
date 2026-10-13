import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function validateRoot(root) {
  await mkdir(root, { recursive: true });
  if (!(await stat(root)).isDirectory()) throw new Error(`不是目录：${root}`);
  await access(root, constants.W_OK | constants.X_OK);
}

const pad = (value) => String(value).padStart(2, '0');
export function timestampParts(date) {
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  };
}

export async function createDirectory(root, { now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  while (true) {
    const date = now();
    const { day, time } = timestampParts(date);
    const directory = join(root, `${day}_${time}`);
    await mkdir(root, { recursive: true });
    try { await mkdir(directory); return directory; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await stat(directory)).isDirectory()) throw new Error(`无法创建目录，已有同名文件：${directory}`);
    }
    await sleep(1000 - date.getMilliseconds());
  }
}

// SessionManager deliberately keeps empty sessions in memory. Materialize just
// its public header so switchSession can open it, without inventing a chat message.
export async function materializeSession(manager) {
  const file = manager.getSessionFile();
  const header = manager.getHeader();
  if (!file || !header) throw new Error('无法创建持久化会话。');
  await writeFile(file, JSON.stringify(header) + '\n', { flag: 'wx', mode: 0o600 });
  return file;
}

export const cleanupRanges = [
  { label: '最近一天（24小时）', days: 1 },
  { label: '最近一周（7天）', days: 7 },
  { label: '最近一个月（30天）', days: 30 },
  { label: '最近一年（365天）', days: 365 },
  { label: '所有临时会话', days: null },
];

export function parseDirectoryTimestamp(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(name);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  const parts = timestampParts(date);
  return `${parts.day}_${parts.time}` === name ? date : undefined;
}

function containsPath(parent, child) {
  const difference = relative(parent, child);
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`);
}

async function canonicalPath(path) {
  try { return await realpath(path); }
  catch (error) { if (error.code === 'ENOENT') return resolve(path); throw error; }
}

export async function planCleanup(root, { days, now = new Date(), cwd, sessionFile } = {}) {
  if (days !== null && !cleanupRanges.some((range) => range.days === days)) throw new Error('无效的清理范围。');
  let canonicalRoot;
  try { canonicalRoot = await realpath(root); }
  catch (error) {
    if (error.code === 'ENOENT') return { root: resolve(root), directories: [], skippedActive: 0 };
    throw error;
  }
  const protectedPaths = await Promise.all([cwd, sessionFile].filter(Boolean).map(canonicalPath));
  const cutoff = days === null ? null : now.getTime() - days * 86400000;
  const directories = [];
  let skippedActive = 0;
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const date = parseDirectoryTimestamp(entry.name);
    if (!date || (cutoff !== null && (date.getTime() < cutoff || date > now))) continue;
    const path = join(canonicalRoot, entry.name);
    if (protectedPaths.some((protectedPath) => containsPath(path, protectedPath))) { skippedActive++; continue; }
    let info;
    try { info = await lstat(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (info.isDirectory() && !info.isSymbolicLink()) directories.push({ path, dev: info.dev, ino: info.ino });
  }
  directories.sort((a, b) => a.path.localeCompare(b.path));
  return { root: canonicalRoot, directories, skippedActive };
}

export async function executeCleanup(plan) {
  let deleted = 0;
  const failures = [];
  for (const directory of plan.directories) {
    try {
      // Recheck the confirmed root and inode; never follow a swapped symlink.
      if (dirname(directory.path) !== plan.root || !parseDirectoryTimestamp(basename(directory.path))) {
        throw new Error('目录不在临时工作区清理范围内。');
      }
      if (await realpath(plan.root) !== plan.root) throw new Error('清理根目录已发生变化。');
      const info = await lstat(directory.path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== directory.dev || info.ino !== directory.ino) {
        throw new Error('目录已发生变化，跳过删除。');
      }
      await rm(directory.path, { recursive: true });
      deleted++;
    } catch (error) {
      failures.push({ path: directory.path, error: String(error) });
    }
  }
  return { deleted, failures };
}

export function startupConflict(argv) {
  const end = argv.indexOf('--');
  const options = end < 0 ? argv : argv.slice(0, end);
  const conflicts = ['--continue', '-c', '--resume', '-r', '--session', '--session-id', '--fork', '--no-session'];
  return options.find((arg) => conflicts.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}
