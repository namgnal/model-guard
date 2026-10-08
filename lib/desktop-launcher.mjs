import http from 'node:http';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

// Only location preferences are persisted. No account credentials or model settings.
export function desktopEnvironment(env = process.env, saved = {}) {
  for (const key of ['codexHome', 'dataDirectory', 'codexPath']) {
    if (saved[key] !== undefined && (typeof saved[key] !== 'string' || !path.isAbsolute(saved[key]))) {
      throw Error('桌面配置中的路径无效：' + key);
    }
  }
  const codexHome = env.CODEX_HOME || saved.codexHome || path.join(homedir(), '.codex');
  const dataDirectory = env.MODEL_GUARD_DATA || (env.CODEX_HOME ? path.join(codexHome, 'model-guard') : saved.dataDirectory || path.join(codexHome, 'model-guard'));
  const codexPath = env.MODEL_GUARD_CODEX_PATH || env.MODELTRACE_CODEX_PATH || saved.codexPath;
  const childEnv = {...env, CODEX_HOME: codexHome, MODEL_GUARD_DATA: dataDirectory};
  if (codexPath) childEnv.MODEL_GUARD_CODEX_PATH = codexPath;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv.NODE_OPTIONS;
  return {dataDirectory, env: childEnv, preferences: {codexHome, dataDirectory, ...(codexPath ? {codexPath} : {})}};
}

export function validConnection(value) {
  try {
    const url = new URL(value?.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.pathname !== '/' || !/^#[a-f0-9]{64}$/.test(url.hash)) return null;
    return {url: url.href, origin: url.origin, token: url.hash.slice(1), pid: value.pid};
  } catch { return null; }
}

export async function readConnection(directory) {
  try { return validConnection(JSON.parse(await readFile(path.join(directory, 'server.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}

export function serviceReady(connection, timeout = 3000) {
  if (!connection) return Promise.resolve(false);
  return new Promise(resolve => {
    const request = http.get(connection.origin + '/api/state', {
      headers: {Authorization: 'Bearer ' + connection.token},
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) { request.destroy(); resolve(false); }
      });
      response.on('error', () => resolve(false));
      response.on('end', () => {
        try { resolve(response.statusCode === 200 && JSON.parse(body).product === 'model-guard'); }
        catch { resolve(false); }
      });
    });
    const deadline = setTimeout(() => { request.destroy(); resolve(false); }, timeout);
    request.on('close', () => clearTimeout(deadline));
    request.on('error', () => resolve(false));
  });
}

export async function ensureService({directory, nodePath, root, env = process.env, timeout = 20000}) {
  const existing = await readConnection(directory);
  if (await serviceReady(existing)) return {connection: existing, reused: true, child: null};
  const child = spawn(nodePath, [path.join(root, 'scripts/guard.mjs'), 'serve'], {
    cwd: root, env: {...env, MODEL_GUARD_DATA: directory}, detached: true,
    windowsHide: true, stdio: 'ignore',
  });
  let failed = null;
  child.on('error', error => { failed = error.code || 'SPAWN_FAILED'; });
  child.on('exit', code => { failed = 'EXIT_' + code; });
  child.unref();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const connection = await readConnection(directory);
    if (await serviceReady(connection, 1000)) return {connection, reused: connection.pid !== child.pid, child: connection.pid === child.pid ? child : null};
    if (failed) throw Error('本地服务未能启动（' + failed + '）。请检查运行目录或本地端口占用；已有监测状态已保留。');
    await delay(200);
  }
  throw Error('连接本地服务超时。请稍后重新打开守望；已有监测状态已保留。');
}

export function allowedNavigation(candidate, origin) {
  try { const url = new URL(candidate); return url.origin === origin && url.pathname === '/' && !url.username && !url.password; }
  catch { return false; }
}
