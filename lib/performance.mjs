// Client-side observations only. No prompt, generated text or raw error is kept.
import {performance as clock} from 'node:perf_hooks';

export const SPEED_WORKLOAD='text-256-v1';
export const SPEED_PROMPT='Write exactly 256 space-separated common English words about everyday objects. Plain text only, no heading, numbering, code or explanation. Do not use tools. Stop after the 256th word.';
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const count=x=>Number.isSafeInteger(x)&&x>=0?x:null;
const round=x=>finite(x)?Math.round(x*1000)/1000:null;
export function tokenUsage(value){
 const get=(camel,snake)=>count(value?.[camel]??value?.[snake]);
 const inputTokens=get('inputTokens','input_tokens'),outputTokens=get('outputTokens','output_tokens');
 let cachedInputTokens=get('cachedInputTokens','cached_input_tokens'),reasoningOutputTokens=get('reasoningOutputTokens','reasoning_output_tokens');
 if(inputTokens===null||cachedInputTokens>inputTokens)cachedInputTokens=null;
 if(outputTokens===null||reasoningOutputTokens>outputTokens)reasoningOutputTokens=null;
 return {inputTokens,outputTokens,cachedInputTokens,reasoningOutputTokens,
  visibleOutputTokens:outputTokens!==null&&reasoningOutputTokens!==null?outputTokens-reasoningOutputTokens:null};
}
export function distribution(values){
 const a=values.filter(finite).sort((a,b)=>a-b),n=a.length;
 const quantile=p=>{const i=(n-1)*p,lo=Math.floor(i);return round(a[lo]+(a[Math.ceil(i)]-a[lo])*(i-lo));};
 return {count:n,mean:n?round(a.reduce((a,b)=>a+b,0)/n):null,p50:n?quantile(.5):null,p95:n?quantile(.95):null,max:n?a[n-1]:null};
}

export class ProbePerformance {
 constructor({workload='metadata-v1',now=()=>clock.now()}={}){this.workload=workload;this.now=now;this.created=now();this.start=null;this.turns=new Map();this.overflow=false;}
 begin(){this.start=this.now();this.at=Date.now();}
 observe(message){
  if(this.start===null)return;
  const p=message.params||{},id=p.turnId||p.turn?.id;
  if(typeof id!=='string'||!id)return;
  if(!this.turns.has(id)){
   if(this.turns.size>=8){this.overflow=true;return;}
   this.turns.set(id,{firstText:null,firstResponse:null,lastText:null,end:null,chunks:0,characters:0,gaps:[],items:new Set(),retries:0,rateLimits:0,tools:false,routing:false,usage:null,status:null});
  }
  const t=this.turns.get(id),ms=this.now()-this.start,method=message.method;
  if(!finite(ms)){this.overflow=true;return;}
  if(t.end!==null&&method!=='thread/tokenUsage/updated')return;
  if(method==='thread/tokenUsage/updated')t.usage=p.tokenUsage?.last||null;
  if(['item/agentMessage/delta','item/reasoning/summaryTextDelta','item/reasoning/textDelta'].includes(method)&&typeof p.delta==='string'&&p.delta.length){
   t.firstResponse??=ms;
   if(method==='item/agentMessage/delta'){
    t.firstText??=ms;
    if(t.lastText!==null){if(t.gaps.length<4096)t.gaps.push(ms-t.lastText);else this.overflow=true;}
    t.lastText=ms;t.chunks++;t.characters+=Array.from(p.delta).length;t.items.add(p.itemId||'unknown');
   }
  }
  if(method==='item/started'&&!['userMessage','agentMessage','reasoning'].includes(p.item?.type))t.tools=true;
  if(['model/rerouted','model/safetyBuffering/updated'].includes(method))t.routing=true;
  if(method==='error'){
   if(p.willRetry)t.retries++;
   const info=p.error?.codexErrorInfo;
   if(info==='UsageLimitExceeded'||(info&&typeof info==='object'&&[info,...Object.values(info)].some(v=>v?.httpStatusCode===429)))t.rateLimits++;
  }
  if(method==='turn/completed'){t.end=ms;t.status=p.turn?.status;}
 }
 finish(turnId,{status='completed',profile={},scope='independent_native_probe'}={}){
  if(this.start===null)return null;
  const t=this.turns.get(turnId),tokens=tokenUsage(t?.usage),end=t?.end??this.now()-this.start;
  const completed=status==='completed'&&t?.status==='completed'&&!this.overflow;
  const elapsed=t?.firstText!==null&&t?.firstText!==undefined?end-t.firstText:null;
  let rateUnavailable=null;
  if(!completed)rateUnavailable='请求未完整完成';
  else if(t.tools||t.routing||t.retries)rateUnavailable='含工具、重试或路由变化';
  else if(tokens.visibleOutputTokens===null)rateUnavailable='缺少输出或推理 Token 分项';
  else if(tokens.visibleOutputTokens<32)rateUnavailable='输出过短（少于 32 Token）';
  else if(t.chunks<2||t.items.size!==1||elapsed<200)rateUnavailable='流式样本不足';
  return {schema:1,source:'native_app_server',workload:this.workload,scope,at:this.at,
   model:profile.model||null,provider:profile.provider||null,effort:profile.effort||null,
   status:completed?'completed':status==='completed'?'invalid':status,
   setupMs:round(this.start-this.created),e2eMs:round(end),firstResponseMs:round(t?.firstResponse),ttftMs:round(t?.firstText),
   ...tokens,outputTokensPerSecond:completed&&end>0&&tokens.outputTokens!==null?round(tokens.outputTokens*1000/end):null,
   estimatedOutputTps:rateUnavailable?null:round((tokens.visibleOutputTokens-1)*1000/elapsed),
   estimatedTpotMs:rateUnavailable?null:round(elapsed/(tokens.visibleOutputTokens-1)),rateUnavailable,
   chunks:t?.chunks||0,characters:t?.characters||0,chunkGaps:distribution(t?.gaps||[]),
   retries:t?.retries||0,rateLimits:t?.rateLimits||0,comparable:completed&&!t.tools&&!t.routing&&!t.retries&&!this.overflow};
 }
}

