import {randomUUID} from 'node:crypto';
import {record} from './store.mjs';
export const DEFAULTS=Object.freeze({toolInterval:24,minIntervalMinutes:10,maxEvidenceMinutes:30,recoveryMinutes:10,recoveryPasses:2,hourlyCalls:12,dailyCalls:160,timeoutSeconds:180,matchShare:0.8,matchMargin:0.3});
export function validatePolicy(p){const v={...DEFAULTS,...p};for(const k of Object.keys(v))if(!(k in DEFAULTS))throw Error(`未知设置：${k}`);
  const bounds={toolInterval:[4,200],minIntervalMinutes:[1,120],maxEvidenceMinutes:[5,180],recoveryMinutes:[2,120],recoveryPasses:[2,5],hourlyCalls:[3,120],dailyCalls:[6,1000],timeoutSeconds:[30,600]};
  for(const [k,[min,max]]of Object.entries(bounds))if(!Number.isInteger(v[k])||v[k]<min||v[k]>max)throw Error(`${k} 必须在 ${min}–${max} 之间`);
  for(const k of ['matchShare','matchMargin'])if(!Number.isFinite(v[k])||v[k]<0.1||v[k]>=1)throw Error('指纹阈值无效');
  if(v.matchShare<0.6||v.dailyCalls<v.hourlyCalls||v.maxEvidenceMinutes<v.minIntervalMinutes)throw Error('检测阈值或预算设置冲突');return v;}
