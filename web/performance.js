const $=id=>document.getElementById(id);
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const number=n=>finite(n)?n.toLocaleString('zh-CN',{maximumFractionDigits:1}):'—';
const ms=n=>finite(n)?(n>=1000?number(n/1000)+' s':number(n)+' ms'):'—';
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
const workloads={'metadata-v1':'短探针','text-256-v1':'标准测速','actual-turn':'实际会话'};
const scopes={standalone_account_probe:'账号',independent_native_probe:'会话探针',selected_session:'本会话'};
const statuses={completed:'完成',failed:'失败',timeout:'超时',interrupted:'中断',invalid:'无效'};
let current=null,selected='',groupKey='',exportGroup=null;

function sparkline(samples,metric,label,format){
 const area=$('performance-chart');area.replaceChildren();
 const values=samples.filter(s=>s.status==='completed'&&finite(s[metric])).slice(0,30).reverse();
 if(values.length<2){area.append(el('p','累积至少 2 次有效记录后显示趋势。','hint'));return;}
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');
 svg.setAttribute('viewBox','0 0 640 100');svg.setAttribute('role','img');svg.setAttribute('aria-label',label+'，最近 '+values.length+' 次，按采样顺序排列');
 const min=Math.min(...values.map(s=>s[metric])),max=Math.max(...values.map(s=>s[metric])),span=max-min||1;
 const points=values.map((s,i)=>[12+i*616/(values.length-1),max===min?50:84-(s[metric]-min)/span*68]);
 const line=document.createElementNS(ns,'polyline');line.setAttribute('points',points.map(p=>p.join(',')).join(' '));svg.append(line);
 values.forEach((s,i)=>{const dot=document.createElementNS(ns,'circle'),title=document.createElementNS(ns,'title');dot.setAttribute('cx',points[i][0]);dot.setAttribute('cy',points[i][1]);dot.setAttribute('r','3');title.textContent=new Date(s.at).toLocaleString('zh-CN')+' · '+format(s[metric]);dot.append(title);svg.append(dot);});
 area.append(el('p',label+' · '+format(min)+' – '+format(max)+' · 左旧右新，按采样顺序','hint'),svg);
}

