import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {NativeTrace,standaloneNativeProbe,nativeVerdict} from '../lib/native-probe.mjs';
import {DEFAULTS,createState} from '../lib/policy.mjs';
import {strictArray,artifacts} from '../lib/fingerprint.mjs';
import {Store} from '../lib/store.mjs';
import {tick} from '../lib/engine.mjs';
import {usageSummary} from '../lib/usage.mjs';

const profile={model:'gpt-6.1-sol',provider:'openai',effort:'high'};
function log(frame){return Buffer.from(JSON.stringify({target:'codex_api::sse::responses',fields:{message:'SSE event: '+JSON.stringify(frame)}})+'\n');}
const frame=(type,extra={})=>({type,response:{id:'response-1',model:profile.model,...extra}});
async function sandbox(t){const directory=await mkdtemp(path.join(tmpdir(),'guard-update-test-'));t.after(async()=>{assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir())+path.sep));await rm(directory,{recursive:true,force:true});});return directory;}

test('原生元数据帧绑定当前响应，开始结束必须有序，失败或额外响应保持未知',()=>{
 const trace=new NativeTrace(profile.model);
 trace.feed(log({type:'response.metadata',headers:{'openai-model':'unbound-model'}}));
 trace.feed(log(frame('response.created')));
 trace.feed(log({type:'response.metadata',headers:{'x-openai-model':profile.model}}));
 trace.feed(log(frame('response.completed')));
 assert.equal(trace.result().declarationSource,'response_header');
 for(const frames of [
  [frame('response.completed'),frame('response.created')],
  [frame('response.created'),frame('response.incomplete'),frame('response.completed')],
  [frame('response.created'),frame('response.completed'),frame('response.created',{id:'extra'})],
 ]){const t=new NativeTrace(profile.model);frames.forEach(f=>t.feed(log(f)));assert.throws(()=>t.result(),/完整/);}
});

async function simulatedProbe(t,events,{includeLogs=true,completeId='turn-1',failureOnClose=false,lateLogs=false}={}){
 const directory=await sandbox(t),stderr=new EventEmitter();
 const child=lateLogs?Object.assign(new EventEmitter(),{stderr}):{stderr};
 const c={child,listeners:new Set(),exited:new Promise(()=>{}),closed:false,close:async()=>{if(c.closed)return;c.closed=true;if(failureOnClose)c.failure=Error('protocol failure');if(lateLogs)setImmediate(()=>{stderr.emit('data',log(frame('response.created')));stderr.emit('data',log(frame('response.completed')));child.emit('close',0);});},request:async(method,args)=>{
  if(method==='config/read')return {config:{}};
  if(method==='thread/start')return {thread:{id:'probe',ephemeral:true,path:null},model:profile.model,modelProvider:profile.provider,reasoningEffort:profile.effort};
  if(method==='turn/start'){
   if(includeLogs){stderr.emit('data',log(frame('response.created')));stderr.emit('data',log(frame('response.completed')));}
   for(const event of events)for(const listen of c.listeners)listen(event);
   for(const listen of c.listeners)listen({method:'turn/completed',params:{threadId:'probe',turn:{id:completeId,status:'completed'}}});
   return {turn:{id:'turn-1'}};
  }
  if(method==='turn/interrupt')return {};
  throw Error('unexpected '+method);
 }};
 return standaloneNativeProbe(profile,DEFAULTS,{directory,connectFn:async()=>c});
}
const reroute=(threadId='probe',turnId='turn-1')=>({method:'model/rerouted',params:{threadId,turnId,fromModel:profile.model,toModel:'gpt-6-luna',reason:'test'}});
test('探针订阅同一会话同一轮的改路由，名称相同也不能掩盖改路由',async t=>{
 const raw=await simulatedProbe(t,[reroute()]);assert.equal(raw.telemetry.reroutes.length,1);assert.equal(nativeVerdict(raw,profile.model).routingState,'unexpected_reroute');assert.equal(nativeVerdict(raw,profile.model).verdict,'mismatch');
 const unrelated=await simulatedProbe(t,[reroute('other'),reroute('probe','other-turn')]);assert.equal(unrelated.telemetry.reroutes.length,0);assert.equal(nativeVerdict(unrelated,profile.model).verdict,'match');
});
test('没有响应声明的传输保持未知，但原生改路由仍可提示差异',async t=>{
 const raw=await simulatedProbe(t,[],{includeLogs:false});assert.equal(nativeVerdict(raw,profile.model).verdict,'unknown');assert.equal(raw.telemetry.declared,null);
 const routed=await simulatedProbe(t,[reroute()],{includeLogs:false});assert.equal(nativeVerdict(routed,profile.model).verdict,'mismatch');
});
test('安全缓冲、缺少轮次或错误完成轮次不能用来放行',async t=>{
 const raw=await simulatedProbe(t,[{method:'model/safetyBuffering/updated',params:{threadId:'probe',turnId:'turn-1',model:profile.model,fasterModel:'gpt-6-luna'}}]);
 assert.equal(nativeVerdict(raw,profile.model).verdict,'unknown');assert.equal(nativeVerdict(raw,profile.model).routingState,'safety_buffering');
 const missing=reroute();delete missing.params.turnId;const malformed=await simulatedProbe(t,[missing]);assert.equal(nativeVerdict(malformed,profile.model).verdict,'unknown');
 await assert.rejects(()=>simulatedProbe(t,[],{completeId:'different-turn'}),/轮次不一致/);
});
test('等待输出管道排空，完成后的协议异常不能被成功回执掩盖',async t=>{
 const late=await simulatedProbe(t,[],{includeLogs:false,lateLogs:true});assert.equal(nativeVerdict(late,profile.model).verdict,'match');
 await assert.rejects(()=>simulatedProbe(t,[],{failureOnClose:true}),/协议异常/);
});
test('更新指纹库包含 Sol、Luna；尚未收录的新模型在花费预算前拒绝采样',async t=>{
 const {bank,meta}=await artifacts();assert.equal(bank.models.length,16);assert.equal(meta.commit,'df3a0f9d3e054c0dc02d6d586686db8daf8fa7c8');
 for(const id of ['gpt-6-sol','gpt-6-luna'])assert.ok(bank.models.some(m=>m.id===id));
 const directory=await sandbox(t),store=new Store(directory),state=createState({id:'01a07d27-0196-7f81-b7f5-833594641639'});
 state.expected=profile.model;state.strategy='fingerprint';state.enabled=true;state.verification.hookReady=true;state.verification.runtimeReady=true;
 await store.update(()=>({replace:state}),{create:true});let calls=0;
 const result=await tick(store,{force:true,collectFn:async()=>{calls++;throw Error('must not infer');}});
 assert.equal(result.started,false);assert.match(result.reason,/不在当前指纹库/);assert.equal(calls,0);assert.equal((await usageSummary(store)).day,0);assert.equal((await store.read()).reservations.length,0);
});
test('指纹接受完整 JSON 展示包装，但不修补样本或放宽整数与数量要求',()=>{
 for(const text of ['[1,2,3]','```JSON\n[1,2,3]\n```','~~~~json\r\n[1,2,3]\r\n~~~~'])assert.deepEqual(strictArray(text,3),[1,2,3]);
 for(const text of ['```json\n[1,2,3]','```json\n[1,2,3]\n~~~','[1e0,2,3]','[1.0,2,3]','[1,2]','[1,2,3] explanation','~~~json\n[1,2,3]\n~~~\n~~~\n[1,2,3]\n~~~'])assert.throws(()=>strictArray(text,3));
});
