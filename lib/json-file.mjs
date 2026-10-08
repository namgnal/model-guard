import {mkdir,readFile,open,unlink,stat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {atomic,alive} from './store.mjs';

// Shared locked read/modify/write for registry, account checks and global usage.
export async function readJson(file,fallback){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return structuredClone(fallback);throw e;}}
export async function updateJson(file,fallback,fn){
 await mkdir(path.dirname(file),{recursive:true});const lock=file+'.lock';let handle;
 for(let i=0;i<100;i++){
  try{handle=await open(lock,'wx');await handle.writeFile(JSON.stringify({pid:process.pid}));break;}
  catch(e){if(e.code!=='EEXIST')throw e;
   try{const owner=JSON.parse(await readFile(lock,'utf8'));if(Number.isSafeInteger(owner.pid)&&!alive(owner.pid))await unlink(lock);}
   catch(err){if(err instanceof SyntaxError){const info=await stat(lock).catch(()=>null);if(info&&Date.now()-info.mtimeMs>30000)throw Error('数据锁损坏，请检查；未强行接管');}else if(err.code!=='ENOENT')throw err;}
   await delay(20);
  }
 }
 if(!handle)throw Error('数据正忙，请稍后重试');
 try{const data=await readJson(file,fallback),result=await fn(data);await atomic(file,data);return result;}
 finally{await handle.close();await unlink(lock);}
}
