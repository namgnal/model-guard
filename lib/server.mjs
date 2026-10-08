import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import path from 'node:path';
import {ROOT,atomic} from './store.mjs';
import {command} from './service.mjs';
import {observe} from './observe.mjs';
const FILES=new Map([['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/performance.js',['performance.js','text/javascript; charset=utf-8']],['/theme.js',['theme.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function serve(store,{port=0,token=randomBytes(32).toString('hex')}={}){
 let origin;const observers=new Map();
 const attachObserver=async()=>{
  const targets=await store.scopes(),keep=new Set(targets.map(x=>x.entry.id));
  for(const [id,item] of observers)if(!keep.has(id)){item.watcher.close();clearTimeout(item.timer);observers.delete(id);}
  for(const {entry,store:scoped} of targets){
   const s=await scoped.read(),file=s?.source?.transcriptPath;if(!file||observers.get(entry.id)?.file===file)continue;
   const previous=observers.get(entry.id);previous?.watcher.close();clearTimeout(previous?.timer);
   const item={file,timer:null,observing:false,watcher:null};
   try{item.watcher=watch(file,()=>{
    if(item.timer)return;item.timer=setTimeout(async()=>{item.timer=null;if(item.observing)return;item.observing=true;
     try{const state=await scoped.read();if(state.enabled)await observe(scoped);}
     catch(e){await scoped.update(x=>{x.observerError=e.message;}).catch(()=>{});}finally{item.observing=false;}
    },5000);
   });item.watcher.on('error',()=>{item.watcher.close();clearTimeout(item.timer);observers.delete(entry.id);});observers.set(entry.id,item);}
   catch(e){await scoped.update(x=>{x.observerError=e.message;});}
  }
 };
 const server=http.createServer(async(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
   const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
   try{
    if(req.headers.host!==new URL(origin).host)return json(403,{error:'仅接受本地控制台请求'});
    if(req.headers.origin&&req.headers.origin!==origin)return json(403,{error:'来源不匹配'});
    const pathname=new URL(req.url,origin).pathname;
    if(FILES.has(pathname)&&req.method==='GET'){const [file,type]=FILES.get(pathname);res.writeHead(200,{'Content-Type':type});return res.end(await readFile(path.join(ROOT,'web',file)));}
    if(!equal(req.headers.authorization,'Bearer '+token))return json(401,{error:'访问凭证失效，请重新打开本地启动链接'});
    if(pathname==='/api/state'&&req.method==='GET')return json(200,await command(store,'status',{targetId:new URL(req.url,origin).searchParams.get('targetId')||undefined}));
    if(pathname==='/api/command'&&req.method==='POST'){
     if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'需要 JSON'});
     let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)return json(413,{error:'请求过大'});}
     const {action,...data}=JSON.parse(body);
     if(!['doctor','observe','probe','mode','strategy','selftest','targets','discover','target-add','target-select','target-remove','account-probe','account-settings','performance-export'].includes(action))return json(400,{error:'不允许该操作'});
     const value=await command(store,action,data);if(['doctor','target-select','target-add','target-remove'].includes(action))await attachObserver();return json(200,value);
    }
    return json(404,{error:'接口不存在'});
   }catch(e){return json(400,{error:e.message});}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 origin=`http://127.0.0.1:${server.address().port}`;
 const connection={pid:process.pid,url:origin+'/#'+token,startedAt:Date.now()};
 await atomic(path.join(store.directory,'server.json'),connection);
 await attachObserver();server.on('close',()=>{for(const item of observers.values()){item.watcher.close();clearTimeout(item.timer);}});
 return {server,url:connection.url};
}
