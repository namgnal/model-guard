import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access,readdir} from 'node:fs/promises';
import path from 'node:path';

const execute=promisify(execFile);
async function runningCodex(env){
  const shell=path.join(env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
  const script="Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const {stdout}=await execute(shell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:5000,maxBuffer:1024*1024});
  const value=stdout.trim()?JSON.parse(stdout):[];
  return Array.isArray(value)?value:[value];
}

// Match an installed runtime to an actually running desktop app-server. Never
// select the newest directory or a PATH CLI merely because it is available.
export function activeRuntime(candidates,processes){
  const active=new Set();
  for(const process of processes){
    if(!/(?:^|\s)app-server(?:\s|$)/.test(process.CommandLine||''))continue;
    const executable=candidates.find(p=>path.win32.normalize(p).toLowerCase()===path.win32.normalize(process.ExecutablePath||'').toLowerCase());
    if(executable)active.add(executable);
  }
  if(active.size===1)return [...active][0];
  throw Error('发现多套 Codex 运行时，无法唯一确认正在使用的版本。请打开 Codex，或用 MODEL_GUARD_CODEX_PATH 指定其 codex.exe。');
}

export async function resolveCodex(env=process.env,{platform=process.platform,accessFn=access,readdirFn=readdir,processesFn=runningCodex}={}){
  const explicit=env.MODEL_GUARD_CODEX_PATH||env.MODELTRACE_CODEX_PATH;
  if(explicit){
    if(!path.isAbsolute(explicit))throw Error('MODEL_GUARD_CODEX_PATH 必须是可执行文件的绝对路径');
    await accessFn(explicit);return explicit;
  }
  if(platform==='win32'&&env.LOCALAPPDATA){
    const root=path.join(env.LOCALAPPDATA,'OpenAI','Codex','bin');
    const entries=await readdirFn(root,{withFileTypes:true}).catch(()=>[]),candidates=[];
    for(const entry of entries.filter(e=>e.isDirectory())){
      const executable=path.join(root,entry.name,'codex.exe');
      try{await accessFn(executable);candidates.push(executable);}catch{}
    }
    if(candidates.length===1)return candidates[0];
    if(candidates.length>1)return activeRuntime(candidates,await processesFn(env).catch(()=>[]));
  }
  return platform==='win32'?'codex.exe':'codex';
}
