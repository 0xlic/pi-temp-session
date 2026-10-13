import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Real Pi smoke tests, opt-in to keep the package's tests usable without Pi.
const integration = process.env.PI_TEMP_INTEGRATION === '1';
async function launch(t, { flag = false, configured = true } = {}) {
  const sandbox = await mkdtemp(join(tmpdir(), 'pi-temp-rpc-'));
  const agent = join(sandbox, 'agent');
  const root = join(sandbox, 'scratch');
  await mkdir(agent);
  if (configured) await writeFile(join(agent, 'temp-session.json'), JSON.stringify({ version: 1, root }));
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
    assert.ok(header.cwd.startsWith(rpc.root + '/'));
    assert.match(header.cwd.slice(rpc.root.length), /^\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    assert.equal(state.messageCount, 0);
    const result = await rpc.request('bash', { command: 'pwd' });
    assert.equal(await realpath(result.output.trim()), await realpath(header.cwd));
    assert.equal(rpc.events.filter((event) => event.type === 'extension_error').length, 0);
  });
}

test('real RPC: --t first use configures before switching', { skip: !integration, timeout: 25000 }, async (t) => {
  const rpc = await launch(t, { flag: true, configured: false });
  const input = await rpc.wait((event) => event.method === 'input');
  assert.equal(input.placeholder, undefined);
  rpc.send({ type: 'extension_ui_response', id: input.id, value: rpc.root });
  await rpc.wait((event) => event.message?.startsWith('已切换到：'));
  const state = await rpc.request('get_state');
  const header = JSON.parse((await readFile(state.sessionFile, 'utf8')).split('\n')[0]);
  assert.ok(header.cwd.startsWith(rpc.root + '/'));
});

test('real RPC: cancelling first use keeps the original session and saves no config', { skip: !integration, timeout: 25000 }, async (t) => {
  const rpc = await launch(t, { configured: false });
  const original = await rpc.request('get_state');
  const creating = rpc.request('prompt', { message: '/temp-session' });
  const input = await rpc.wait((event) => event.method === 'input');
  rpc.send({ type: 'extension_ui_response', id: input.id, cancelled: true });
  await creating;
  assert.equal((await rpc.request('get_state')).sessionId, original.sessionId);
  await assert.rejects(access(join(rpc.agent, 'temp-session.json')));
  await assert.rejects(access(rpc.root));
});

test('real RPC: first-use wizard rejects empty input and config command does not switch', { skip: !integration, timeout: 25000 }, async (t) => {
  const rpc = await launch(t, { configured: false });
  const initial = await rpc.request('get_state');
  const configuring = rpc.request('prompt', { message: '/temp-session config' });
  const first = await rpc.wait((event) => event.method === 'input');
  assert.equal(first.placeholder, undefined);
  rpc.send({ type: 'extension_ui_response', id: first.id, value: ' ' });
  const second = await rpc.wait((event) => event.method === 'input' && event.id !== first.id);
  rpc.send({ type: 'extension_ui_response', id: second.id, value: rpc.root });
  await configuring;
  assert.equal((await rpc.request('get_state')).sessionId, initial.sessionId);
  assert.equal(JSON.parse(await readFile(join(rpc.agent, 'temp-session.json'), 'utf8')).root, rpc.root);
});
