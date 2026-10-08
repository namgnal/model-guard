import {StringDecoder} from 'node:string_decoder';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {connect,settings} from './runtime.mjs';
import {DATA} from './store.mjs';
import {Telemetry,routingDecision} from './telemetry.mjs';
import {ProbePerformance,SPEED_WORKLOAD,SPEED_PROMPT} from './performance.mjs';

// This parser never stores raw logs, message text, headers, credentials or prompts.
// Each isolated native process runs one probe, so declarations cannot come from
// another desktop task. Bind created/completed frames to the same response id.
export class NativeTrace {
 constructor(requested){this.requested=requested;this.decoder=new StringDecoder('utf8');this.pending='';this.responses=new Map();this.failed=false;this.activeId=null;}
 feed(chunk){this.pending+=this.decoder.write(chunk);if(this.pending.length>4*1024*1024){this.failed=true;this.pending='';return;}
  let i;while((i=this.pending.indexOf('\n'))>=0){const line=this.pending.slice(0,i);this.pending=this.pending.slice(i+1);let record;try{record=JSON.parse(line);}catch{continue;}
   if(record.target!=='codex_api::sse::responses')continue;const message=record.fields?.message;if(typeof message!=='string'||!message.startsWith('SSE event: '))continue;
   let frame;try{frame=JSON.parse(message.slice(11));}catch{continue;}
   if(!['response.created','response.in_progress','response.completed','response.metadata','response.failed','response.incomplete'].includes(frame.type))continue;
   // Metadata may omit the id. Bind it only while exactly one response is open.
   const id=frame.response?.id||(frame.type==='response.metadata'?this.activeId:null);
   if(typeof id!=='string'||!id||id.length>200)continue;
   if(!this.responses.has(id))this.responses.set(id,{telemetry:new Telemetry(this.requested),created:false,completed:false,failed:false});
   if(this.responses.size>10){this.failed=true;return;}
   const r=this.responses.get(id);r.telemetry.observe(frame);
   if(frame.type==='response.created'){if(this.activeId&&this.activeId!==id)this.failed=true;r.created=true;this.activeId=id;}
   if(['response.failed','response.incomplete'].includes(frame.type)){r.failed=true;this.activeId=null;}
   if(frame.type==='response.completed'){if(!r.created)this.failed=true;r.completed=true;this.activeId=null;}
  }
 }
 result(){const completed=[...this.responses.values()].filter(r=>r.created&&r.completed&&!r.failed);if(this.failed||this.responses.size!==1||this.activeId||completed.length!==1)throw Error('未取得同一响应的完整原生模型声明；保持未知');const result=completed[0].telemetry.summary();if(!result.declared)throw Error('原生日志没有暴露上游模型字段');return {...result,source:'native_sse_debug',scope:'independent_native_probe'};}
}

