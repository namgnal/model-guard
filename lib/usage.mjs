import path from 'node:path';
import {readJson,updateJson} from './json-file.mjs';
export const LIMITS={hourlyCalls:12,dailyCalls:160};
const summary=(rows,now)=>({hour:rows.filter(r=>now-r.at<3600000).reduce((n,r)=>n+r.calls,0),day:rows.filter(r=>now-r.at<86400000).reduce((n,r)=>n+r.calls,0),...LIMITS});
async function legacyReservations(store){const rows=[];for(const {store:scoped} of await store.scopes())rows.push(...((await scoped.read())?.reservations||[]));return rows;}
export async function usageSummary(store){const ledger=await readJson(path.join(store.directory,'usage.json'),null);return summary(ledger?.reservations||await legacyReservations(store),Date.now());}
export async function reserveUsage(store,run){
 const file=path.join(store.directory,'usage.json');
 // Include pre-upgrade target reservations when introducing the shared ledger.
 let seed=[];if(!await readJson(file,null))seed=(await legacyReservations(store)).filter(r=>r.runId!==run.id);
 return updateJson(file,{schema:1,reservations:seed},data=>{
  const now=Date.now();data.reservations=data.reservations.filter(r=>now-r.at<86400000);
  if(data.reservations.some(r=>r.runId===run.id))return true;
  const used=summary(data.reservations,now);if(used.hour+run.calls>LIMITS.hourlyCalls||used.day+run.calls>LIMITS.dailyCalls)return false;
  data.reservations.push({at:now,calls:run.calls,runId:run.id,scope:run.scope});return true;
 });
}
