import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function normalizeRoot(input, cwd, home = homedir()) {
  const value = input.trim();
  if (!value) throw new Error('请输入根目录，不能留空。');
  if (value.includes('\0')) throw new Error('目录不能包含空字符。');
  if (value.startsWith('~') && value !== '~' && !value.startsWith('~/')) {
    throw new Error('只支持 ~ 或 ~/，不支持 ~用户名。');
  }
  return resolve(cwd, value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value);
}

export async function validateRoot(root) {
  await mkdir(root, { recursive: true });
  if (!(await stat(root)).isDirectory()) throw new Error(`不是目录：${root}`);
  await access(root, constants.W_OK | constants.X_OK);
}

export async function loadConfig(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const config = JSON.parse(text);
  if (config.version !== 1 || typeof config.root !== 'string' || !isAbsolute(config.root) || config.root.includes('\0')) {
    throw new Error(`配置无效，请运行 /temp-session config：${path}`);
  }
  return config;
}

export async function saveConfig(path, root) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, root }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
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
    const parent = join(root, day);
    const directory = join(parent, time);
    await mkdir(parent, { recursive: true });
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

export function startupConflict(argv) {
  const end = argv.indexOf('--');
  const options = end < 0 ? argv : argv.slice(0, end);
  const conflicts = ['--continue', '-c', '--resume', '-r', '--session', '--session-id', '--fork', '--no-session'];
  return options.find((arg) => conflicts.some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
}