// Rollouts contain finished messages, not token arrival timestamps. Never derive
// TTFT or model decode speed from those records or from tool-inclusive turn time.
export class TurnPerformance {
 constructor(){this.active=null;this.total=null;this.samples=[];this.provider=null;}
 observe(record){
  const p=record.payload||{},at=Date.parse(record.timestamp),kind=p.type;
  if(record.type==='compacted'){if(this.active)this.active.invalid=true;this.total=null;return;}
  if(record.type==='session_meta'){this.provider=p.model_provider||null;return;}
  if(record.type==='turn_context'){
   if(this.active&&p.turn_id===this.active.id)Object.assign(this.active,{model:p.model||null,effort:p.effort||p.reasoning_effort||null});
   return;
  }
  if(record.type!=='event_msg')return;
  if(['task_started','turn_started'].includes(kind)&&typeof p.turn_id==='string'&&finite(at)){
   if(this.active?.id===p.turn_id)return;
   this.active={id:p.turn_id,at,base:this.total,usage:null,model:null,effort:null,invalid:false};return;
  }
  if(kind==='token_count'&&p.info?.total_token_usage){
   const next=tokenUsage(p.info.total_token_usage),a=this.active;
   if(a&&p.turn_id&&p.turn_id!==a.id)return;
   if(a){
    if(a.base){
     const delta={};for(const key of ['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens']){
      delta[key]=next[key]!==null&&a.base[key]!==null?next[key]-a.base[key]:null;
      if(delta[key]!==null&&delta[key]<0)a.invalid=true;
     }
     a.usage=tokenUsage(delta);
    }
   }
   this.total=next;return;
  }
  if(['context_compacted','thread_rolled_back'].includes(kind)){if(this.active)this.active.invalid=true;this.total=null;return;}
  if(['task_complete','turn_complete','turn_aborted'].includes(kind)){
   const a=this.active;if(!a||p.turn_id!==a.id)return;this.active=null;
   if(!finite(at)||at<a.at)return;
   const sample={schema:1,source:'transcript',workload:'actual-turn',scope:'selected_session',id:a.id,at:a.at,
    model:a.model,provider:this.provider,effort:a.effort,status:kind==='turn_aborted'?'interrupted':p.error?'failed':'completed',
    e2eMs:at-a.at,...tokenUsage(a.invalid?null:a.usage),ttftMs:null,estimatedOutputTps:null,comparable:false};
   this.samples=[sample,...this.samples.filter(s=>s.id!==a.id)].slice(0,80);
  }
 }
 summary(){return {samples:this.samples,activeTurn:this.active?{at:this.active.at,id:this.active.id}:null};}
}

