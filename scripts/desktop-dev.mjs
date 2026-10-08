import {spawn} from 'node:child_process';
import path from 'node:path';
import {homedir} from 'node:os';
import electron from 'electron';
const root = path.resolve(import.meta.dirname, '..');
const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex');
const env = {...process.env, MODEL_GUARD_NODE_PATH: process.execPath,
  MODEL_GUARD_DATA: process.env.MODEL_GUARD_DEV_DATA || path.join(codexHome, 'model-guard-development')};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], {
  cwd: root, stdio: 'inherit', windowsHide: false,
  env,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
