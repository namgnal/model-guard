import test from 'node:test';
import assert from 'node:assert/strict';
import {accountOptions,accountProfile} from '../lib/runtime.mjs';

test('模型列表读取全部分页，排除隐藏项与重复项，并保持当前配置',async()=>{
 let closed=false;const calls=[];
 const model=(id,extra={})=>({model:id,displayName:id.toUpperCase(),supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'high'}],defaultReasoningEffort:'medium',...extra});
 const c={close:async()=>{closed=true;},request:async(method,args)=>{calls.push({method,args});if(method==='config/read')return {config:{model:'second',model_provider:'openai',model_reasoning_effort:'high'}};assert.equal(method,'model/list');assert.equal(args.includeHidden,false);return args.cursor?{data:[model('first'),model('second')],nextCursor:null}:{data:[model('first'),model('hidden',{hidden:true})],nextCursor:'page2'};}};
 const r=await accountOptions({connectFn:async()=>c});assert.deepEqual(r.models.map(m=>m.model),['first','second']);assert.deepEqual(r.models[1].efforts,['medium','high']);assert.deepEqual(r.profile,{model:'second',provider:'openai',effort:'high'});assert.equal(closed,true);assert.deepEqual(calls.map(c=>c.method),['config/read','model/list','model/list']);
});
test('原配置不在可选列表中时保留原值，不擅自换成列表首项',async()=>{
 const c={close:async()=>{},request:async method=>method==='config/read'?{config:{model:'custom',model_reasoning_effort:'ultra'}}:{data:[{model:'available',displayName:'Available',supportedReasoningEfforts:[{reasoningEffort:'low'}],defaultReasoningEffort:'low'}],nextCursor:null}};
 const r=await accountOptions({connectFn:async()=>c});assert.equal(r.profile.model,'custom');assert.equal(r.profile.effort,'ultra');assert.equal(r.models.length,1);
});
test('空模型列表、读取失败和重复游标明确报错并关闭原生连接',async()=>{
 for(const behavior of ['empty','failed','loop']){let closed=false;const c={close:async()=>{closed=true;},request:async method=>{if(method==='config/read')return {config:{}};if(behavior==='failed')throw Error('模拟连接失败');return {data:[],nextCursor:behavior==='loop'?'same':null};}};await assert.rejects(()=>accountOptions({connectFn:async()=>c}),/未返回|连接失败|分页重复/);assert.equal(closed,true);}
});

test('新模型和新档位从完整分页解析，不依赖固定名称枚举',async()=>{
 const requests=[];let closed=false;
 const c={close:async()=>{closed=true;},request:async(method,args)=>{
  requests.push(method);if(method==='config/read')return {config:{model:'gpt-6-astra',model_reasoning_effort:'max'}};
  return args.cursor?{data:[{model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'future-effort'}],defaultReasoningEffort:'future-effort'}],nextCursor:null}:{data:[],nextCursor:'second'};
 }};
 const profile=await accountProfile({model:'gpt-6.1-sol'},{connectFn:async()=>c});
 assert.deepEqual(profile,{model:'gpt-6.1-sol',provider:'openai',effort:'future-effort'});
 assert.deepEqual(requests,['config/read','model/list','model/list']);assert.equal(closed,true);
});
test('目录变化后拒绝失效模型或档位，不启动探针也不自动替换',async()=>{
 for(const input of [{model:'retired-model',effort:'high'},{model:'gpt-6.1-sol',effort:'removed'},{ }]){
  let closed=false;const calls=[];
  const c={close:async()=>{closed=true;},request:async method=>{calls.push(method);if(method==='config/read')return {config:{model:'gpt-6.1-sol',model_reasoning_effort:'removed'}};return {data:[{model:'gpt-6.1-sol',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]};}};
  await assert.rejects(()=>accountProfile(input,{connectFn:async()=>c}),/未发起推理/);
  assert.deepEqual(calls,['config/read','model/list']);assert.equal(closed,true);
 }
});
