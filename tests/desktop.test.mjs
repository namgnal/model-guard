import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {validConnection, desktopEnvironment, ensureService, serviceReady, allowedNavigation} from '../lib/desktop-launcher.mjs';

const root = path.resolve(import.meta.dirname, '..');
const token = 'a'.repeat(64);
test('桌面连接只接受本机带有效凭证的根地址', () => {
  assert.ok(validConnection({url: `http://127.0.0.1:3210/#${token}`}));
  for (const url of [`https://127.0.0.1:3210/#${token}`, `http://example.com:3210/#${token}`, `http://user@127.0.0.1:3210/#${token}`, `http://127.0.0.1:3210/api/#${token}`, `http://127.0.0.1:3210/?token=${token}`, 'not a URL']) assert.equal(validConnection({url}), null);
  assert.equal(allowedNavigation('http://127.0.0.1:3210/#history', 'http://127.0.0.1:3210'), true);
  assert.equal(allowedNavigation('http://127.0.0.1:3211/', 'http://127.0.0.1:3210'), false);
  assert.equal(allowedNavigation('file:///C:/Users/', 'http://127.0.0.1:3210'), false);
  assert.equal(allowedNavigation('http://127.0.0.1:3210/api/state', 'http://127.0.0.1:3210'), false);
});

test('桌面从保存的路径找到原数据，显式环境变量优先', () => {
  const codexHome = path.join(tmpdir(), 'codex-home');
  const dataDirectory = path.join(tmpdir(), 'guard-custom-data');
  const config = desktopEnvironment({}, {codexHome, dataDirectory});
  assert.equal(config.dataDirectory, dataDirectory);
  assert.equal(config.env.CODEX_HOME, codexHome);
  const overrideHome = path.join(tmpdir(), 'override-home');
  assert.equal(desktopEnvironment({CODEX_HOME: overrideHome}, config.preferences).dataDirectory, path.join(overrideHome, 'model-guard'));
  assert.equal(desktopEnvironment({MODEL_GUARD_DATA: dataDirectory}, {codexHome}).dataDirectory, dataDirectory);
  assert.throws(() => desktopEnvironment({}, {codexHome: 'relative'}));
  assert.equal(desktopEnvironment({ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect'}, {}).env.NODE_OPTIONS, undefined);
});

test('桌面不会跟随服务重定向或接受其他产品', async t => {
  let externalRequests = 0;
  const other = http.createServer((_req, res) => { externalRequests++; res.end('{}'); });
  const server = http.createServer((_req, res) => { res.writeHead(302, {Location: `http://127.0.0.1:${other.address().port}/`}); res.end(); });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); other.close(); });
  const connection = validConnection({url: `http://127.0.0.1:${server.address().port}/#${token}`});
  assert.equal(await serviceReady(connection), false);
  assert.equal(externalRequests, 0);
});

test('桌面冷启动服务并复用同一进程，已有数据保留且不产生检测', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'guard-desktop-test-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, {recursive: true, force: true});
  });
  const account = {schema: 1, run: null, checks: [], profile: null};
  const sentinel = JSON.stringify(account);
  await writeFile(path.join(directory, 'account.json'), sentinel);
  const options = {directory, nodePath: process.execPath, root, env: process.env};
  const first = await ensureService(options);
  child = first.child;
  assert.equal(first.reused, false);
  assert.equal(first.connection.pid, child.pid);
  const second = await ensureService(options);
  assert.equal(second.reused, true);
  assert.equal(second.child, null);
  assert.equal(first.connection.url, second.connection.url);
  assert.equal(await readFile(path.join(directory, 'account.json'), 'utf8'), sentinel);
  const response = await fetch(first.connection.origin + '/api/state', {headers: {Authorization: 'Bearer ' + first.connection.token}});
  const state = await response.json();
  assert.equal(state.product, 'model-guard');
  assert.equal(state.sessions.length, 0);
  assert.equal(state.globalBudget.day, 0);
  assert.equal(state.account.checks.length, 0);
});

test('桌面启动失败给出明确错误，不改动已有数据', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'guard-desktop-failure-'));
  t.after(async () => { assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep)); await rm(directory, {recursive: true, force: true}); });
  const sentinel = '{"keep":"original"}';
  await writeFile(path.join(directory, 'state.json'), sentinel);
  await assert.rejects(ensureService({directory, nodePath: path.join(directory, 'missing-node.exe'), root, timeout: 2000}), /本地服务未能启动/);
  assert.equal(await readFile(path.join(directory, 'state.json'), 'utf8'), sentinel);
});
