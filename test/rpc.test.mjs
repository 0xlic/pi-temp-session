import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

// Real Pi smoke tests, opt-in to keep the package's tests usable without Pi.
const integration = process.env.PI_TEMP_INTEGRATION === '1';
async function launch(t, { flag = false, legacyConfig } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), 'pi-temp-rpc-'));
  const agent = join(sandbox, 'agent');
  const root = join(agent, 'pi-temp-sessions');
  await mkdir(agent);
  if (legacyConfig !== undefined) await writeFile(join(agent, 'temp-session.json'), legacyConfig);
  const child = spawn(process.env.PI_TEST_CLI || 'pi', ['--offline', '-ne', '-e', resolve('index.ts'), '--mode', 'rpc', ...(flag ? ['--t'] : [])], {
    cwd: sandbox,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    await rm(sandbox, { recursive: true, force: true });
  });
  let buffer = '', stderr = '';
  const events = [];
  child.stderr.on('data', (data) => { stderr += data; });
  child.stdout.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { events.push(JSON.parse(line)); } catch {}
    }
  });
  const wait = async (predicate) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      if (child.exitCode !== null) throw new Error(`Pi exited: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out: ${stderr}\n${JSON.stringify(events)}`);
  };
  let id = 0;
  const send = (data) => child.stdin.write(JSON.stringify(data) + '\n');
  const request = async (type, data = {}) => {
    const key = String(++id); send({ type, id: key, ...data });
    const response = await wait((event) => event.type === 'response' && event.id === key);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  };
  return { root, agent, events, wait, send, request };
}

for (const flag of [false, true]) {
  test(`real RPC: ${flag ? '--t' : '/temp-session'} rebuilds cwd and keeps history empty`, { skip: !integration, timeout: 25000 }, async (t) => {
    const rpc = await launch(t, { flag });
    if (!flag) await rpc.request('prompt', { message: '/temp-session' });
    await rpc.wait((event) => event.type === 'extension_ui_request' && event.message?.startsWith('已切换到：'));
    const state = await rpc.request('get_state');
    const header = JSON.parse((await readFile(state.sessionFile, 'utf8')).split('\n')[0]);
    assert.equal(dirname(header.cwd), rpc.root);
    assert.match(basename(header.cwd), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    assert.equal(rpc.events.some((event) => event.method === 'input'), false);
    await assert.rejects(access(join(rpc.agent, 'temp-session.json')));
    assert.equal(dirname(state.sessionFile), join(header.cwd, '.pi', 'sessions'));
    assert.equal(state.messageCount, 0);
    const result = await rpc.request('bash', { command: 'pwd' });
    assert.equal(await realpath(result.output.trim()), await realpath(header.cwd));
    // The opened session must continue persisting inside the workspace.
    assert.ok((await readFile(state.sessionFile, 'utf8')).includes('pwd'));
    await rpc.request('new_session');
    const next = await rpc.request('get_state');
    assert.notEqual(next.sessionId, state.sessionId);
    assert.equal(dirname(next.sessionFile), join(header.cwd, '.pi', 'sessions'));
    assert.equal(rpc.events.filter((event) => event.type === 'extension_error').length, 0);
    // Removing only this isolated workspace also removes its stored history.
    await rm(header.cwd, { recursive: true });
    await assert.rejects(access(state.sessionFile));
  });
}

test('real RPC: obsolete config is ignored and preserved, even if malformed', { skip: !integration, timeout: 25000 }, async (t) => {
  const rpc = await launch(t, { flag: true, legacyConfig: 'obsolete invalid JSON' });
  await rpc.wait((event) => event.message?.startsWith('已切换到：'));
  const state = await rpc.request('get_state');
  const header = JSON.parse((await readFile(state.sessionFile, 'utf8')).split('\n')[0]);
  assert.equal(dirname(header.cwd), rpc.root);
  assert.equal(await readFile(join(rpc.agent, 'temp-session.json'), 'utf8'), 'obsolete invalid JSON');
  assert.equal(rpc.events.some((event) => event.method === 'input'), false);
});

test('real RPC: clean confirms deletion and protects the active workspace', { skip: !integration, timeout: 25000 }, async (t) => {
  const rpc = await launch(t, { flag: true });
  await rpc.wait((event) => event.message?.startsWith('已切换到：'));
  const state = await rpc.request('get_state');
  const current = JSON.parse((await readFile(state.sessionFile, 'utf8')).split('\n')[0]).cwd;
  const old = join(rpc.root, '2020-01-01_12-00-00');
  await mkdir(join(old, '.pi', 'sessions'), { recursive: true });
  await writeFile(join(old, '.pi', 'sessions', 'old.jsonl'), 'old history');
  const cleaning = rpc.request('prompt', { message: '/temp-session clean' });
  const select = await rpc.wait((event) => event.method === 'select');
  assert.equal(select.options.length, 5);
  rpc.send({ type: 'extension_ui_response', id: select.id, value: '所有临时会话' });
  const confirm = await rpc.wait((event) => event.method === 'confirm');
  assert.match(confirm.message, /共 1 个工作区/);
  assert.match(confirm.message, /当前会话所在的 1 个工作区已跳过/);
  rpc.send({ type: 'extension_ui_response', id: confirm.id, confirmed: true });
  await cleaning;
  await assert.rejects(access(old));
  await access(current);
  await access(state.sessionFile);
  assert.equal((await rpc.request('get_state')).sessionId, state.sessionId);
});

test('real RPC: cancelling cleanup confirmation preserves workspace and history', { skip: !integration, timeout: 25000 }, async (t) => {
  const rpc = await launch(t);
  const old = join(rpc.root, '2020-01-01_12-00-00');
  await mkdir(old, { recursive: true });
  await writeFile(join(old, 'keep.txt'), 'keep');
  const cleaning = rpc.request('prompt', { message: '/temp-session clean' });
  const select = await rpc.wait((event) => event.method === 'select');
  rpc.send({ type: 'extension_ui_response', id: select.id, value: '所有临时会话' });
  const confirm = await rpc.wait((event) => event.method === 'confirm');
  rpc.send({ type: 'extension_ui_response', id: confirm.id, confirmed: false });
  await cleaning;
  assert.equal(await readFile(join(old, 'keep.txt'), 'utf8'), 'keep');
});

test('real RPC: config subcommand is retired without creating or switching sessions', { skip: !integration, timeout: 25000 }, async (t) => {
  const rpc = await launch(t);
  const initial = await rpc.request('get_state');
  await rpc.request('prompt', { message: '/temp-session config' });
  assert.equal((await rpc.request('get_state')).sessionId, initial.sessionId);
  assert.equal(rpc.events.some((event) => event.method === 'input'), false);
  assert.ok(rpc.events.some((event) => event.message?.startsWith('无需配置根目录')));
  await assert.rejects(access(rpc.root));
});
