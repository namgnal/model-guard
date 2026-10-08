import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {activeRuntime,resolveCodex} from '../lib/runtime-path.mjs';

const a='C:/Users/test/AppData/Local/OpenAI/Codex/bin/old/codex.exe';
const b='C:/Users/test/AppData/Local/OpenAI/Codex/bin/active/codex.exe';
const processFor=(executable,command='app-server --listen stdio://')=>({ExecutablePath:executable,CommandLine:`"${executable}" ${command}`});
test('多版本共存时只选择实际运行且唯一的桌面运行时',()=>{
  assert.equal(activeRuntime([a,b],[processFor(b),processFor(b)]),b);
  assert.equal(activeRuntime([a,b],[processFor(a,'exec-server'),processFor(b),processFor('C:/npm/codex.exe')]),b);
  assert.equal(activeRuntime([a,b],[processFor(b.toUpperCase())]),b);
  for(const rows of [[],[processFor(a),processFor(b)],[processFor('C:/npm/codex.exe')]])assert.throws(()=>activeRuntime([a,b],rows),/无法唯一确认/);
});
test('显式 runtime 优先，不可访问时不能悄悄回退',async()=>{
  let accesses=0;const explicit=path.resolve('custom-codex.exe');
  assert.equal(await resolveCodex({MODEL_GUARD_CODEX_PATH:explicit},{accessFn:async p=>{assert.equal(p,explicit);accesses++;},readdirFn:()=>{throw Error('不应探测');}}),explicit);
  assert.equal(accesses,1);
  await assert.rejects(()=>resolveCodex({MODEL_GUARD_CODEX_PATH:explicit},{accessFn:async()=>{throw Error('missing');}}),/missing/);
  await assert.rejects(()=>resolveCodex({MODEL_GUARD_CODEX_PATH:'relative'}),/绝对路径/);
});
test('候选目录与运行进程必须相互印证，查询失败保持歧义',async()=>{
  const env={LOCALAPPDATA:path.resolve('test-local-appdata')};
  const options={platform:'win32',accessFn:async()=>{},readdirFn:async()=>['old','current'].map(name=>({name,isDirectory:()=>true}))};
  const expected=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin','current','codex.exe');
  assert.equal(await resolveCodex(env,{...options,processesFn:async()=>[processFor(expected)]}),expected);
  await assert.rejects(()=>resolveCodex(env,{...options,processesFn:async()=>{throw Error('denied');}}),/无法唯一确认/);
});