const metrics=['ttftMs','firstResponseMs','e2eMs','estimatedOutputTps','estimatedTpotMs','outputTokensPerSecond','inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens'];
const bucket=n=>!finite(n)?'unknown':n===0?'0':String(2**Math.floor(Math.log2(n)));
function comparisonKey(s){return JSON.stringify([s.model,s.declaredModel,s.provider,s.effort,s.scope,s.workload,bucket(s.inputTokens),bucket(s.visibleOutputTokens),!finite(s.cachedInputTokens)?'unknown':s.cachedInputTokens===0?'uncached':s.inputTokens>0&&s.cachedInputTokens/s.inputTokens>=.5?'mostly-cached':'partly-cached']);}
export function performanceDashboard(state,account,now=Date.now()){
 const samples=[...(state?.samples||[]).map(s=>s.performance),...(account?.checks||[]).map(c=>c.result?.performance),...(state?.observation?.performance?.samples||[])]
  .filter(s=>s?.schema===1&&finite(s.at)&&s.at<=now&&s.at>=now-7*86400000).sort((a,b)=>b.at-a.at);
 const groups=new Map();
 for(const s of samples){
  const key=JSON.stringify([s.source,s.scope,s.workload,s.model,s.provider,s.effort]);
  if(!groups.has(key))groups.set(key,{id:key,source:s.source,scope:s.scope,workload:s.workload,model:s.model,provider:s.provider,effort:s.effort,samples:[]});
  groups.get(key).samples.push(s);
 }
 return {windowDays:7,groups:[...groups.values()].map(g=>{
  const successful=g.samples.filter(s=>s.status==='completed'),latest=g.samples[0];
  const eligible=latest.comparable?successful.filter(s=>s.comparable&&comparisonKey(s)===comparisonKey(latest)):[];
  const recent=eligible.slice(0,5),baseline=eligible.slice(5,15),changes=[];
  if(recent.length===5&&baseline.length>=5)for(const key of ['ttftMs','estimatedOutputTps']){
   const a=distribution(recent.map(s=>s[key])),b=distribution(baseline.map(s=>s[key]));
   if(a.count<5||b.count<5||!b.p50)continue;
   const ratio=a.p50/b.p50;if(key==='ttftMs'?ratio>=1.5&&a.p50-b.p50>=500:ratio<=.7)changes.push({metric:key,ratio:round(ratio),recent:a.p50,baseline:b.p50});
  }
  const totals={};for(const key of ['inputTokens','outputTokens','cachedInputTokens','reasoningOutputTokens']){
   const values=successful.map(s=>s[key]).filter(finite);totals[key]=values.length?values.reduce((a,b)=>a+b,0):null;
  }
  const failedCount=g.samples.filter(s=>['failed','timeout','invalid'].includes(s.status)).length;
  return {...g,count:g.samples.length,successCount:successful.length,failedCount,failureRate:successful.length+failedCount?failedCount/(successful.length+failedCount):null,
   stats:Object.fromEntries(metrics.map(k=>[k,distribution(successful.map(s=>s[k]))])),totals,
   cacheHitRatio:totals.inputTokens>0&&successful.every(s=>finite(s.inputTokens)&&finite(s.cachedInputTokens))?round(totals.cachedInputTokens/totals.inputTokens):null,
   comparison:{eligible:eligible.length,baselineCount:baseline.length,recentCount:recent.length,changes},latest,samples:g.samples.slice(0,30)};
 })};
}
