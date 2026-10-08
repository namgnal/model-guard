import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {ROOT,record,alive,validId} from './store.mjs';
import {reserveUsage} from './usage.mjs';
import {artifacts,classify} from './fingerprint.mjs';
import {collect,doctor} from './runtime.mjs';
import {routingDecision} from './telemetry.mjs';
import {nativeProbe,nativeVerdict} from './native-probe.mjs';
import {beginRun,applyEvidence,handleEvent,pause,due} from './policy.mjs';
export async function checkRuntime(store){const state=await store.read();const r=await doctor(state.target);await store.update(s=>{Object.assign(s.verification,{runtimeReady:r.runtimeReady,hookReady:r.hookReady});s.source=r.source;record(s,'doctor',r.note);});return r;}
export async function tick(store,{force=false,collectFn=collect,nativeFn=nativeProbe}={}){
  const initial=await store.read();
  if(initial?.strategy!=='native'&&(force||initial?.strategy==='fingerprint')&&(!initial?.verification.hookReady||!initial?.verification.runtimeReady))return {started:false,reason:'请先完成运行时与可信拦截器检查；未消耗模型用量'};
  if(initial?.strategy==='native'&&!initial.verification.runtimeReady)return {started:false,reason:'请先完成运行时检查；未消耗模型用量'};
  const fingerprintAssets=initial?.strategy==='fingerprint'?await artifacts():null;
  if(fingerprintAssets&&!fingerprintAssets.bank.models.some(m=>m.id===initial.expected))return {started:false,reason:'预期模型不在当前指纹库中，请选择原生短请求检测；未消耗模型用量'};
  let run,state;await store.update(s=>{
    if(s.run&&(!alive(s.run.pid)||Date.now()>s.run.expiresAt)){s.epoch++;s.run=null;pause(s,'worker_lost','检测进程已结束或超时，旧样本不会放行');}
    state=structuredClone(s);run=beginRun(s,Date.now(),force);
  });if(!run)return {started:false};
  let result,raw;
  try{
    if(!await reserveUsage(store,{...run,calls:run.method==='native'?1:3,scope:state.target.id}))throw Error('全局检测预算已用完，等待预算恢复');
    const cancelled=async()=>{const s=await store.read();return s.run?.id!==run.id||s.epoch!==run.epoch||s.manualHold||!s.enabled;};
    if(run.method==='native'){raw=await nativeFn(state.target,state.policy,cancelled,{directory:store.directory});result=nativeVerdict(raw,run.expected,state.approvedMappings||[]);}
    else {const {bank,meta}=fingerprintAssets||await artifacts();
    raw=await collectFn(state.target,state.policy,cancelled);
    result=classify(raw.outputs,bank,run.expected,state.policy);
    result.sourceModel=raw.source.model;result.provider=raw.source.provider;result.effort=raw.source.effort;result.telemetry=raw.outputs.map(o=>o.telemetry);result.usage=raw.outputs.map(o=>o.usage);result.bankHash=meta.sha256['unified_bank.json'];
    const routes=raw.outputs.filter(o=>o.telemetry).map(o=>routingDecision(o.telemetry,run.expected,state.approvedMappings||[]));
    if(routes.some(r=>r.pause&&!r.inconclusive)){result.verdict='mismatch';result.message='观察到尚未认可的上游名称差异或声明冲突，暂停复核；不据此推断差异原因';}
    else if(routes.some(r=>r.inconclusive)){result.verdict='unknown';result.message='原生路由或安全缓冲证据不足，本轮保持未知';}
    result.method='fingerprint';}
  }catch(e){result={verdict:'unknown',message:e.message,sampleCount:raw?.outputs?.length||0,performance:e.performance||null};}
  await store.eventSnapshot({id:run.id,at:Date.now(),epoch:run.epoch,result,raw:raw||null});
  let accepted;await store.update(s=>{accepted=applyEvidence(s,run,result);});return {started:true,accepted,result};
}
async function hookSingle(store,event){
  if(process.env.MODEL_GUARD_PROBE==='1'){
    if(event.hook_event_name==='PreToolUse')return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'守望探针只允许文本回答，不允许任何工作工具。'}};
    return {};
  }
  let s;try{s=await store.read();}catch{
    const target=JSON.parse(await readFile(path.join(path.dirname(store.file),'target.json'),'utf8').catch(()=>'null'));
    if(!target||![event.session_id,event.parent_session_id].includes(target.id))return {};
    const reason='守望状态损坏，目标任务暂不执行新增工具；请检查本地监测状态。';
    if(event.hook_event_name==='PreToolUse')return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}};
    if(event.hook_event_name==='Stop')return {continue:false,stopReason:reason};
    if(event.hook_event_name==='UserPromptSubmit')return {decision:'block',reason};
    return {systemMessage:reason};
  }
  if(!s||![event.session_id,event.parent_session_id].includes(s.target.id))return {};
  let output,shouldTick;await store.update(x=>{output=handleEvent(x,event);shouldTick=due(x);});
  // Trigger in an independent process; inference never blocks the tool hook.
  if(['PostToolUse','SessionStart','UserPromptSubmit'].includes(event.hook_event_name)&&shouldTick){
    const child=spawn(process.execPath,[path.join(ROOT,'scripts/guard.mjs'),'tick','--target',s.target.id],{detached:true,windowsHide:true,stdio:'ignore',env:{...process.env,MODEL_GUARD_DATA:store.directory}});child.on('error',()=>{});child.unref();
  }
  return output;
}
export async function hook(store,event){
  if(process.env.MODEL_GUARD_PROBE==='1')return hookSingle(store,event);
  const ids=[...new Set([event.session_id,event.parent_session_id].filter(validId))];let entries;
  try{entries=(await store.registry()).targets.filter(entry=>ids.includes(entry.id));}
  catch{
    // A broken registry must not block unrelated tasks. Retain only explicitly
    // recorded target metadata, including the legacy root, for scoped closure.
    entries=[];for(const id of ids)for(const file of ['state.json',path.join('targets',id,'state.json')]){
      const scoped=store.scope({id,file});const target=JSON.parse(await readFile(path.join(path.dirname(scoped.file),'target.json'),'utf8').catch(()=>'null'));
      if(target?.id===id)entries.push({id,file});
    }
  }
  let output={};for(const entry of entries){const next=await hookSingle(store.scope(entry),event);
    if(next.hookSpecificOutput?.permissionDecision==='deny'||next.decision==='block'||next.continue===false)return next;
    if(Object.keys(next).length)output=next;
  }return output;
}
