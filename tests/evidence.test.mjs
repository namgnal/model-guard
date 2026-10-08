import test from 'node:test';
import assert from 'node:assert/strict';
import {Telemetry,routingDecision} from '../lib/telemetry.mjs';
import {artifacts,strictArray,classify} from '../lib/fingerprint.mjs';
import {DEFAULTS} from '../lib/policy.mjs';
import {collect,verifyFork} from '../lib/runtime.mjs';
test('请求配置中的 model 不能冒充 response.model',()=>{const t=new Telemetry('gpt-6-astra');t.observe({method:'thread/started',params:{model:'gpt-6-astra'}});assert.equal(t.summary().declared,null);assert.equal(t.summary().mismatch,null);});
test('新版服务端响应头优先于响应体别名，保留两种声明且不复制其他响应头',()=>{
 const t=new Telemetry('gpt-6.1-sol');
 t.observe({type:'response.created',response:{model:'request-alias'}});
 t.observe({type:'response.metadata',headers:{'OPENAI-MODEL':'gpt-6.1-sol',Authorization:'do-not-persist'}});
 const s=t.summary();assert.equal(s.declared,'gpt-6.1-sol');assert.equal(s.declarationSource,'response_header');assert.equal(s.payloadDeclared,'request-alias');assert.equal(s.payloadDifference,true);assert.equal(s.conflict,false);assert.equal(JSON.stringify(s).includes('do-not-persist'),false);
});
test('响应头声明改变或同一帧存在冲突都不能通过，响应体不能掩盖冲突',()=>{
 for(const headers of [{'openai-model':'gpt-6-astra','x-openai-model':'gpt-6-luna'},{'openai-model':['gpt-6-astra','gpt-6-luna']}]){
  const t=new Telemetry('gpt-6-astra');t.observe({type:'response.created',response:{model:'gpt-6-astra',headers}});assert.equal(routingDecision(t.summary(),'gpt-6-astra').pause,true);
 }
 const t=new Telemetry('gpt-6-astra');t.observe({type:'response.created',response:{headers:{'openai-model':'gpt-6-astra'}}});t.observe({type:'response.completed',response:{model:'gpt-6-astra',headers:{'x-openai-model':'gpt-6-luna'}}});assert.equal(t.summary().conflict,true);
});
test('请求、工具输出或未知事件中的响应外形不能伪造模型证据',()=>{
 const t=new Telemetry('gpt-6-astra');for(const method of ['thread/started','item/completed','unknown'])t.observe({method,params:{response:{model:'gpt-6-astra',headers:{'openai-model':'gpt-6-astra'}}}});assert.equal(t.summary().declared,null);
});
test('安全缓冲单独标记未知，不把它当作模型替换或允许映射',()=>{
 const t=new Telemetry('gpt-6-astra');t.observe({type:'response.completed',response:{model:'gpt-6-astra'}});t.observe({method:'model/safetyBuffering/updated',params:{model:'gpt-6-astra',fasterModel:'gpt-6-luna',showBufferingUi:true}});
 assert.deepEqual(routingDecision(t.summary(),'gpt-6-astra'),{state:'safety_buffering',pause:true,inconclusive:true});
});
test('Sub2API 式上游声明可显示差异，末端优先且保留冲突',()=>{const t=new Telemetry('gpt-6-astra');t.observe({type:'response.created',response:{model:'gpt-6-astra'}});t.observe({type:'response.completed',response:{model:'gpt-5.6-luna'}});const r=t.summary();assert.equal(r.declared,'gpt-5.6-luna');assert.equal(r.mismatch,true);assert.equal(r.conflict,true);assert.equal(r.identityVerified,false);});
test('原生改路由事件独立于模型响应声明',()=>{const t=new Telemetry('gpt-6-astra');t.observe({method:'model/rerouted',params:{fromModel:'gpt-6-astra',toModel:'another',reason:'test'}});assert.equal(t.summary().reroutes[0].to,'another');assert.equal(t.summary().declared,null);});
test('已认可灰度映射与未经认可的差异分别处理，不默认一切不同都降级',()=>{const t={declared:'gpt-5.6-luna',reroutes:[],conflict:false};assert.equal(routingDecision(t,'gpt-6-astra').pause,true);const mapping=[{requested:'gpt-6-astra',upstream:'gpt-5.6-luna'}];assert.equal(routingDecision(t,'gpt-6-astra',mapping).state,'approved_mapping');assert.equal(routingDecision(t,'gpt-6-astra',mapping).pause,false);assert.equal(routingDecision({declared:null},'gpt-6-astra',mapping).verified,false);});
test('指纹输入必须完整，不能容忍半截、补全文本或越界',()=>{for(const s of ['[1,2]','[1,2,356]','[1,2,3.5]','Here is [1,2,3]','[1,2,'])assert.throws(()=>strictArray(s,3));assert.deepEqual(strictArray('```json\n[1,2,3]\n```',3),[1,2,3]);});
test('指纹库和评分器固定校验；不支持的模型与不足样本保持未知',async()=>{const {bank}=await artifacts();assert.ok(bank.models.some(m=>m.id==='gpt-6-astra'));assert.equal(classify([],bank,'gpt-6-astra',DEFAULTS).verdict,'unknown');assert.equal(classify([],bank,'nonexistent',DEFAULTS).verdict,'unknown');});
test('采样适配器必须在 fork 和模型调用之前检查可信 Hook',async()=>{const calls=[];const c={request:async(method)=>{calls.push(method);if(method==='thread/read')return {thread:{id:'target',model:'gpt-6-astra',modelProvider:'openai',reasoningEffort:'xhigh',cwd:process.cwd()}};if(method==='hooks/list')return {data:[]};throw Error('不应调用');},close:async()=>calls.push('close')};await assert.rejects(()=>collect({id:'target'},DEFAULTS,async()=>false,{connectFn:async()=>c}),/未受信任/);assert.deepEqual(calls,['thread/read','hooks/list','close']);});
test('探针不允许改用默认模型、持久化分支或错误工作目录',()=>{const s={model:'gpt-6-astra',provider:'openai',effort:'xhigh',cwd:process.cwd()};const r={thread:{ephemeral:true,path:null,id:'child',forkedFromId:'parent',cwd:process.cwd()},model:s.model,modelProvider:s.provider,reasoningEffort:s.effort};assert.doesNotThrow(()=>verifyFork(r,'parent',s));for(const v of [{...r,model:'other'},{...r,reasoningEffort:'low'},{...r,thread:{...r.thread,path:'/saved'}}])assert.throws(()=>verifyFork(v,'parent',s));});
