import {drawPerformance} from './performance.js';
const $=id=>document.getElementById(id);
const supplied=location.hash.slice(1);if(/^[a-f0-9]{64}$/.test(supplied)){sessionStorage.setItem('guard-token',supplied);history.replaceState(null,'',location.pathname);}
const token=sessionStorage.getItem('guard-token')||'';
const date=t=>t?new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}):'—';
const phases={unconfigured:'待配置',unknown:'尚未验证',healthy:'本次检测符合预期',checking:'检测中',paused:'监测器暂停',ready:'等待恢复检查',resuming:'恢复待确认',manual:'用户手动暂停',off:'已关闭'};
const modeNames={observe:'观察模式',protect:'自动保护',off:'已关闭'};
const evidenceName=t=>t?.declarationSource==='response_header'?'服务端响应头':t?.declared?'响应体模型字段':'未暴露模型声明';
let busy=false,currentTarget=null,latestState=null,discoveryCursor=null,discovered=new Map(),sessionKey='';
let modelChoices=[],modelsLoading=false,catalogReady=false;
const navLinks=[...document.querySelectorAll('[data-nav-target]')];
const navSections=navLinks.map(link=>$(link.dataset.navTarget));
function setActiveNav(id){navLinks.forEach(link=>{const active=link.dataset.navTarget===id;link.classList.toggle('selected',active);if(active)link.setAttribute('aria-current','location');else link.removeAttribute('aria-current');});}
function hashNav(){const id=location.hash.slice(1);if(navLinks.some(l=>l.dataset.navTarget===id))setActiveNav(id);else scrollNav();}
function scrollNav(){
 const sections=navSections.filter(el=>el&&el.getBoundingClientRect().height>0);
 const passed=sections.filter(el=>el.getBoundingClientRect().top<=(parseFloat(getComputedStyle(el).scrollMarginTop)||0)+1);
 const atBottom=window.scrollY>0&&Math.ceil(window.scrollY+window.innerHeight)>=document.documentElement.scrollHeight;
 setActiveNav((atBottom?sections.at(-1):passed.at(-1))?.id||'overview');
}
navLinks.forEach(link=>link.addEventListener('click',()=>setActiveNav(link.dataset.navTarget)));
let scrollQueued=false;
function queueScrollNav(){if(scrollQueued)return;scrollQueued=true;requestAnimationFrame(()=>{scrollQueued=false;scrollNav();});}
window.addEventListener('hashchange',hashNav);
window.addEventListener('scroll',queueScrollNav,{passive:true});
window.addEventListener('resize',queueScrollNav);hashNav();
async function api(url,body){const res=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await res.json();if(!res.ok)throw Error(data.error||'请求失败');return data;}
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function element(tag,text,className){const node=document.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;}
function drawSessions(sessions){
 const key=JSON.stringify(sessions);if(key===sessionKey)return;sessionKey=key;
 $('session-list').replaceChildren(...(sessions.length?sessions.map(item=>{
  const row=element('div',null,'session-row'+(item.active?' active':'')),info=element('div'),actions=element('div');
  info.append(element('strong',item.title),element('small',item.error||((item.model||'未读取')+' · '+(modeNames[item.mode]||'待验证'))));
  const select=element('button',item.active?'正在查看':'查看');select.type='button';select.disabled=item.active;select.dataset.selected=String(item.active);select.addEventListener('click',()=>run('target-select',{id:item.id}));
  const remove=element('button','移除','link danger-link');remove.type='button';remove.addEventListener('click',()=>run('target-remove',{id:item.id}));
  actions.append(select,remove);row.append(info,actions);return row;
 }):[element('p','尚未添加会话。可以直接运行下方的账号独立检测。','hint')]));
}
function drawAccount(account,globalBudget){
 const check=account?.latest,result=check?.result,usage=result?.usage?.[0];
 $('account-status').textContent=account?.run?'独立检测正在进行…':result?
  (result.sourceModel||check.profile.model)+' → '+(result.candidate||'未取得声明')+' · '+({match:'本次符合预期',mismatch:'名称差异待复核',unknown:'无法判断'}[result.verdict]||'无法判断')+' · '+date(check.at)+' · '+evidenceName(result.telemetry?.[0])+(result.verdict==='unknown'?' · '+result.message:'')+(usage?' · 输入 '+usage.inputTokens+' / 输出 '+usage.outputTokens+' token':'')
  :account?.interrupted?'上次检测中断，未产生有效结果，可以重新检测。':'尚未运行独立检测。';
 accountControls();
 $('account-budget').textContent='全部会话与独立检测共用预算：最近一小时 '+globalBudget.hour+'/'+globalBudget.hourlyCalls+' 次，最近24小时 '+globalBudget.day+'/'+globalBudget.dailyCalls+' 次。';
}
function draw(s){
 latestState=s;currentTarget=s.activeTargetId||null;const has=!!s.target,policy=s.policy||{};
 $('target').textContent=s.target?.title||'尚未添加监测会话';$('mode').textContent=has?modeNames[s.mode]:'独立检测可用';
 $('phase').textContent=has?(s.phase==='healthy'&&!s.evidenceFresh?'检测结果已过期':phases[s.phase]||'尚未验证'):'等待添加会话';
 $('summary').textContent=!has?'在“会话与账号”中添加已有会话，或直接运行账号独立检测。':s.mode==='protect'?'此会话的后续工具调用受暂停门控约束。':s.mode==='off'?'此会话的监测已关闭。':'当前只观察与验证，尚未接管此会话。';
 const native=(s.samples||[]).find(x=>x.method==='native'),declared=native?.telemetry?.[0]?.declared||null;
 $('requested').textContent=s.observation?.selected||s.source?.model||'—';$('declared').textContent=declared||'未获取';
 $('declaration-note').textContent=native?'独立原生探针 · '+evidenceName(native.telemetry?.[0])+' · '+date(native.at):'尚无此会话的检测结果';
 $('match-badge').textContent=native?({same_label:'探针名称一致',approved_mapping:'已认可的灰度映射',unreviewed_difference:'名称差异待复核',conflicting:'响应声明冲突',unexpected_reroute:'原生改路由待复核',safety_buffering:'安全缓冲 · 无法判断',invalid_routing:'路由证据无效',not_exposed:'未暴露模型声明'}[native.routingState]||'待复核'):'尚未验证';
 $('record-at').textContent=s.observation?'读取 '+s.observation.records+' 条记录 · '+date(s.observation.checkedAt):'尚未读取会话记录';
 const globalBudget=s.globalBudget||{hour:0,day:0,hourlyCalls:12,dailyCalls:160};
 $('budget-day').replaceChildren(document.createTextNode(String(globalBudget.day)),element('small','次'));
 $('budget-note').textContent='全局 · 每小时 '+globalBudget.hourlyCalls+' 次 / 24小时 '+globalBudget.dailyCalls+' 次';
 const sample=s.samples?.[0];$('fingerprint').textContent=sample?({match:'符合预期',mismatch:'需要复核',unknown:'无法判断'}[sample.verdict]):'未运行';
 $('fingerprint-note').textContent=sample?(sample.method==='native'?'原生短请求':'行为指纹')+' · '+date(sample.at):'当前会话还没有检测结果';
 const usage=sample?.usage?.[0];$('usage').textContent=usage?'本次输入 '+Number(usage.inputTokens).toLocaleString()+' / 输出 '+Number(usage.outputTokens).toLocaleString()+' token':'';
 $('takeover').textContent=s.mode==='protect'?'已启用':'未启用';
 drawSessions(s.sessions||[]);drawAccount(s.account,globalBudget);drawPerformance(s.performance,groupId=>run('performance-export',{targetId:currentTarget,groupId}));
 document.querySelectorAll('[data-add-session]').forEach(button=>{const added=s.sessions?.some(x=>x.id===button.dataset.addSession);button.textContent=added?'已添加':'添加';button.disabled=busy||added;});
 $('readiness').replaceChildren(...(has?(s.readiness||[]).map(r=>{const li=element('li'),dot=element('span',r.ok?'✓':'·','dot'+(r.ok?' ok':''));li.append(dot,element('span',r.label),element('small',r.ok?'通过':'待验证'));return li;}):[element('li','添加会话后显示该会话的接管条件。')]));
 for(const id of ['observe','doctor','off','observe-mode'])$(id).disabled=busy||!has;
 $('protect').disabled=busy||!has||!['native','fingerprint'].includes(s.strategy)||(s.readiness||[]).some(x=>!x.ok)||s.mode==='protect';
 $('probe').disabled=busy||!has||!s.verification?.runtimeReady||s.strategy==='passive'||(s.strategy==='fingerprint'&&!s.verification?.hookReady);
 $('probe').textContent=s.strategy==='fingerprint'?'运行一次指纹检测':'运行一次短请求检测';
 document.querySelectorAll('[name=strategy]').forEach(el=>{el.checked=has&&el.value===s.strategy;el.disabled=busy||!has||s.mode==='protect';});
 $('policy').textContent=!has?'添加会话后可配置检测方式。账号独立检测无需会话。':s.strategy==='passive'?'仅观察此会话的本地信号，不自动提问。':'每 '+policy.toolInterval+' 次工具调用检查，最短 '+policy.minIntervalMinutes+' 分钟。证据最多有效 '+policy.maxEvidenceMinutes+' 分钟；暂停后每 '+policy.recoveryMinutes+' 分钟复检，连续 '+policy.recoveryPasses+' 轮通过再申请恢复。';
 const rows=has?(s.events||[]).slice(0,10):(s.account?.checks||[]).slice(0,10).map(c=>({at:c.at,text:'账号独立检测：'+c.result.message}));
 $('events-count').textContent=rows.length+' 条';$('events').replaceChildren(...rows.map(e=>{const row=element('div',null,'event'),time=element('time',date(e.at));time.dateTime=new Date(e.at).toISOString();row.append(time,element('p',e.text));return row;}));
 $('updated').textContent='状态更新 '+date(s.updatedAt||s.account?.latest?.at);
 document.querySelectorAll('[data-selected="true"]').forEach(b=>b.disabled=true);
}
async function refresh(){try{draw(await api('/api/state'));}catch(e){message(e.message,true);}}
const scopedActions=new Set(['doctor','observe','probe','mode','strategy','settings']);
function accountControls(){
 const locked=busy||modelsLoading||!!latestState?.account?.run,selected=modelChoices.find(x=>x.model===$('account-model').value);
 $('account-model').disabled=locked||!catalogReady;
 $('account-effort').disabled=locked||!catalogReady||!selected?.efforts.length;
 $('account-probe').disabled=locked||!catalogReady||!selected?.efforts.includes($('account-effort').value);
 $('account-speed').disabled=$('account-probe').disabled;
 $('account-models-refresh').disabled=locked;
}
function updateEfforts(preferred=$('account-effort').value,preserve=false){
 const model=modelChoices.find(x=>x.model===$('account-model').value),efforts=model?.efforts||[];
 $('account-effort').replaceChildren(...(efforts.length?efforts.map(value=>{const option=element('option',value);option.value=value;return option;}):[element('option','暂无可选档位')]));
 if(preserve&&preferred!==null&&preferred!==undefined&&!efforts.includes(preferred)){
  const option=element('option',preferred?'原档位 '+preferred+' 已不可用，请选择':'请选择检测档位');option.value='';option.disabled=true;$('account-effort').prepend(option);$('account-effort').value='';
 }else $('account-effort').value=efforts.includes(preferred)?preferred:efforts.includes(model?.defaultEffort)?model.defaultEffort:efforts[0]||'';
 accountControls();
}
async function loadAccountModels(){
 if(modelsLoading)return;const previousModel=$('account-model').value,previousEffort=$('account-effort').value;
 modelsLoading=true;accountControls();$('account-provider').textContent='正在读取 Codex 可选模型…';
 try{
  const {profile,models,checkedAt}=await api('/api/command',{action:'account-settings'});
  if(!Array.isArray(models)||!models.length)throw Error('模型列表为空，请刷新重试');
  modelChoices=models;const wanted=previousModel||profile.model;
  const placeholder=element('option','请选择检测模型');placeholder.value='';placeholder.disabled=true;
  $('account-model').replaceChildren(placeholder,...models.map(item=>{const option=element('option',item.label+' · '+item.model);option.value=item.model;option.title=item.description;return option;}));
  $('account-model').value=models.some(x=>x.model===wanted)?wanted:'';
  catalogReady=true;updateEfforts(previousModel?previousEffort:profile.effort,true);
  $('account-provider').textContent='当前原生连接：'+profile.provider+' · 已同步 '+models.length+' 个模型 · '+date(checkedAt)+'。列表不代表访问权限，实际请求以检测结果为准。'+($('account-model').value?'':'原选择已不可用，请重新选择。');
 }catch(e){catalogReady=false;$('account-provider').textContent='无法读取模型列表：'+e.message+'。可点击“刷新列表”重试。';}
 finally{modelsLoading=false;accountControls();}
}
async function run(action,data={}){
 if(busy)return;const payload={action,...data};if(scopedActions.has(action)){if(!currentTarget)return message('请先添加会话',true);payload.targetId=currentTarget;}
 busy=true;document.querySelectorAll('button:not([data-theme-mode])').forEach(b=>b.disabled=true);accountControls();
 message(['probe','account-probe'].includes(action)?'正在通过原生临时请求检测，请稍候…':'正在处理…');
 try{const result=await api('/api/command',payload);message(result.reason||result.note||result.result?.message||(action==='selftest'?(result.passed?'离线检查通过。':'离线检查失败。'):'已更新。'));if(action==='target-add')$('target-id').value='';}
 catch(e){message(e.message,true);}
 finally{busy=false;document.querySelectorAll('button:not([data-theme-mode])').forEach(b=>b.disabled=false);await refresh();}
}
async function discover(more=false){
 if(busy)return;busy=true;$('discover-targets').disabled=true;$('more-targets').disabled=true;$('search-targets').disabled=true;
 message('正在读取本机已有会话…');
 try{
  const result=await api('/api/command',{action:'discover',cursor:more?discoveryCursor:null,searchTerm:$('session-search').value.trim()});
  if(!more)discovered.clear();for(const item of result.sessions||[])discovered.set(item.id,item);discoveryCursor=result.nextCursor;
  $('discovered').hidden=false;$('more-targets').hidden=!discoveryCursor;
  $('discovery-list').replaceChildren(...(discovered.size?[...discovered.values()].map(item=>{
   const row=element('div',null,'discovered-row'),info=element('div'),button=element('button','添加');
   info.append(element('strong',item.title),element('small',item.id));button.type='button';button.dataset.addSession=item.id;button.addEventListener('click',()=>run('target-add',{id:item.id}));
   if(latestState?.sessions?.some(x=>x.id===item.id)){button.textContent='已添加';button.disabled=true;}
   row.append(info,button);return row;
  }):[element('p','没有找到匹配会话，可直接粘贴会话 ID 添加。','hint')]));
  message('已读取 '+discovered.size+' 个会话。');
 }catch(e){message(e.message,true);}
 finally{busy=false;$('discover-targets').disabled=false;$('more-targets').disabled=false;$('search-targets').disabled=false;}
}
for(const action of ['observe','doctor','probe','selftest'])$(action).addEventListener('click',()=>run(action));
$('target-add').addEventListener('click',()=>{const id=$('target-id').value.trim();if(!id)return message('请输入会话 ID，或从发现列表选择。',true);run('target-add',{id});});
$('discover-targets').addEventListener('click',()=>{if(!$('discovered').hidden){$('discovered').hidden=true;$('discover-targets').textContent='发现已有会话';return;}discover().then(()=>{if(!$('discovered').hidden)$('discover-targets').textContent='收起会话列表';});});$('search-targets').addEventListener('click',()=>discover());$('more-targets').addEventListener('click',()=>discover(true));
$('session-search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();discover();}});
$('account-probe').addEventListener('click',()=>{const model=$('account-model').value.trim();if(!model)return message('请指定要检测的模型。',true);run('account-probe',{model,effort:$('account-effort').value});});
$('account-speed').addEventListener('click',()=>{const model=$('account-model').value.trim();if(!model)return message('请指定要检测的模型。',true);run('account-probe',{model,effort:$('account-effort').value,workload:'text-256-v1'});});
$('account-model').addEventListener('change',()=>updateEfforts());
$('account-effort').addEventListener('change',accountControls);
$('account-models-refresh').addEventListener('click',()=>loadAccountModels());
$('protect').addEventListener('click',()=>run('mode',{mode:'protect'}));$('off').addEventListener('click',()=>run('mode',{mode:'off'}));$('observe-mode').addEventListener('click',()=>run('mode',{mode:'observe'}));
document.querySelectorAll('[name=strategy]').forEach(el=>el.addEventListener('change',()=>run('strategy',{strategy:el.value})));
await refresh();
await loadAccountModels();
setInterval(()=>{if(!busy)refresh();},5000);
