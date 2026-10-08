import {app, BrowserWindow, dialog, Menu, nativeTheme, screen} from 'electron';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {watch, writeFileSync} from 'node:fs';
import path from 'node:path';
import {desktopEnvironment, ensureService, allowedNavigation} from '../lib/desktop-launcher.mjs';

const dev = !app.isPackaged;
app.setName(dev ? 'Model Guard Development' : 'Model Guard');
if (process.env.MODEL_GUARD_DESKTOP_HOME) app.setPath('userData', path.resolve(process.env.MODEL_GUARD_DESKTOP_HOME));
app.setAppUserModelId(dev ? 'local.modelguard.development' : 'local.modelguard.desktop');
const profile = app.getPath('userData');
let window, connection, service, webWatcher;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    webWatcher?.close();
    // Production keeps its detached service alive, as the web launcher did.
    // Development closes only the isolated service started by this process.
    if (dev && service?.child) service.child.kill();
  });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('守望启动失败', error.message); app.quit(); });
}

async function readOptional(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw Error('桌面配置无法读取，请检查：' + path.basename(file)); }
}

async function start() {
  await mkdir(profile, {recursive: true});
  const settingsPath = path.join(profile, 'desktop-config.json');
  const saved = await readOptional(settingsPath);
  const config = desktopEnvironment(process.env, saved || {});
  if (!saved) await writeFile(settingsPath, JSON.stringify(config.preferences, null, 2));
  const root = dev ? path.resolve(import.meta.dirname, '..') : path.join(process.resourcesPath, 'service');
  const nodePath = dev ? process.env.MODEL_GUARD_NODE_PATH : path.join(process.resourcesPath, 'runtime', 'node.exe');
  if (!nodePath) throw Error('请通过 npm run desktop 启动开发窗口。');
  let bounds = {};
  try { bounds = await readOptional(path.join(profile, 'window.json')) || {}; } catch {}
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(Number(bounds.width) || 1320, 900), area.width);
  const height = Math.min(Math.max(Number(bounds.height) || 880, 600), area.height);
  const position = Number.isFinite(bounds.x) && Number.isFinite(bounds.y) && screen.getAllDisplays().some(({workArea: a}) => bounds.x >= a.x && bounds.y >= a.y && bounds.x + 120 < a.x + a.width && bounds.y + 60 < a.y + a.height) ? {x: bounds.x, y: bounds.y} : {};
  window = new BrowserWindow({
    width, height, ...position, minWidth: 800, minHeight: 560,
    show: false, title: dev ? '守望 · 开发预览' : '守望 · Model Guard',
    icon: path.join(app.getAppPath(), 'assets/icon.ico'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101722' : '#f4f6fa',
    autoHideMenuBar: true,
    webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: dev},
  });
  Menu.setApplicationMenu(null);
  const session = window.webContents.session;
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  for (const event of ['will-navigate', 'will-redirect']) window.webContents.on(event, (e, url) => {
    if (!connection || !allowedNavigation(url, connection.origin)) e.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('page-title-updated', event => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
      event.preventDefault(); if (connection) window.loadURL(connection.url).catch(() => {});
    }
  });
  window.once('ready-to-show', () => { if (bounds.maximized) window.maximize(); window.show(); });
  window.on('close', () => {
    const state = {...window.getNormalBounds(), maximized: window.isMaximized()};
    // Save synchronously on close so the next launch restores the last size.
    try { writeFileSync(path.join(profile, 'window.json'), JSON.stringify(state)); } catch {}
  });
  window.on('closed', () => { window = null; });
  await window.loadFile(path.join(import.meta.dirname, 'loading.html'));
  while (window) {
    try {
      service = await ensureService({directory: config.dataDirectory, nodePath, root, env: config.env});
      connection = service.connection;
      if (!window) return;
      await window.loadURL(connection.url);
      break;
    } catch (error) {
      if (!window) return;
      const {response} = await dialog.showMessageBox(window, {type: 'error', title: '暂时无法打开守望', message: error.message, buttons: ['重试', '关闭窗口'], defaultId: 0, cancelId: 1});
      if (response === 1) { window.close(); return; }
    }
  }
  if (dev && window) {
    let refresh;
    webWatcher = watch(path.join(root, 'web'), () => { clearTimeout(refresh); refresh = setTimeout(() => { if (window && connection) window.loadURL(connection.url).catch(() => {}); }, 180); });
    window.webContents.on('before-input-event', (_event, input) => { if (input.key === 'F12' && input.type === 'keyDown') window.webContents.toggleDevTools(); });
  }
}
