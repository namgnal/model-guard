import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {ROOT} from './store.mjs';
import {analyzeGlobalOutputs} from '../vendor/modeltrace/fingerprint-core.mjs';
export async function artifacts(){
  const dir=path.join(ROOT,'vendor/modeltrace');const meta=JSON.parse(await readFile(path.join(dir,'provenance.json'),'utf8'));
  for(const [name,hash]of Object.entries(meta.sha256)){const bytes=await readFile(path.join(dir,name));if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('指纹组件校验失败：'+name);}
  return {bank:JSON.parse(await readFile(path.join(dir,'unified_bank.json'),'utf8')),meta};
}
export function strictArray(text,count){
  if(typeof text!=='string'||text.length>5000)throw Error('探针输出必须是完整的短文本数组');
  let s=text.trim();
  if(/^(?:`{3}|~{3})/.test(s)){
    const block=/^(`{3,}|~{3,})[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1$/i.exec(s);
    if(!block)throw Error('探针必须是单个完整 JSON 代码块，不能包含解释或多个代码块');
    s=block[2].trim();
  }
  const a=JSON.parse(s);
  if(!Array.isArray(a)||a.length!==count||!/^\[\s*\d+(?:\s*,\s*\d+)*\s*\]$/.test(s)||a.some(n=>!Number.isInteger(n)||n<1||n>355))throw Error('探针必须是完整的指定长度整数数组');
  return a;
}
export function classify(outputs,bank,expected,policy){
  if(!bank.models.some(m=>m.id===expected))return {verdict:'unknown',message:'预期模型不在当前指纹库中'};
  if(outputs.length!==3)return {verdict:'unknown',message:'未取得完整的三份有效样本'};
  const input=outputs.map(o=>({text:JSON.stringify(strictArray(o.text,o.count)),expected_count:o.count}));
  const a=analyzeGlobalOutputs(input,bank), top=a.results[0],second=a.results[1];
  const stable=top.probability>=policy.matchShare&&top.probability-second.probability>=policy.matchMargin;
  return {verdict:stable?(top.model===expected?'match':'mismatch'):'unknown',candidate:top.model,share:top.probability,margin:top.probability-second.probability,results:a.results.slice(0,5).map(r=>({model:r.model,share:r.probability})),sampleCount:3,message:stable?(top.model===expected?'本次指纹符合预期':'本次指纹更接近其他候选，暂停并复检'):'候选差异不充分，保持未知',scope:'ephemeral_fork',calibrated:false};
}
