import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {record} from './store.mjs';
import {TurnPerformance} from './performance.mjs';

// Only structured runtime records are inspected. User/assistant messages and tool
// outputs are never scanned for words resembling model names or response JSON.
export async function scanTranscript(file,targetId){
 const input=createReadStream(file,{encoding:'utf8'}), lines=createInterface({input,crlfDelay:Infinity});
 let owned=false,count=0,selected=null,selectedAt=null,latestTurn=null,lastRecordAt=null;const routes=[],performance=new TurnPerformance();
 try {for await(const line of lines){let r;try{r=JSON.parse(line);}catch{continue;}count++;const p=r.payload||{};
   if(r.type==='session_meta')owned=(p.id||p.session_id)===targetId;
   if(!owned)continue;
   performance.observe(r);
   lastRecordAt=r.timestamp||lastRecordAt;
   if(r.type==='turn_context'){selected=p.model||null;selectedAt=r.timestamp;latestTurn=p.turn_id||latestTurn;}
   if(r.type==='event_msg'&&['model_rerouted','model/rerouted'].includes(p.type)&&p.thread_id===targetId){routes.push({at:r.timestamp,turnId:p.turn_id,from:p.from_model||p.fromModel,to:p.to_model||p.toModel});}
 }}finally{lines.close();input.destroy();}
 if(!owned)throw Error('记录文件不属于目标任务，停止读取');
 return {checkedAt:Date.now(),selected,selectedAt,latestTurn,lastRecordAt,records:count,declared:null,declaredSource:'not_exposed',reroutes:routes.slice(-10),performance:performance.summary(),identityVerified:false,inferenceRequests:0,note:'当前记录未提供原始上游响应。选择的模型与上游响应模型分开显示。'};
}
export async function observe(store){
 const s=await store.read();if(!s?.source?.transcriptPath)return {available:false,reason:'请先运行环境检查以定位目标记录'};
 const observation=await scanTranscript(s.source.transcriptPath,s.target.id);
 await store.update(x=>{x.observation=observation;const key=JSON.stringify([observation.selected,observation.declared,observation.reroutes]);if(x.observationKey!==key){x.observationKey=key;record(x,'observation',observation.declared?'观察到上游响应声明':'已读取目标记录；上游响应模型未暴露');}});
 return observation;
}
