#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {init,command} from '../lib/service.mjs';
import {hook} from '../lib/engine.mjs';
import {serve} from '../lib/server.mjs';
export async function main(args=process.argv.slice(2)){
 const options=[...args],targetIndex=options.indexOf('--target');let targetId;
 if(targetIndex>=0){targetId=options[targetIndex+1];if(!targetId)throw Error('--target 缺少会话 ID');options.splice(targetIndex,2);}
 const store=new Store(),[action='status',arg]=options;
 if(action==='hook'){let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4*1024*1024)throw Error('Hook 输入过大');}return hook(store,JSON.parse(input));}
 if(action==='init')return init(store);
 if(action==='serve'){
  await init(store);let options={};
  try{
   const saved=JSON.parse(await readFile(path.join(store.directory,'server.json'),'utf8'));
   const url=new URL(saved.url),token=url.hash.slice(1),port=Number(url.port);
   if(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number.isInteger(port)&&port>0&&port<=65535&&/^[a-f0-9]{64}$/.test(token))options={port,token};
  }catch(e){if(e.code&&e.code!=='ENOENT')throw e;}
  const r=await serve(store,options);return {url:r.url};
 }
 let data={};if(['mode','strategy','target-select','target-remove','target-add'].includes(action))data=action==='mode'?{mode:arg}:action==='strategy'?{strategy:arg}:{id:arg};else if(['claim-resume','account-probe'].includes(action)){let input='';for await(const chunk of process.stdin)input+=chunk;data=input?JSON.parse(input):{};}
 const taskActions=['status','doctor','observe','probe','tick','mode','strategy','settings','bridge-ready','claim-resume'];
 if(taskActions.includes(action)){
  targetId??=data.threadId??(await store.registry()).defaultId;
  if(!targetId&&action!=='status')throw Error('请通过 --target 指定会话');
  if(targetId)data.targetId=targetId;
 }
 return command(store,action,data);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{console.log(JSON.stringify(await main(),null,2));}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}}
