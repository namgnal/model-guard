import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProbePerformance,TurnPerformance,tokenUsage,distribution,performanceDashboard,SPEED_WORKLOAD} from '../lib/performance.mjs';
import {standaloneNativeProbe} from '../lib/native-probe.mjs';
import {probeAccount} from '../lib/account.mjs';
import {DEFAULTS,createState} from '../lib/policy.mjs';
import {Store} from '../lib/store.mjs';
import {command,dashboard} from '../lib/service.mjs';
import {scanTranscript} from '../lib/observe.mjs';
import {usageSummary} from '../lib/usage.mjs';
const profile={model:'test-model',provider:'test-provider',effort:'high'};
const id='01a07d27-0196-7f81-b7f5-833594641639';
const usage={inputTokens:1000,outputTokens:150,reasoningOutputTokens:50,cachedInputTokens:200};
async function sandbox(t){const root=path.resolve(tmpdir()),directory=await mkdtemp(path.join(root,'guard-performance-'));t.after(async()=>{assert.equal(path.dirname(directory),root);await rm(directory,{recursive:true,force:true});});return directory;}
function meterRun({tokens=usage,status='completed',chunks=3,extra=[]}={}){
 let now=0;const meter=new ProbePerformance({now:()=>now,workload:SPEED_WORKLOAD});now=200;meter.begin();
 const emit=(ms,method,params={})=>{now=ms+200;meter.observe({method,params:{turnId:'t',...params}});};
 emit(100,'item/reasoning/summaryTextDelta',{delta:'private reasoning summary'});
 for(let i=0;i<chunks;i++)emit(500+i*500,'item/agentMessage/delta',{itemId:'msg',delta:i?'many words in one chunk':'中文😀'});
 for(const e of extra)emit(1800,e.method,e.params);
 emit(1900,'thread/tokenUsage/updated',{tokenUsage:{last:tokens}});
 emit(2000,'turn/completed',{turn:{id:'t',status}});
 return {meter,result:meter.finish('t',{profile,status})};
}
test('单调计时区分启动、首个推理事件、首字、完成，块数不是 Token 数',()=>{
 const {result:r}=meterRun();assert.equal(r.setupMs,200);assert.equal(r.firstResponseMs,100);assert.equal(r.ttftMs,500);assert.equal(r.e2eMs,2000);
 assert.equal(r.estimatedOutputTps,66);assert.equal(r.estimatedTpotMs,15.152);assert.equal(r.outputTokensPerSecond,75);assert.equal(r.chunkGaps.p95,500);assert.equal(r.chunks,3);assert.equal(r.visibleOutputTokens,100);
 assert.equal(JSON.stringify(r).includes('private'),false);assert.equal(JSON.stringify(r).includes('many words'),false);
});
test('空块、无轮次事件、其他轮次不污染计时和用量',()=>{
 const {meter}=meterRun();meter.observe({method:'thread/tokenUsage/updated',params:{turnId:'other',tokenUsage:{last:{...usage,outputTokens:9999}}}});
 meter.observe({method:'item/agentMessage/delta',params:{delta:'text'}});
 const r=meter.finish('t',{profile});assert.equal(r.outputTokens,150);assert.equal(r.chunks,3);
 const m=new ProbePerformance({now:()=>0});m.begin();m.observe({method:'item/agentMessage/delta',params:{turnId:'t',delta:''}});assert.equal(m.finish('t').ttftMs,null);
});
test('短输出、单块、缺少推理分项和异常 Token 值不伪造生成速度',()=>{
 for(const options of [{tokens:{...usage,outputTokens:55}},{chunks:1},{tokens:{inputTokens:10,outputTokens:50}},{tokens:{...usage,outputTokens:-1}},{status:'failed'}])assert.equal(meterRun(options).result.estimatedOutputTps,null);
 assert.equal(tokenUsage({inputTokens:4,cachedInputTokens:5}).cachedInputTokens,null);
 assert.equal(tokenUsage({outputTokens:4,reasoningOutputTokens:5}).visibleOutputTokens,null);
 assert.equal(tokenUsage({inputTokens:'20'}).inputTokens,null);
});
test('重试、限流、工具与路由变化不能用于降速比较',()=>{
 for(const event of [{method:'error',params:{willRetry:true,error:{codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429}}}}},{method:'item/started',params:{item:{type:'commandExecution'}}},{method:'model/safetyBuffering/updated',params:{}}]){
  const r=meterRun({extra:[event]}).result;assert.equal(r.comparable,false);assert.equal(r.estimatedOutputTps,null);
  if(event.method==='error'){assert.equal(r.retries,1);assert.equal(r.rateLimits,1);}
 }
});
test('未知值不计为零，P50/P95按有效样本计算',()=>{
 assert.deepEqual(distribution([null,undefined,NaN,-1,'3',1,2,3,4]),{count:4,mean:2.5,p50:2.5,p95:3.85,max:4});assert.equal(distribution([]).mean,null);
});
const now=Date.now();
function sample(i,extra={}){return {schema:1,source:'native_app_server',scope:'standalone_account_probe',workload:SPEED_WORKLOAD,...profile,at:now-i*1000,status:'completed',comparable:true,ttftMs:i<5?2200:1000,estimatedOutputTps:i<5?20:40,...usage,visibleOutputTokens:100,...extra};}
function aggregate(samples){return performanceDashboard(null,{checks:samples.map(performance=>({result:{performance}}))},now);}
test('同条件近期五次比较基线，模型、档位、缓存及短探针不混算',()=>{
 const samples=Array.from({length:10},(_,i)=>sample(i));let g=aggregate(samples).groups[0];assert.equal(g.comparison.changes.length,2);assert.equal(g.comparison.changes[0].ratio,2.2);
 assert.equal(aggregate(samples.slice(0,9)).groups[0].comparison.changes.length,0);
 for(const changed of [{effort:'low'},{model:'different'},{workload:'metadata-v1'},{inputTokens:10000},{visibleOutputTokens:1000},{cachedInputTokens:900},{declaredModel:'different'},{comparable:false}]){
  g=aggregate(samples.map((s,i)=>i<5?s:{...s,...changed})).groups[0];assert.equal(g.comparison.changes.length,0);
 }
});
test('统计保留失败，排除旧记录、未来记录、失败耗时及旧版未知测量',()=>{
 const rows=[sample(0),sample(1,{status:'failed',ttftMs:99999}),sample(2,{at:now-8*86400000}),sample(3,{at:now+10000})];
 const g=aggregate(rows).groups[0];assert.equal(g.count,2);assert.equal(g.failedCount,1);assert.equal(g.stats.ttftMs.count,1);assert.equal(g.totals.inputTokens,1000);assert.equal(g.cacheHitRatio,.2);
 assert.equal(performanceDashboard({samples:[{at:now,usage:[usage]}]},null,now).groups.length,0);
});
function record(type,payload,ms=0){return {type,payload,timestamp:new Date(now+ms).toISOString()};}
function total(n){return {input_tokens:n,output_tokens:n/10,cached_input_tokens:0,reasoning_output_tokens:0};}
test('真实轮次用累计增量避免重复Token事件，耗时不冒充TTFT或解码速度',()=>{
 const m=new TurnPerformance();const events=[record('session_meta',{model_provider:'p'}),record('event_msg',{type:'token_count',info:{total_token_usage:total(100)}}),record('event_msg',{type:'task_started',turn_id:'t'}),record('turn_context',{turn_id:'t',model:'m',effort:'high'}),record('event_msg',{type:'token_count',info:{total_token_usage:total(200)}},1000),record('event_msg',{type:'token_count',info:{total_token_usage:total(200)}},1001),record('event_msg',{type:'task_complete',turn_id:'t'},2000)];
 events.forEach(e=>m.observe(e));const s=m.summary().samples[0];assert.equal(s.inputTokens,100);assert.equal(s.outputTokens,10);assert.equal(s.e2eMs,2000);assert.equal(s.ttftMs,null);assert.equal(s.estimatedOutputTps,null);assert.equal(s.model,'m');assert.equal(s.effort,'high');
 m.observe(events.at(-1));assert.equal(m.summary().samples.length,1);
});
test('轮次缺失基线、压缩、累计值倒退和中断均保留边界',()=>{
 for(const mode of ['no-base','reset','compacted']){
  const m=new TurnPerformance();if(mode!=='no-base')m.observe(record('event_msg',{type:'token_count',info:{total_token_usage:total(100)}}));
  m.observe(record('event_msg',{type:'turn_started',turn_id:'t'}));
  if(mode==='compacted')m.observe(record('compacted',{}));
  m.observe(record('event_msg',{type:'token_count',info:{total_token_usage:total(mode==='reset'?50:200)}},200));
  m.observe(record('event_msg',{type:'turn_aborted',turn_id:'t'},1000));
  assert.equal(m.summary().samples[0].inputTokens,null);assert.equal(m.summary().samples[0].status,'interrupted');
 }
});
test('记录所有权、正文伪造及其他轮次事件不注入实际性能',async t=>{
 const directory=await sandbox(t),file=path.join(directory,'test.jsonl');
 const events=[record('session_meta',{id}),record('response_item',{type:'task_started',turn_id:'fake'}),record('event_msg',{type:'task_complete',turn_id:'fake'},1000)];
 await writeFile(file,events.map(JSON.stringify).join('\n'));assert.equal((await scanTranscript(file,id)).performance.samples.length,0);await assert.rejects(()=>scanTranscript(file,'other'),/不属于/);
});
async function simulated(t,{fail=false,openPipes=false}={}){
 const directory=await sandbox(t),stderr=new EventEmitter();let now=0,calls=[];
 const c={child:openPipes?Object.assign(new EventEmitter(),{stderr}):{stderr},listeners:new Set(),closed:false,exited:new Promise(()=>{}),close:async()=>{c.closed=true;},request:async(method,p)=>{
  calls.push(method);if(method==='config/read')return {config:{}};
  if(method==='thread/start'){assert.match(p.baseInstructions,/latency/);return {thread:{id:'probe',ephemeral:true,path:null},model:profile.model,modelProvider:profile.provider,reasoningEffort:profile.effort};}
  if(method==='turn/interrupt')return {};
  if(method==='turn/start'){
   assert.match(p.input[0].text,/256/);const emit=(ms,method,params)=>{now=ms;for(const f of c.listeners)f({method,params:{threadId:'probe',turnId:'t',...params}});};
   for(const type of ['response.created','response.completed'])stderr.emit('data',Buffer.from(JSON.stringify({target:'codex_api::sse::responses',fields:{message:'SSE event: '+JSON.stringify({type,response:{id:'r',model:profile.model}})}})+'\n'));
   emit(500,'item/agentMessage/delta',{itemId:'m',delta:'private response'});emit(1000,'item/agentMessage/delta',{itemId:'m',delta:'tail'});
   emit(1500,'thread/tokenUsage/updated',{tokenUsage:{last:usage}});emit(1800,'thread/tokenUsage/updated',{turnId:'unrelated',tokenUsage:{last:{...usage,outputTokens:9999}}});
   if(fail)emit(1900,'error',{willRetry:false,error:{codexErrorInfo:'Other'}});
   emit(2000,'turn/completed',{turn:{id:'t',status:fail?'failed':'completed'}});return {turn:{id:'t'}};
  }throw Error(method);
 }};
 const run=()=>standaloneNativeProbe(profile,DEFAULTS,{directory,workload:SPEED_WORKLOAD,now:()=>now,connectFn:async()=>c});
 return {run,calls,c};
}
test('测速走一次原生请求，响应与同轮用量绑定，完整流被持久化为纯数值',async t=>{
 const sim=await simulated(t),raw=await sim.run();assert.equal(raw.performance.ttftMs,500);assert.equal(raw.performance.estimatedOutputTps,66);assert.equal(raw.usage.outputTokens,150);assert.equal(raw.performance.comparable,true);assert.equal(sim.calls.filter(c=>c==='turn/start').length,1);assert.equal(sim.calls.includes('thread/read'),false);assert.equal(JSON.stringify(raw).includes('private response'),false);
});
test('失败探针保留失败计时，不能伪造成功吞吐率',async t=>{
 const sim=await simulated(t,{fail:true});await assert.rejects(sim.run,error=>{assert.equal(error.performance.status,'failed');assert.equal(error.performance.estimatedOutputTps,null);assert.equal(error.performance.e2eMs,2000);return true;});assert.equal(sim.c.closed,true);
});
test('完整轮次但管道未关闭：保留客户端测量，身份校验仍抛错且不入比较基线',async t=>{
 const sim=await simulated(t,{openPipes:true});await assert.rejects(sim.run,error=>{assert.equal(error.code,'PROBE_STREAM_DRAIN');assert.equal(error.performance.status,'completed');assert.equal(error.performance.estimatedOutputTps,66);assert.equal(error.performance.comparable,false);assert.match(error.performance.diagnostic,/模型证据未知/);return true;});
});
test('测速预算、离线失败及导出不会修改任务门控或偷偷增加请求',async t=>{
 const directory=await sandbox(t),store=new Store(directory),state=createState({id});state.manualHold=true;await store.update(()=>({replace:state}),{create:true});await store.registry();const before=await readFile(store.file,'utf8');let calls=0;
 const deps={profileFn:async()=>profile,probeFn:async(_p,_policy,opts)=>{calls++;assert.equal(opts.workload,SPEED_WORKLOAD);const error=Error('test failure');error.performance=sample(0,{status:'failed'});throw error;}};
 await probeAccount(store,{workload:SPEED_WORKLOAD},deps);assert.equal(calls,1);assert.equal((await usageSummary(store)).day,1);assert.equal(await readFile(store.file,'utf8'),before);
 const d=await dashboard(store),g=d.performance.groups[0];assert.equal(g.failedCount,1);
 const result=await command(store,'performance-export',{targetId:id,groupId:g.id});const file=result.note.slice('性能数据已保存到：'.length);assert.equal(path.dirname(file),path.join(directory,'exports'));assert.equal(JSON.parse(await readFile(file,'utf8')).group.failedCount,1);
 await assert.rejects(()=>command(store,'performance-export',{targetId:id,groupId:'../bad'}),/没有可导出/);
 await assert.rejects(()=>probeAccount(store,{workload:'invalid'},deps),/不支持/);assert.equal(calls,1);assert.equal(await readFile(store.file,'utf8'),before);
});
