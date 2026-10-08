import {mkdir,readFile,writeFile,open,rename,unlink,stat} from 'node:fs/promises';
import {readJson,updateJson} from './json-file.mjs';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
export const ROOT=path.resolve(import.meta.dirname,'..');
export const DATA=path.resolve(process.env.MODEL_GUARD_DATA||path.join(process.env.CODEX_HOME||path.join(homedir(),'.codex'),'model-guard'));
export const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
export async function atomic(file,value){
  await mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.${process.pid}.${randomUUID()}.tmp`;
  const f=await open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2));await f.sync();}finally{await f.close();}
  try{for(let i=0;;i++){try{await rename(tmp,file);break;}catch(e){if(i>5||!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;await delay(20*(i+1));}}}finally{await unlink(tmp).catch(()=>{});}
}
export const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
export class Store {
  constructor(directory=DATA,statePath='state.json'){this.directory=path.resolve(directory);this.file=path.resolve(directory,statePath);this.statePath=statePath;}
  scope(entry){
    const expected=entry.file==='state.json'?'state.json':path.join('targets',entry.id,'state.json');
    if(!validId(entry.id)||path.normalize(entry.file)!==expected)throw Error('监测对象路径无效');
    return new Store(this.directory,expected);
  }
  async registry(){
    const registryFile=path.join(this.directory,'registry.json');
    let r=await readJson(registryFile,null);
    if(!r){
      const current=await this.read();
      await updateJson(registryFile,{schema:1,activeId:current?.target.id||null,defaultId:current?.target.id||null,targets:current?[{...current.target,file:'state.json'}]:[]},()=>{});
      r=await readJson(registryFile,null);
    }
    if(r?.schema!==1||!Array.isArray(r.targets)||r.targets.some(x=>!validId(x.id))||new Set(r.targets.map(x=>x.id)).size!==r.targets.length)throw Error('会话登记表损坏，保持现有保护');
    for(const entry of r.targets)this.scope(entry);
    if(!Object.hasOwn(r,'defaultId')){
      // Keep legacy CLI callers pinned to their original task, independent of UI selection.
      await updateJson(registryFile,null,current=>{if(!Object.hasOwn(current,'defaultId'))current.defaultId=current.targets.find(x=>x.file==='state.json')?.id||null;});
      r=await readJson(registryFile,null);
    }
    return r;
  }
  async scopes(){return (await this.registry()).targets.map(entry=>({entry,store:this.scope(entry)}));}
  async selected(id){
    const r=await this.registry();
    const entry=r.targets.find(x=>x.id===(id??r.activeId));
    if(!entry)return null;
    return {registry:r,entry,store:this.scope(entry)};
  }
  async active(){const selected=await this.selected();if(!selected)throw Error('请先添加会话，或使用账号独立检测');return selected;}
  async addScope(state){
    const id=state.target.id;if(!validId(id))throw Error('会话 ID 无效');
    await this.registry();let scoped;
    await updateJson(path.join(this.directory,'registry.json'),null,async r=>{
      if(r.targets.some(x=>x.id===id))throw Error('这个会话已经添加');
      const entry={...state.target,file:path.join('targets',id,'state.json')};scoped=this.scope(entry);
      const previous=await scoped.read();if(previous&&!previous.removed)throw Error('该会话已有未移除的监测记录，请检查登记表');
      if(previous){state.samples=previous.samples;state.events=previous.events;state.reservations=previous.reservations;state.epoch=previous.epoch+1;}
      await scoped.update(()=>({replace:state}),{create:true});await atomic(path.join(path.dirname(scoped.file),'target.json'),state.target);
      r.targets.push(entry);r.activeId=id;r.defaultId??=id;
    });return scoped;
  }
  async selectScope(id){
    await this.registry();let scoped;await updateJson(path.join(this.directory,'registry.json'),null,r=>{
      const entry=r.targets.find(x=>x.id===id);if(!entry)throw Error('会话未添加');r.activeId=id;scoped=this.scope(entry);
    });return scoped;
  }
  async removeScope(id){
    await this.registry();
    await updateJson(path.join(this.directory,'registry.json'),null,async r=>{
      const entry=r.targets.find(x=>x.id===id);if(!entry)throw Error('会话未添加');
      const scoped=this.scope(entry);await scoped.update(state=>{
        if(state.mode==='protect'||state.halt||state.run)throw Error('请先关闭此会话的保护并等待检测结束，再移除');
        state.enabled=false;state.mode='off';state.epoch++;state.action=null;state.removed=true;
      });
      r.targets=r.targets.filter(x=>x.id!==id);
      if(r.activeId===id)r.activeId=r.targets[0]?.id||null;
      if(r.defaultId===id)r.defaultId=null;
    });
  }
  async read(){try{const s=JSON.parse(await readFile(this.file,'utf8'));if(s.schema!==1||!s.target?.id)throw Error('状态版本或目标无效');return s;}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  async update(fn,{create=false}={}){
    await mkdir(path.dirname(this.file),{recursive:true});const lock=this.file+'.lock';let handle;
    for(let i=0;i<80;i++){
      try{handle=await open(lock,'wx');await handle.writeFile(JSON.stringify({pid:process.pid}));break;}
      catch(e){if(e.code!=='EEXIST')throw e;
        try{const owner=JSON.parse(await readFile(lock,'utf8'));if(Number.isSafeInteger(owner.pid)&&!alive(owner.pid))await unlink(lock);}
        catch(err){if(err.code!=='ENOENT'&&err instanceof SyntaxError){const info=await stat(lock).catch(()=>null);if(info&&Date.now()-info.mtimeMs>30000)throw Error('状态锁损坏，请检查；未强行接管');}}
        await delay(20);
      }
    }
    if(!handle)throw Error('监测状态正忙，请重试');
    try{let s=await this.read();if(!s&&!create)throw Error('尚未配置监测目标');const result=await fn(s);if(result?.replace)s=result.replace;if(s){s.revision=(s.revision||0)+1;s.updatedAt=Date.now();await atomic(this.file,s);}return result?.value??result;}
    finally{await handle.close();await unlink(lock);}
  }
  async eventSnapshot(run){await atomic(path.join(this.directory,'samples',`${run.id}.json`),run);}
}
export function record(s,type,text,details={},now=Date.now()){s.events=[{id:randomUUID(),at:now,type,text,details},...(s.events||[])].slice(0,300);}
