import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT,record,atomic,validId} from './store.mjs';
import {createState,enabledMode,claimResume,budget,fresh,validatePolicy} from './policy.mjs';
import {checkRuntime,tick} from './engine.mjs';
import {observe} from './observe.mjs';
import {inspectThread,listThreads,accountOptions,doctor} from './runtime.mjs';
import {accountState,probeAccount} from './account.mjs';
import {usageSummary} from './usage.mjs';
import {readJson} from './json-file.mjs';
import {VERSION} from './version.mjs';
import {performanceDashboard} from './performance.mjs';

export async function init(store){
 // Existing single-target state remains in place; a fresh installation starts
 // with zero tasks and can immediately use independent account checks.
 await store.registry();return dashboard(store);
}
export async function sessionSummaries(store,activeId){
 const result=[];for(const {entry,store:scoped} of await store.scopes()){
  try{const s=await scoped.read();if(!s)throw Error('会话状态缺失');result.push({id:entry.id,title:entry.title||s.target.title,hostId:entry.hostId||'local',active:entry.id===activeId,enabled:s.enabled,mode:s.mode,phase:s.phase,model:s.source?.model||s.expected,manualHold:!!s.manualHold,latestPassAt:s.lastPassAt||null});}
  catch(e){result.push({id:entry.id,title:entry.title,active:entry.id===activeId,error:e.message});}
 }return result;
}
export function publicState(s){
 if(!s)return null;const copy=structuredClone(s);if(copy.source)delete copy.source.transcriptPath;if(copy.action)delete copy.action.marker;delete copy.accountCheck;
 copy.budget=budget(s,s.strategy==='native'?1:3);copy.readiness=readiness(s);copy.evidenceFresh=fresh(s);return copy;
}
export async function dashboard(store,targetId){
 const registry=await store.registry(),selected=await store.selected(targetId),s=selected?await selected.store.read():null;
 if(targetId&&!selected)throw Error('会话未添加');
 const account=await accountState(store);
 return {...(s?publicState(s):{target:null}),product:'model-guard',version:VERSION,activeTargetId:selected?.entry.id||null,sessions:await sessionSummaries(store,selected?.entry.id),account,performance:performanceDashboard(s,account),globalBudget:await usageSummary(store)};
}
export function readiness(s){return [
 {id:'tests',label:'离线行为测试',ok:s.verification.testsPassed},
 {id:'runtime',label:'原生接口可读取',ok:s.verification.runtimeReady},
 {id:'hooks',label:'拦截器已安装并受信任',ok:s.verification.hookReady},
 {id:'event',label:'目标任务实际触发过拦截器',ok:s.hook.seen},
 {id:'evidence',label:'真实检测通过',ok:s.verification.pilotPassed},
 {id:'bridge',label:'恢复调度已接通',ok:s.bridge.ready&&Date.now()-s.bridge.lastAt<15*60000}
 ];}
