import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,updateJson} from './json-file.mjs';
import {alive} from './store.mjs';
import {standaloneNativeProbe,nativeVerdict} from './native-probe.mjs';
import {reserveUsage} from './usage.mjs';
import {DEFAULTS} from './policy.mjs';
import {accountProfile} from './runtime.mjs';
import {SPEED_WORKLOAD} from './performance.mjs';
const empty={schema:1,run:null,checks:[],profile:null};
export async function accountState(store){const a=await readJson(path.join(store.directory,'account.json'),empty);const interrupted=!!a.run&&(!alive(a.run.pid)||a.run.expiresAt<=Date.now());return {...a,run:interrupted?null:a.run,interrupted,latest:a.checks[0]||null};}
export async function probeAccount(store,input={},deps={}){
 const workload=input.workload||'metadata-v1';if(!['metadata-v1',SPEED_WORKLOAD].includes(workload))throw Error('不支持的测速任务');
 const profile=await (deps.profileFn||accountProfile)(input),file=path.join(store.directory,'account.json');
 const run={id:randomUUID(),pid:process.pid,at:Date.now(),expiresAt:Date.now()+180000};
 await updateJson(file,empty,a=>{if(a.run&&alive(a.run.pid)&&a.run.expiresAt>Date.now())throw Error('账号检测正在运行，请等待结果');a.run=run;a.profile=profile;});
 let result;
 try{
  if(!await reserveUsage(store,{...run,calls:1,scope:'account'}))throw Error('全局检测预算已用完，请等待额度恢复');
  const raw=await (deps.probeFn||standaloneNativeProbe)(profile,DEFAULTS,{directory:store.directory,workload});result=nativeVerdict(raw,profile.model,[]);
 }catch(e){result={verdict:'unknown',candidate:null,message:e.message,scope:'standalone_account_probe',identityVerified:false,performance:e.performance||null};}
 const check={id:run.id,at:Date.now(),profile,result};
 await updateJson(file,empty,a=>{if(a.run?.id!==run.id)return;a.run=null;a.checks=[check,...a.checks].slice(0,80);});
 return {result,account:await accountState(store)};
}