function render(){
 const groups=current?.groups||[],g=groups.find(g=>g.id===selected)||groups[0];selected=g?.id||'';
 $('performance-group').value=selected;
 $('performance-empty').hidden=!!g;$('performance-data').hidden=!g;$('performance-export').disabled=!g;
 if(!g){$('performance-count').textContent='等待采样';return;}
 const actual=g.source==='transcript',s=g.stats,latest=g.latest;
 $('performance-count').textContent='近 7 天 · '+g.count+' 次 · 完成 '+g.successCount+' · 失败/超时/无效 '+g.failedCount+(finite(g.failureRate)?'（'+number(g.failureRate*100)+'%）':'');
 const cards=[['首字延迟 · 中位数',ms(s.ttftMs.p50),actual?'记录未提供首字到达时间':'请求发出 → 首个文字块'],['估算生成速度 · 中位数',finite(s.estimatedOutputTps.p50)?number(s.estimatedOutputTps.p50)+' tok/s':'—',actual?'会话耗时包含工具执行':latest.rateUnavailable||'排除推理 Token；流式块折算'],[actual?'轮次耗时 · 中位数':'总耗时 · 中位数',ms(s.e2eMs.p50),actual?'含推理、工具及等待':'不含本地进程启动'],['输入 / 输出 · 平均',number(s.inputTokens.mean)+' / '+number(s.outputTokens.mean),'每次完成记录的 Token 数']];
 $('performance-cards').replaceChildren(...cards.map(([label,value,note])=>{const card=el('article');card.append(el('span',label),el('strong',value),el('p',note));return card;}));
 const c=g.comparison;
 $('performance-comparison').textContent=actual?'实际任务工作量不同，仅作耗时与用量记录，不作模型降速判断。':c.changes.length?c.changes.map(x=>x.metric==='ttftMs'?'近期首字等待增加 '+number((x.ratio-1)*100)+'%':'近期估算生成速度下降 '+number((1-x.ratio)*100)+'%').join('；')+'。同条件近期 5 次与此前 '+c.baselineCount+' 次的中位数比较，仅提示变化，不判断原因。':c.eligible<10?'同条件可比较样本 '+c.eligible+'/10：至少近期 5 次 + 此前 5 次，才提示变化。':'同条件比较尚未触发提示阈值，不代表服务速度没有变化。';
 $('performance-comparison').classList.toggle('performance-warning',c.changes.length>0);
 const rows=[['首个可见事件',s.firstResponseMs,ms],['首字延迟',s.ttftMs,ms],['总耗时',s.e2eMs,ms],['估算输出速度',s.estimatedOutputTps,n=>finite(n)?number(n)+' tok/s':'—'],['估算每 Token 耗时',s.estimatedTpotMs,ms],['端到端输出效率',s.outputTokensPerSecond,n=>finite(n)?number(n)+' tok/s':'—'],['输入 Token',s.inputTokens,number],['输出 Token（含推理）',s.outputTokens,number],['推理 Token',s.reasoningOutputTokens,number],['缓存输入 Token',s.cachedInputTokens,number]];
 $('performance-stats').replaceChildren(...rows.map(([label,stat,format])=>{const tr=el('tr');tr.append(el('th',label),...['mean','p50','p95'].map(k=>el('td',format(stat[k]))),el('td',String(stat.count)));return tr;}));
 $('performance-usage').textContent='完成样本合计：输入 '+number(g.totals.inputTokens)+' / 输出 '+number(g.totals.outputTokens)+' / 其中推理 '+number(g.totals.reasoningOutputTokens)+' Token。输入缓存命中占比 '+(finite(g.cacheHitRatio)?number(g.cacheHitRatio*100)+'%':'未知')+'。';
 $('performance-latest').textContent=actual?'本地结构化轮次记录；缺少累计用量基线或发生压缩时，用量显示未知。':'最近一次：'+(statuses[latest.status]||'未知')+' · 流式文字块 '+number(latest.chunks)+' · 块间隔 P95 '+ms(latest.chunkGaps?.p95)+' / 最大 '+ms(latest.chunkGaps?.max)+' · 可见重试 '+number(latest.retries)+' · 限流事件 '+number(latest.rateLimits)+' · 本地准备 '+ms(latest.setupMs)+'。'+(latest.diagnostic||'');
 $('performance-diagnostic').textContent=latest.diagnostic||'';
 sparkline(g.samples,actual?'e2eMs':'ttftMs',actual?'轮次耗时趋势':'首字延迟趋势',ms);
 $('performance-history').replaceChildren(...g.samples.slice(0,10).map(s=>{const tr=el('tr');tr.append(el('td',new Date(s.at).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})),el('td',statuses[s.status]||'未知'),el('td',ms(s.ttftMs)),el('td',ms(s.e2eMs)),el('td',number(s.estimatedOutputTps)),el('td',number(s.inputTokens)+' / '+number(s.outputTokens)));return tr;}));
}
export function drawPerformance(data,onExport){
 current=data;exportGroup=onExport;const groups=data?.groups||[],key=JSON.stringify(groups.map(g=>g.id));
 if(key!==groupKey){groupKey=key;$('performance-group').replaceChildren(...groups.map(g=>{const option=el('option',(scopes[g.scope]||g.scope)+' · '+(workloads[g.workload]||g.workload)+' · '+(g.model||'模型未知')+' / '+(g.effort||'档位未知')+' · '+(g.provider||'连接未知'));option.value=g.id;return option;}));}
 render();
}
$('performance-group').addEventListener('change',()=>{selected=$('performance-group').value;render();});
$('performance-export').addEventListener('click',()=>{
 if(selected&&exportGroup)exportGroup(selected);
});
