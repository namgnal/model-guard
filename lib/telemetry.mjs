// Only native response metadata is evidence. Request settings and generated
// text must never be interpreted as a server declaration.
const responseEvents=new Set(['response.created','response.in_progress','response.completed','response.done','response.metadata']);
export const modelName=value=>typeof value==='string'&&value.trim()&&value.length<=200?value.trim():null;
const norm=value=>modelName(value)?.toLowerCase()||'';
function responseData(message){return message?.params||message;}
function headerModels(headers){
  if(!headers||typeof headers!=='object'||Array.isArray(headers))return [];
  return Object.entries(headers).filter(([key])=>['openai-model','x-openai-model'].includes(key.toLowerCase()))
    .flatMap(([,value])=>Array.isArray(value)?value:[value]).map(modelName).filter(Boolean);
}
export function declaration(message){
  if(!responseEvents.has(message?.type||message?.method))return null;
  const p=responseData(message);
  return headerModels(p?.response?.headers)[0]||headerModels(p?.headers)[0]||modelName(p?.response?.model);
}
function observeLabel(bucket,model,terminal){
  if(!model)return;
  const previous=bucket.terminal||bucket.first;
  if(previous&&norm(previous)!==norm(model))bucket.conflict=true;
  if(terminal)bucket.terminal=model;else bucket.first??=model;
}
export class Telemetry {
  constructor(requested){
    this.requested=requested;this.payload={};this.header={};this.reroutes=[];this.buffering=[];this.invalidRouting=false;
  }
  observe(message){
    const kind=message?.type||message?.method,p=responseData(message)||{};
    if(kind==='model/rerouted'){
      const from=modelName(p.fromModel),to=modelName(p.toModel);
      if(!from||!to||this.reroutes.length>=16){this.invalidRouting=true;return;}
      this.reroutes.push({from,to,reason:modelName(p.reason)});return;
    }
    if(kind==='model/safetyBuffering/updated'){
      if(this.buffering.length>=16){this.invalidRouting=true;return;}
      this.buffering.push({model:modelName(p.model),fasterModel:modelName(p.fasterModel),showBufferingUi:p.showBufferingUi===true});return;
    }
    if(!responseEvents.has(kind))return;
    const terminal=['response.completed','response.done'].includes(kind);
    observeLabel(this.payload,modelName(p.response?.model),terminal);
    // Codex uses response.headers first, then top-level metadata headers. Keep
    // response.model separately: it can echo a request alias on newer routes.
    const responseHeaders=headerModels(p.response?.headers),headers=responseHeaders.length?responseHeaders:headerModels(p.headers);
    for(const model of headers)observeLabel(this.header,model,terminal);
  }
  summary(){
    const header=this.header.terminal||this.header.first||null,payload=this.payload.terminal||this.payload.first||null;
    const observed=header||payload,conflict=!!(header?this.header.conflict:this.payload.conflict);
    return {requested:this.requested,declared:observed,payloadDeclared:payload,headerDeclared:header,payloadDifference:!!(header&&payload&&norm(header)!==norm(payload)),
      declarationSource:header?'response_header':payload?'response_model':'not_exposed',conflict,mismatch:observed?norm(observed)!==norm(this.requested):null,
      reroutes:this.reroutes,safetyBuffering:this.buffering,invalidRouting:this.invalidRouting,source:observed?'native_response_declaration':'not_exposed',identityVerified:false};
  }
}
// No built-in aliases: names changing upstream do not authorize a new mapping.
export function routingDecision(observation,requested,mappings=[]){
  const accepted=x=>!!norm(x)&&(norm(x)===norm(requested)||mappings.some(m=>norm(m.requested)===norm(requested)&&norm(m.upstream)===norm(x)));
  if(observation.conflict)return {state:'conflicting',pause:true};
  if(observation.invalidRouting)return {state:'invalid_routing',pause:true,inconclusive:true};
  if(observation.reroutes?.some(r=>!accepted(r.to)))return {state:'unexpected_reroute',pause:true};
  if(observation.safetyBuffering?.length)return {state:'safety_buffering',pause:true,inconclusive:true};
  if(!observation.declared)return {state:'not_exposed',pause:false,verified:false};
  if(!accepted(observation.declared))return {state:'unreviewed_difference',pause:true};
  return {state:norm(observation.declared)===norm(requested)?'same_label':'approved_mapping',pause:false,verified:false};
}