export function createState(target){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(target.id))throw Error('任务 ID 无效');return {schema:1,revision:0,target,mode:'observe',enabled:false,strategy:'passive',phase:'unconfigured',expected:'gpt-6-astra',epoch:0,policy:{...DEFAULTS},hook:{seen:false,lastAt:null,lastTurn:null,stopped:false},bridge:{ready:false,lastAt:null},verification:{testsPassed:false,runtimeReady:false,hookReady:false,pilotPassed:false},samples:[],events:[],reservations:[],tools:0,seenTools:[],recoveryStreak:0,lastRecoveryAt:null,run:null,halt:null,manualHold:false,action:null,lastPassAt:null,lastProbeAt:null};}
export function enabledMode(s,mode,now=Date.now()){
  if(!['observe','protect','off'].includes(mode))throw Error('模式无效');
  if(mode==='protect'&&!['native','fingerprint'].includes(s.strategy))throw Error('当前被动观察没有上游响应声明，无法仅凭选择的模型启用自动保护');
  if(mode==='protect'&&(!s.verification.testsPassed||!s.verification.runtimeReady||!s.verification.hookReady||!s.verification.pilotPassed||!s.hook.seen||!s.bridge.ready||now-s.bridge.lastAt>15*60000))throw Error('接管前需要：自动化检查、运行时检查、可信拦截器、真实初检及恢复调度均通过');
  s.epoch++;s.run=null;s.action=null;s.mode=mode;s.enabled=mode!=='off';s.recoveryStreak=0;
  s.halt=null;s.manualHold=false;s.lastRecoveryAt=null;
  if(mode==='off'){s.phase='off';record(s,'disabled','已关闭监测和自动恢复；未向任务发送继续指令',{},now);return;}
  s.phase=s.lastPassAt&&now-s.lastPassAt<s.policy.maxEvidenceMinutes*60000?'healthy':'unknown';
  if(mode==='protect'&&s.phase!=='healthy')pause(s,'evidence_expired','接管时检测结果已过期',now);
  record(s,'mode',mode==='protect'?'已启用自动保护':'已启用观察模式',{},now);
}
export function pause(s,reason,text,now=Date.now()){
  if(s.mode==='protect'&&!s.manualHold){if(!s.halt)s.halt={id:randomUUID(),at:now,turnId:s.hook.lastTurn,stopped:false};s.halt.reason=reason;s.halt.text=text;s.phase='paused';s.action=null;}
  else if(!s.manualHold)s.phase='unknown';
  s.recoveryStreak=0;s.lastRecoveryAt=null;record(s,reason,text,{},now);
}
export function fresh(s,now=Date.now()){return !!s.lastPassAt&&now-s.lastPassAt<=s.policy.maxEvidenceMinutes*60000;}
export function budget(s,calls=3,now=Date.now()){
  const recent=s.reservations.filter(r=>now-r.at<86400000);return {hour:recent.filter(r=>now-r.at<3600000).reduce((n,r)=>n+r.calls,0),day:recent.reduce((n,r)=>n+r.calls,0),allowed:recent.filter(r=>now-r.at<3600000).reduce((n,r)=>n+r.calls,0)+calls<=s.policy.hourlyCalls&&recent.reduce((n,r)=>n+r.calls,0)+calls<=s.policy.dailyCalls};
}
export function due(s,now=Date.now(),force=false){
  if(!s?.enabled||s.manualHold||s.run||s.phase==='resuming')return false;
  if(force)return true;if(!['native','fingerprint'].includes(s.strategy))return false;if(!s.lastProbeAt)return true;
  const minutes=(now-s.lastProbeAt)/60000;
  if(s.halt||s.phase==='unknown')return minutes>=s.policy.recoveryMinutes;
  return minutes>=s.policy.minIntervalMinutes&&(s.tools>=s.policy.toolInterval||!fresh(s,now));
}
export function beginRun(s,now=Date.now(),force=false){
  const calls=s.strategy==='native'?1:3;
  if(!due(s,now,force))return null;if(!budget(s,calls,now).allowed){pause(s,'budget','检测预算已用完，等待预算恢复',now);return null;}
  const run={id:randomUUID(),epoch:s.epoch,pid:process.pid,at:now,expiresAt:now+(s.policy.timeoutSeconds*calls+90)*1000,expected:s.expected,method:s.strategy==='native'?'native':'fingerprint',haltId:s.halt?.id||null,mode:s.mode};
  s.run=run;s.reservations=s.reservations.filter(r=>now-r.at<86400000);s.reservations.push({at:now,calls,runId:run.id});s.lastProbeAt=now;s.tools=0;
  if(!s.halt)s.phase='checking';record(s,'probe_started',calls===1?'开始一次独立原生短请求检测':'开始三次固定历史轮次的指纹采样',{runId:run.id},now);return structuredClone(run);
}
export function applyEvidence(s,run,result,now=Date.now()){
  if(s.run?.id!==run.id||run.epoch!==s.epoch||s.manualHold||!s.enabled)return false;
  s.run=null;const sample={id:run.id,at:now,...result};s.samples=[sample,...s.samples].slice(0,80);
  if(result.verdict==='match'){
    s.lastPassAt=now;s.verification.pilotPassed=true;
    if(s.halt){if(!s.lastRecoveryAt||now-s.lastRecoveryAt>=s.policy.recoveryMinutes*60000){s.recoveryStreak++;s.lastRecoveryAt=now;}
      if(s.recoveryStreak>=s.policy.recoveryPasses&&s.halt.stopped){s.phase='ready';s.action={id:randomUUID(),kind:'resume',haltId:s.halt.id,epoch:s.epoch,at:now,status:'pending'};}
      else s.phase='paused';
    }else s.phase='healthy';record(s,'match',run.method==='native'?'独立探针上游声明符合预期；不代表目标每一次请求':'指纹符合预期，结果仅适用于本次分支采样',{candidate:result.candidate,share:result.share},now);
  } else {pause(s,result.verdict==='mismatch'?'mismatch':'unknown',result.message||'本次检测无法确认符合预期',now);}
  return true;
}
export function handleEvent(s,event,now=Date.now()){
  if(!s||![event.session_id,event.parent_session_id].includes(s.target.id))return {};
  s.hook.seen=true;s.hook.lastAt=now;
  const name=event.hook_event_name;
  if(event.turn_id&&!event.agent_id)s.hook.lastTurn=event.turn_id;
  if(!s.enabled)return {};
  if(name==='Interrupt'){s.manualHold=true;s.phase='manual';s.epoch++;s.run=null;s.action=null;record(s,'manual_pause','检测到用户中断，自动恢复已暂停',{},now);return {};}
  if(name==='UserPromptSubmit'&&!event.agent_id){
    const marker=s.action?.marker;
    if(s.phase==='resuming'&&marker&&event.prompt?.includes(marker)&&now<s.action.expiresAt&&fresh(s,now)){
      s.phase='healthy';s.halt=null;s.action=null;s.recoveryStreak=0;s.hook.stopped=false;record(s,'resumed','目标任务已接收恢复指令',{},now);
    }else if(s.mode==='protect'&&(s.halt||s.manualHold)){return {decision:'block',reason:'守望：任务仍处于暂停状态。请先在监测台检查结果；不会用普通“继续”绕过保护。'};}
  }
  if(name==='PostToolUse'&&event.tool_use_id&&!s.seenTools.includes(event.tool_use_id)){s.seenTools=[...s.seenTools.slice(-255),event.tool_use_id];s.tools++;}
  if(!s.enabled||s.mode!=='protect')return {};
  if(!s.halt&&!s.manualHold&&!fresh(s,now))pause(s,'stale','检测结果已过期，暂停工作等待复检',now);
  if(s.phase==='resuming'&&now>=s.action?.expiresAt){s.phase='paused';s.action=null;record(s,'resume_expired','恢复指令未在有效期内落地，保持暂停',{},now);}
  const blocked=!!s.halt||s.manualHold;
  const reason='守望已暂停这项任务：'+(s.halt?.text||'用户手动暂停')+'。停止新增文件修改、命令和派工，保留已有内容并结束本轮。指纹结果不等于模型身份认证；恢复由监测器另行通知。';
  if(name==='PreToolUse'&&blocked)return {systemMessage:reason,hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason}};
  if(name==='Stop'&&blocked&&!event.agent_id){s.hook.stopped=true;if(s.halt){s.halt.stopped=true;s.halt.turnId=event.turn_id||s.halt.turnId;}return {continue:false,stopReason:reason,systemMessage:reason};}
  if(['PostToolUse','SessionStart'].includes(name)&&blocked)return {systemMessage:reason,hookSpecificOutput:{hookEventName:name,additionalContext:reason}};
  return {};
}
export function claimResume(s,snapshot,now=Date.now()){
  if(s.mode!=='protect'||!s.enabled||s.manualHold||s.run||s.phase!=='ready'||!s.halt?.stopped||s.action?.status!=='pending'||!fresh(s,now)||s.recoveryStreak<s.policy.recoveryPasses)throw Error('恢复条件尚未满足');
  if(snapshot.threadId!==s.target.id||snapshot.status!=='idle'||!s.halt.turnId||snapshot.turnId!==s.halt.turnId||snapshot.needsAttention!==false||!Number.isFinite(snapshot.checkedAt)||Math.abs(now-snapshot.checkedAt)>30000)throw Error('目标任务状态已变化或没有新鲜快照，禁止自动恢复');
  const marker=`[MODEL-GUARD:${s.action.id}:${randomUUID()}]`;s.action={...s.action,status:'dispatching',marker,expiresAt:now+120000};s.phase='resuming';
  record(s,'resume_dispatch','已签发一次性恢复指令',{actionId:s.action.id},now);
  return {threadId:s.target.id,actionId:s.action.id,prompt:`${marker}\n守望检测已连续符合预期，解除本监测器造成的暂停。请在原任务中继续此前已获授权但尚未完成的工作，先检查是否有仍在运行的命令或子任务，避免重复执行。保持用户原来的模型、推理档位、范围和审批边界；如任务已经完成、用户另行暂停或正在等用户决定，则不要续跑。`};
}
