import {spawn} from 'node:child_process';
import path from 'node:path';
import {randomInt} from 'node:crypto';
import {AppServerClient} from '../vendor/modeltrace/app-server-client.mjs';
import {resolveCodex} from './runtime-path.mjs';
import {VERSION} from './version.mjs';
import {forkPrompt} from '../vendor/modeltrace/prompts.mjs';
import {Telemetry} from './telemetry.mjs';
export async function connect(env=process.env){
  const executable=await resolveCodex(env);
  const child=spawn(executable,['app-server','--listen','stdio://'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...env,MODEL_GUARD_PROBE:'1'}});
  const c=new AppServerClient(child);
  try{await c.request('initialize',{clientInfo:{name:'model_guard',version:VERSION},capabilities:{experimentalApi:true}});c.write({method:'initialized'});return c;}
  catch(e){await c.close();throw e;}
}
export async function settings(c,id){
  const {thread:t}=await c.request('thread/read',{threadId:id,includeTurns:false});
  if(t?.id!==id||!t.model||!t.modelProvider||!Object.hasOwn(t,'reasoningEffort')||!path.isAbsolute(t.cwd))throw Error('原生任务元数据不完整，不回退到默认模型');
  return {id:t.id,title:t.name||'未命名任务',cwd:t.cwd,model:t.model,provider:t.modelProvider,effort:t.reasoningEffort,transcriptPath:t.path};
}
export async function inspectThread(id,{connectFn=connect}={}){
  const c=await connectFn();try{return await settings(c,id);}finally{await c.close();}
}
export async function listThreads({limit=30,cursor=null,searchTerm='',connectFn=connect}={}){
  const c=await connectFn();try{
    const r=await c.request('thread/list',{limit,cursor,searchTerm:searchTerm.slice(0,100),sortKey:'updated_at',sortDirection:'desc',archived:false,useStateDbOnly:true,modelProviders:[]});
    const seen=new Set(),items=[];for(const t of (r.data||[])){if(!t?.id||t.ephemeral||seen.has(t.id))continue;seen.add(t.id);items.push({id:t.id,title:t.name||'未命名任务',cwd:t.cwd,model:t.model||null,provider:t.modelProvider||null,effort:t.reasoningEffort??null,updatedAt:t.updatedAt||t.updated_at||null});}return {sessions:items,nextCursor:r.nextCursor||null};
  }finally{await c.close();}
}
export async function accountProfile(input={}, {connectFn=connect}={}){
 const c=await connectFn();try{
  const {config}=await c.request('config/read',{includeLayers:false});
  const model=input.model??config.model,provider=config.model_provider||'openai';
  if(typeof model!=='string'||!model.length||model.length>150)throw Error('请先选择账号检测使用的模型');
  const selected=(await availableModels(c)).find(x=>x.model===model);
  if(!selected)throw Error('所选检测模型已不在当前可选列表中，请刷新并重新选择；未发起推理');
  const effort=input.effort??(model===config.model?config.model_reasoning_effort:null)??selected.defaultEffort;
  if(!selected.efforts.includes(effort))throw Error('所选模型不支持这个推理档位，请刷新并重新选择；未发起推理');
  return {model,provider,effort};
 }finally{await c.close();}
}
export async function availableModels(c){
  const models=[],seen=new Set(),cursors=new Set();let cursor=null;
  do{
   const page=await c.request('model/list',{limit:100,cursor,includeHidden:false});
   if(!Array.isArray(page.data))throw Error('Codex 返回的模型列表无效');
   for(const item of page.data){
    if(item.hidden||typeof item.model!=='string'||!item.model||seen.has(item.model))continue;
    seen.add(item.model);
    const efforts=[...new Set((Array.isArray(item.supportedReasoningEfforts)?item.supportedReasoningEfforts:[]).map(x=>x?.reasoningEffort).filter(x=>typeof x==='string'&&x.length>0&&x.length<=40))];
    models.push({model:item.model,label:item.displayName||item.model,description:item.description||'',efforts,defaultEffort:item.defaultReasoningEffort??null,upgrade:typeof item.upgrade==='string'?item.upgrade:null});
   }
   cursor=page.nextCursor||null;
   if(cursor&&cursors.has(cursor))throw Error('Codex 模型列表分页重复，请刷新重试');
   if(cursor)cursors.add(cursor);
   if(cursors.size>100)throw Error('Codex 模型列表分页过多，请刷新重试');
  }while(cursor);
  if(!models.length)throw Error('Codex 暂未返回可选模型，请稍后刷新');
  return models;
}
export async function accountOptions({connectFn=connect}={}){
 const c=await connectFn();try{
  const {config}=await c.request('config/read',{includeLayers:false});
  const models=await availableModels(c);
  return {profile:{model:config.model??null,provider:config.model_provider||'openai',effort:config.model_reasoning_effort??models.find(x=>x.model===config.model)?.defaultEffort??null},models,checkedAt:Date.now()};
 }finally{await c.close();}
}
export async function guardTrusted(c,cwd){
  const r=await c.request('hooks/list',{cwds:[cwd]});
  const hooks=(r.data||[]).flatMap(x=>x.hooks||[]).filter(h=>/^model-guard(?:@|$)/.test(h.pluginId||'')&&h.enabled&&['trusted','managed'].includes(h.trustStatus));
  return ['preToolUse','stop','interrupt','userPromptSubmit'].every(name=>hooks.some(h=>h.eventName===name&&!h.async));
}
export async function doctor(target,{connectFn=connect}={}){
  const c=await connectFn();try{const source=await settings(c,target.id);const hookReady=await guardTrusted(c,source.cwd);return {runtimeReady:true,hookReady,source,checkedAt:Date.now(),inferenceRequests:0,note:hookReady?'原生接口与可信拦截器可用':'需要安装并在 Codex /hooks 中信任守望拦截器'};}finally{await c.close();}
}
export async function oneSample(c,forkId,model,count,language,timeoutSeconds,cancelled){
  let done,fail,turnId,settled=false,final,usage=null;const telemetry=new Telemetry(model);
  const promise=new Promise((res,rej)=>{done=res;fail=rej;});promise.catch(()=>{});
  const reject=message=>{if(!settled){settled=true;fail(Error(message));}};
  const listener=m=>{const p=m.params||{};if(p.threadId!==forkId)return;telemetry.observe(m);
    if(m.method==='item/started'&&!['userMessage','agentMessage','reasoning'].includes(p.item?.type))reject('探针尝试使用工具，已拒绝本次样本');
    if(m.method==='item/completed'&&p.item?.type==='agentMessage'&&['final_answer','final',undefined,null].includes(p.item.phase))final=p.item.text;
    if(m.method==='thread/tokenUsage/updated')usage=p.tokenUsage?.last||null;
    if(m.method==='turn/completed'){if(p.turn?.status!=='completed')reject('探针未正常完成');else if(!settled){settled=true;done();}}
    if(m.method==='error'&&!p.willRetry)reject('原生推理请求失败');};
  c.listeners.add(listener);const timer=setTimeout(()=>reject('探针超时'),timeoutSeconds*1000);
  let polling=false;const poll=setInterval(async()=>{if(polling||settled)return;polling=true;try{if(await cancelled())reject('监测状态已改变，丢弃旧样本');}catch{reject('无法确认样本归属');}finally{polling=false;}},700);
  c.exited.then(()=>reject('探针进程提前结束'));
  try{const r=await c.request('turn/start',{threadId:forkId,input:[{type:'text',text:forkPrompt(language,count)}]},15000);turnId=r.turn?.id;await promise;if(typeof final!=='string')throw Error('探针没有返回完整文本');return {text:final,count,language,usage,telemetry:telemetry.summary()};}
  finally{clearTimeout(timer);clearInterval(poll);c.listeners.delete(listener);if(turnId)await c.request('turn/interrupt',{threadId:forkId,turnId},1000).catch(()=>{});}
}
export async function collect(target,policy,cancelled,{connectFn=connect}={}){
  const c=await connectFn();try{
    const source=await settings(c,target.id);if(!await guardTrusted(c,source.cwd))throw Error('探针拦截器未加载或未受信任：未发起模型请求');
    const boundary=await completedBoundary(c,target.id);source.snapshotTurnId=boundary;
    const args={threadId:target.id,lastTurnId:boundary,ephemeral:true,excludeTurns:true,model:source.model,modelProvider:source.provider,cwd:source.cwd,approvalPolicy:'never',sandbox:'read-only',config:{...(source.effort?{model_reasoning_effort:source.effort}:{}),web_search:'disabled'}};
    const outputs=[];
    for(let i=0;i<3;i++){
      if(await cancelled())throw Error('采样已取消');const fork=await c.request('thread/fork',args,30000);verifyFork(fork,target.id,source);
      outputs.push(await oneSample(c,fork.thread.id,source.model,randomInt(300,321),i===1?'en':'zh',policy.timeoutSeconds,cancelled));
    }
    return {outputs,source,boundary:'last_completed_turn_ephemeral_forks',limitations:['excludes_current_unfinished_turn','fork_request_not_source_request','read_only_probe_environment','same_context_error_rate_uncalibrated']};
  }finally{await c.close();}
}
export function verifyFork(r,parent,source){if(!r.thread?.ephemeral||r.thread.path||r.thread.id===parent||r.thread.forkedFromId!==parent||r.model!==source.model||r.modelProvider!==source.provider||r.reasoningEffort!==source.effort||path.resolve(r.thread.cwd)!==path.resolve(source.cwd))throw Error('临时分支未保留模型配置或未隔离持久化，取消检测');}
export async function completedBoundary(c,id){
 const r=await c.request('thread/turns/list',{threadId:id,limit:20,itemsView:'notLoaded',sortDirection:'desc'});
 const t=r.data?.find(t=>t.status==='completed');if(!t?.id)throw Error('没有可用于固定采样上下文的已完成轮次');return t.id;
}