export async function nativeProbe(target,policy,cancelled,{connectFn=connect,directory=DATA,profile=null,workload='metadata-v1',now}={}){
 if(!['metadata-v1',SPEED_WORKLOAD].includes(workload)||(!profile&&workload!== 'metadata-v1'))throw Error('测速仅支持账号独立请求');
 const meter=new ProbePerformance({workload,now}),speed=workload===SPEED_WORKLOAD;
 const c=await connectFn({...process.env,RUST_LOG:'off,codex_api::sse::responses=trace',LOG_FORMAT:'json'});
 let trace,source,probeId,turnId,timer,poll,listener,logListener,drainTimer,usage=null,failure=null,failureStatus='failed',completed=false;const notifications=[];
 const streamsClosed=typeof c.child.once==='function'?new Promise(resolve=>c.child.once('close',resolve)):Promise.resolve();
 try{
  source=profile?{...profile,id:null,title:'账号独立检测'}:await settings(c,target.id);trace=new NativeTrace(source.model);logListener=b=>trace.feed(b);c.child.stderr.on('data',logListener);
  const configResult=await c.request('config/read',{includeLayers:false});
  const config={model_reasoning_effort:source.effort,web_search:'disabled',project_doc_max_bytes:0,'skills.include_instructions':false,'features.plugins':false,'features.image_generation':false,'features.view_image':false,'features.apps':false,'features.shell_tool':false,'features.code_mode':false,'features.code_mode_host':false,'features.multi_agent':false,'features.sleep_tool':false};
  for(const name of Object.keys(configResult.config?.mcp_servers||{}))config[`mcp_servers.${name}.enabled`]=false;
  const cwd=path.join(directory,'empty-probe-workspace');await mkdir(cwd,{recursive:true});
  const r=await c.request('thread/start',{ephemeral:true,model:source.model,modelProvider:source.provider,cwd,approvalPolicy:'never',sandbox:'read-only',config,environments:[],dynamicTools:[],allowProviderModelFallback:false,baseInstructions:speed?'This is a text streaming latency measurement. Follow the fixed user text task. Do not use tools.':'This is a model metadata probe. Reply OK. Do not use tools or perform other work.',developerInstructions:speed?'Produce only the requested plain text. Do not read files, run commands, access applications or use tools.':'Only reply OK. Do not read files, run commands, access applications or use tools.'});
  if(!r.thread?.ephemeral||r.thread.path||r.model!==source.model||r.modelProvider!==source.provider||r.reasoningEffort!==source.effort)throw Error('原生探针未保留模型配置，未发起推理');probeId=r.thread.id;
  if(await cancelled())throw Error('采样前状态已变化');
  let finish,fail,settled=false;const done=new Promise((a,b)=>{finish=a;fail=b;});done.catch(()=>{});
  const reject=text=>{failure??=text;if(!settled){settled=true;fail(Error(text));}};
  listener=m=>{const p=m.params||{};if(p.threadId!==probeId)return;
   meter.observe(m);
   if(['model/rerouted','model/safetyBuffering/updated'].includes(m.method)){
    if(notifications.length>=32){reject('原生路由通知异常，本轮保持未知');return;}
    const telemetry=new Telemetry(source.model);telemetry.observe(m);if(typeof p.turnId!=='string'||!p.turnId)telemetry.invalidRouting=true;notifications.push({turnId:p.turnId,telemetry:telemetry.summary()});
   }
   if(m.method==='thread/tokenUsage/updated')usage=p.tokenUsage?.last||null;
   if(m.method==='item/started'&&!['userMessage','agentMessage','reasoning'].includes(p.item?.type))reject('探针尝试使用工具，本轮无效');
   if(m.method==='error'&&!p.willRetry)reject('原生探针请求失败');
   if(m.method==='turn/completed'&&!settled){if(p.turn?.status!=='completed'){if(p.turn?.status==='interrupted')failureStatus='interrupted';reject('原生探针未完成');}else{settled=true;finish(p.turn.id);}}
  };c.listeners.add(listener);c.exited.then(()=>{if(!settled)reject('探针进程提前结束');});
  timer=setTimeout(()=>{failureStatus='timeout';reject('原生探针超时');},Math.min(policy.timeoutSeconds,90)*1000);
  let checking=false;poll=setInterval(async()=>{if(checking||settled)return;checking=true;try{if(await cancelled()){failureStatus='interrupted';reject('监测状态已变化，丢弃旧探针');}}catch{reject('无法验证当前监测状态');}finally{checking=false;}},500);
  meter.begin();
  const started=await c.request('turn/start',{threadId:probeId,input:[{type:'text',text:speed?SPEED_PROMPT:'只回复 OK。不要使用任何工具，不要访问文件，不要开展其他工作。'}],effort:source.effort},15000);turnId=started.turn?.id;
  if(!turnId||await done!==turnId)throw Error('原生探针轮次不一致，本轮保持未知');
  completed=true;
  // stdout and stderr are separate pipes; drain process logs before accepting.
  await c.close();await Promise.race([streamsClosed,new Promise((_,reject)=>{drainTimer=setTimeout(()=>reject(Object.assign(Error('原生探针输出管道尚未关闭，本轮保持未知'),{code:'PROBE_STREAM_DRAIN'})),2000);})]);clearTimeout(drainTimer);
  if(failure||c.failure)throw Error(failure||'原生探针协议异常，本轮保持未知');
  const scope=profile?'standalone_account_probe':'independent_native_probe';
  let evidence;try{evidence=trace.result();}catch(error){evidence={...new Telemetry(source.model).summary(),diagnostic:error.message};}
  const scoped=notifications.filter(n=>n.turnId===turnId||!n.turnId).map(n=>n.telemetry);
  const telemetry={...evidence,scope,reroutes:scoped.flatMap(n=>n.reroutes),safetyBuffering:scoped.flatMap(n=>n.safetyBuffering),invalidRouting:scoped.some(n=>n.invalidRouting)};
  usage=meter.turns.get(turnId)?.usage||null;
  const performance=meter.finish(turnId,{profile:source,scope});
  performance.declaredModel=telemetry.declared||null;
  // A complete, single upstream response is required for comparable timings.
  if(telemetry.diagnostic||telemetry.conflict||telemetry.invalidRouting||telemetry.reroutes.length||telemetry.safetyBuffering.length){performance.comparable=false;performance.estimatedOutputTps=null;performance.estimatedTpotMs=null;performance.rateUnavailable='上游响应不完整或路由发生变化';}
  return {source,telemetry,usage,performance,sampleCount:1,scope};
 }catch(error){
  // A received completed turn has measurable client latency even when process
  // pipes fail to close. This does NOT accept model evidence or release a task.
  const measured=completed&&error.code==='PROBE_STREAM_DRAIN'&&!c.failure&&!failure;
  error.performance=meter.finish(turnId,{status:measured?'completed':failureStatus,profile:source||profile||{},scope:profile?'standalone_account_probe':'independent_native_probe'});
  if(measured){error.performance.comparable=false;error.performance.diagnostic='轮次已完成，但原生输出管道未确认关闭；模型证据未知，不参与降速比较。';}
  throw error;
 }finally{clearTimeout(timer);clearTimeout(drainTimer);clearInterval(poll);if(listener)c.listeners.delete(listener);if(probeId&&turnId&&!c.closed)await c.request('turn/interrupt',{threadId:probeId,turnId},1000).catch(()=>{});await c.close();if(logListener)c.child.stderr.off('data',logListener);
  // Dispose our handles only AFTER deciding evidence validity. Destroying them
  // before the drain check could manufacture a close event and falsely pass it.
  if(c.closed){c.child.stdout?.destroy?.();c.child.stderr?.destroy?.();}
 }
}

// Account probe shares the native transport but never reads or resumes a task.
export async function standaloneNativeProbe(profile,policy,options={}){
 return nativeProbe(null,policy,async()=>false,{...options,profile});
}
export function nativeVerdict(raw,expected,mappings=[]){
 const decision=routingDecision(raw.telemetry,raw.source.model,mappings),scope=raw.scope||'independent_native_probe';
 const verdict=raw.source.model!==expected||decision.inconclusive?'unknown':decision.pause?'mismatch':raw.telemetry.declared?'match':'unknown';
 return {verdict,candidate:raw.telemetry.declared,sourceModel:raw.source.model,effort:raw.source.effort,provider:raw.source.provider,telemetry:[raw.telemetry],usage:[raw.usage],performance:raw.performance||null,sampleCount:1,method:'native',scope,routingState:decision.state,identityVerified:false,message:verdict==='match'?'独立原生探针的上游声明符合预期':verdict==='mismatch'?'上游响应名称或路由存在未经认可的差异，等待复核':decision.state==='safety_buffering'?'原生服务报告安全缓冲，本轮保持未知；这不等于模型被替换':raw.telemetry.diagnostic||'预期设置或上游证据不足，保持未知'};
}