export async function selftest(store){
 const files=(await readdir(path.join(ROOT,'tests'))).filter(f=>f.endsWith('.test.mjs')).map(f=>path.join(ROOT,'tests',f));if(!files.length)throw Error('没有可运行的测试');
 const result=await new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--test',...files],{cwd:ROOT,windowsHide:true,env:{...process.env,MODEL_GUARD_DATA:path.join(store.directory,'test-isolation')}});let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('error',reject);p.on('close',code=>resolve({passed:code===0,exitCode:code,output,at:Date.now()}));});
 await atomic(path.join(store.directory,'test-report.json'),result);
 for(const {store:scoped} of await store.scopes())await scoped.update(s=>{s.verification.testsPassed=result.passed;record(s,'tests',result.passed?'离线行为测试通过':'离线行为测试失败');});
 return result;
}
export async function command(store,action,data={},deps={}){
 if(action==='status')return dashboard(store,data.targetId);
 if(action==='targets'){const r=await store.registry();return {activeTargetId:r.activeId,sessions:await sessionSummaries(store,r.activeId)};}
 if(action==='discover')return (deps.listFn||listThreads)({limit:30,cursor:data.cursor||null,searchTerm:data.searchTerm||''});
 if(action==='account-settings')return (deps.optionsFn||accountOptions)();
 if(action==='performance-export'){
  const state=await dashboard(store,data.targetId||undefined),group=state.performance.groups.find(g=>g.id===data.groupId);
  if(!group)throw Error('没有可导出的性能分组');
  const file=path.join(store.directory,'exports',`performance-${Date.now()}-${randomUUID()}.json`);
  await atomic(file,{schema:1,exportedAt:Date.now(),windowDays:7,note:'客户端观测；近7天、各来源最近80条，明细最多30条；块不等于Token，轮次包含工具耗时。',group});
  return {note:'性能数据已保存到：'+file};
 }
 if(action==='account-probe')return probeAccount(store,{model:data.model,effort:data.effort,workload:data.workload},deps);
 if(action==='selftest')return selftest(store);
 if(action==='target-select'){await store.selectScope(data.id);return dashboard(store);}
 if(action==='target-remove'){await store.removeScope(data.id);return dashboard(store);}
 if(action==='target-add'){
  if(!validId(data.id))throw Error('请输入有效的会话 ID');
  if((await store.registry()).targets.some(x=>x.id===data.id))throw Error('这个会话已经添加');
  const source=await (deps.inspectFn||inspectThread)(data.id),next=createState({id:data.id,title:source.title,hostId:'local'});
  const checked=await (deps.doctorFn||doctor)(next.target);
  enabledMode(next,'observe');next.expected=source.model;next.source=source;
  Object.assign(next.verification,{runtimeReady:checked.runtimeReady,hookReady:checked.hookReady,testsPassed:(await readJson(path.join(store.directory,'test-report.json'),null))?.passed===true});
  await store.addScope(next);return dashboard(store);
 }
 // Task mutations must name their task. UI selection is presentation state only.
 const id=data.targetId||(action==='claim-resume'?data.threadId:null);
 if(!validId(id))throw Error('操作需要明确的 targetId，不使用界面选中项代替');
 const selected=await store.selected(id);if(!selected)throw Error('会话未添加');const targetStore=selected.store;
 switch(action){
 case 'doctor':try{const r=await checkRuntime(targetStore);await observe(targetStore);return {...r,source:{...r.source,transcriptPath:undefined}};}catch(e){await targetStore.update(s=>{s.verification.runtimeReady=false;s.verification.hookReady=false;record(s,'doctor_error',e.message);});throw e;}
 case 'observe':return observe(targetStore);
 case 'probe':return tick(targetStore,{force:true,...deps});
 case 'tick':return tick(targetStore,deps);
 case 'mode':await targetStore.update(s=>enabledMode(s,data.mode));return publicState(await targetStore.read());
 case 'settings':await targetStore.update(s=>{if(s.mode==='protect')throw Error('先切回观察模式再更改设置');s.policy=validatePolicy(data.policy);s.epoch++;s.run=null;record(s,'settings','已更新检测间隔和用量上限');});return publicState(await targetStore.read());
 case 'strategy':if(!['passive','native','fingerprint'].includes(data.strategy))throw Error('策略无效');await targetStore.update(s=>{if(s.mode==='protect')throw Error('先切回观察模式，再更改检测方法');s.strategy=data.strategy;s.epoch++;s.run=null;s.lastPassAt=null;s.phase='unknown';s.verification.pilotPassed=false;record(s,'strategy',{passive:'已选择被动观察；不自动发起采样',native:'已选择原生短请求，每轮一次；不手工读取登录令牌',fingerprint:'已选择指纹备用检测，每轮最多三次模型请求'}[data.strategy]);});return publicState(await targetStore.read());
 case 'claim-resume':{let result;await targetStore.update(s=>{result=claimResume(s,data);});return result;}
 case 'bridge-ready':await targetStore.update(s=>{s.bridge={ready:true,lastAt:Date.now()};});return {ready:true,threadId:id};
 default:throw Error('不支持的操作');
 }
}
