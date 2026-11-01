import { CASE_ID, EVIDENCE, PEOPLE, TIMELINE, CLAIMS } from './case-data.mjs';
import { createState, normalizeState, assessVerdict, buildReport } from './investigation.mjs';
import { initEntryFlow, validateFiles } from './onboarding.mjs';
import { studioMarkup } from './template.mjs';

// The approved evidence room owns this DOM subtree; React owns its lifecycle.
export function mountStudio(root,bridge){
const abort=new AbortController(),signal=abort.signal;
const bodyClasses=document.body.className;
const asset=name=>bridge.assets[name]||'';
const listen=(target,event,handler)=>target.addEventListener(event,handler,{signal});
document.body.classList.add('case-entry');root.innerHTML=studioMarkup(asset);

const $ = s => root.querySelector(s);
const $$ = s => [...root.querySelectorAll(s)];
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const storageKey = 'truthtrace.case-001.investigation.v1';
let state;
try { state = normalizeState(JSON.parse(localStorage.getItem(storageKey))); } catch { state = createState(); }
let currentView = 'graph', activeDialog = null, uploadQueue = [], uploadedEvidence = [];
let centerSelection={type:'evidence',id:'E-02'}, centerCatalogQuery='', centerFilter='all', centerQuery='', centerRenderedKey='';
let zoom = 1, baseScale = 1, pan = {x:0,y:0}, drag = null, toastTimer;
let activeFinding=null, nativeGraphFullscreen=false, presentationReturnFocus=null, catTimer;
const viewport = $('#boardViewport'), world = $('#boardWorld'), wall = $('#evidenceWall'), dialog = $('#investigationDialog');
const layout=$('.investigation-layout');
const graphFindings={
  time:{ids:['E-02','E-03'],title:'退款时间存在不一致',action:'compare',detail:'打开证据对照 ↗'},
  identity:{ids:['E-01','E-04'],title:'招募主体身份待确认',action:'identity',detail:'查看主体核查 ↗'}
};
const nodeSources = {'node-location':'E-01','node-poster':'E-01','node-chat':'E-02','node-receipt':'E-03','node-group':'E-04','node-supplement':'E-05'};
const nodePeople = {'node-student':'zhang','central-node':'studio','node-contact':'li','node-peers':'chen','node-wang':'wang'};
function save() { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Remain usable without browser storage. */ } }
function available() { return [...EVIDENCE.filter(e=>!e.extra||state.extra), ...uploadedEvidence]; }
function evidence(id) { return available().find(e=>e.id===id); }
function claim(id) { return CLAIMS.find(c=>c.id===id); }
function initialClues() { return ['C-02','C-03'].every(id=>state.clues.includes(id)); }
function progress() { return Number(initialClues())+Number(state.stage>=1)+Number(state.stage===2); }
function count(n) { return String(n).padStart(2,'0'); }
function toast(message) {
  $('#previewToast').textContent=message; $('#previewToast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#previewToast').classList.remove('visible'),3200);
}
function sourceButton(id, label=id) { return `<button type="button" class="source-chip" data-action="evidence" data-id="${id}">${esc(label)} ↗</button>`; }
const viewNames={center:'调查中心',graph:'线索关系图',timeline:'事件时间线',evidence:'证据档案',people:'人物档案',tasks:'调查任务'};
function showView(view, navIndex) {
  if(view!=='center'&&wall.classList.contains('center-presenting'))toggleCenterPresentation(false);
  if(view!=='graph'&&layout.classList.contains('graph-presenting'))toggleGraphPresentation(false);
  if(view!=='graph'){clearFindingFocus();zoom=1;pan={x:0,y:0}}
  currentView=view; $('#wallTitle').textContent=viewNames[view];
  $('.investigation-layout').classList.toggle('center-mode',view==='center');
  viewport.classList.toggle('center-viewport',view==='center');
  $$('.hero-actions button')[0].dataset.action=view==='center'?'center-supplement':'unlock';
  updateAssistantBar();
  updatePresentationButton();
  world.hidden=view!=='graph'; $('#alternateView').hidden=view==='graph'; viewport.classList.toggle('reading-view',view!=='graph');
  $$('.view-tabs button').forEach((b,i)=>{const selected=['graph','timeline','evidence'][i]===view;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected))});
  const index=navIndex??{center:0,graph:1,timeline:2,evidence:3,people:4,tasks:5}[view];
  $$('.nav-item').forEach((b,i)=>{b.classList.toggle('active',i===index);if(i===index)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  renderAlternate(); if(view==='graph'){fitBoard();updateThreads()}
  history.replaceState(null,'',`#${view}`);
}
function tasks() {
  return [
    {done:initialClues(),title:'摘录两条时间线索',detail:'翻阅 E-02、E-03，把关键说法收入线索簿。',action:'next'},
    {done:state.stage>=1,title:'对照证据，记录判断',detail:'区分“时间不一致”与“已经证明欺骗”。',action:'compare'},
    {done:state.stage===2,title:'补充回单，完成复核',detail:state.extra?'回单已取得，摘录后重新核对交易关系。':'阶段判断完成后，打开新的补充档案。',action:'unlock'}
  ];
}
function renderTasks(compact=false) {
  return tasks().map((t,i)=>`<button type="button" class="mission-step ${t.done?'done':''}" data-action="${t.action}"><span class="mission-check">${t.done?'✓':`0${i+1}`}</span><span><strong>${t.title}</strong>${compact?'':`<small>${t.detail}</small>`}</span><span class="mission-end">${t.done?'完成':'→'}</span></button>`).join('');
}
function renderMain() {
  const items=available(), stats=$$('.stat>strong');
  stats[0].textContent=count(items.length); stats[2].textContent=state.stage===2?'01':'02'; stats[3].textContent=state.extra?'10':'09';
  $('#immersiveSummary').textContent=`${count(items.length)} 份证据 · 04 位人物 · ${state.stage===2?'01':'02'} 个待核实问题 · ${state.extra?'10':'09'} 条关联`;
  $('.case-badge').textContent=state.stage===2?'已复核':'调查中';
  $('.sync-status').innerHTML=`<i></i>${state.clues.length?`已收录 ${state.clues.length} 条线索`:'模拟调查 · 已就绪'}`;
  $('.recent-evidence').innerHTML=`<div class="sidebar-heading">最近证据 <span>${count(items.length)}</span></div>`+items.slice().reverse().slice(0,5).map(e=>`<button class="recent-file" type="button" data-action="evidence" data-id="${e.id}"><span class="file-icon">${icon('file')}</span><span><strong>${esc(e.title)}</strong><small>${e.id} · ${e.date}${state.read.includes(e.id)?' · 已阅':''}</small></span></button>`).join('');
  $('.nav-item:nth-child(4) small').textContent=count(items.length); $('.nav-item:nth-child(6) small').textContent=state.stage===2?'01':'02'; $('#clueCount').textContent=state.clues.length;
  const finding=$('.finding-paper');finding.classList.toggle('finding-verified',state.stage===2);
  finding.querySelector('h3').textContent=state.stage===2?'退款时间已完成复核':'退款时间存在不一致';
  finding.querySelector('.finding-status').textContent=state.stage===2?'已核查':state.stage===1?'待补证':'待核实';
  finding.querySelector('p').textContent=state.stage===2?'完整回单确认同一笔押金于周六到账。延迟原因和招募主体关系仍待核实。':state.stage===1?'已记录时间疑点，继续补充完整回单，确认是否为同一笔押金。':'聊天中称“周五已退款”，凭证时间却为次日。点击此卡，在图中定位两份材料。';
  finding.querySelector('.finding-sources b').textContent=state.extra?'E-02 · E-03 · E-05':'E-02 · E-03';
  $('.next-panel .panel-heading h2').textContent='调查任务';
  $('.next-paper').innerHTML=renderTasks(true)+`<div class="checklist-footer"><span>本次调查进度</span><span>${progress()} / 3</span></div>`;
  $('.verification-note').innerHTML=`${icon('note')}<button type="button" data-action="notebook">线索簿 · 已摘录 ${state.clues.length} 条 <span>打开 ↗</span></button>`;
  $('.case-index span:last-child').textContent='虚构案件 · 可交互演示';
  if(state.extra&&!$('.node-supplement')) {
    const node=document.createElement('article');node.className='evidence-node node-supplement';node.tabIndex=0;
    node.innerHTML=`<span class="pin"></span><span class="supplement-symbol">${icon('file')}</span><span class="node-category">E-05 / 新补证</span><h3>完整退款回单</h3><small>点击翻阅 ↗</small>`;
    world.append(node);bindNode(node);
    const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.classList.add('supplement-thread');$('.red-threads').append(line);
  }
  $$('.evidence-node').forEach(node=>{
    const id=nodeSources[nodeKey(node)];node.classList.toggle('node-read',!!id&&state.read.includes(id));
    node.classList.toggle('node-collected',!!id&&CLAIMS.some(c=>c.sourceId===id&&state.clues.includes(c.id)));
    const position=state.positions[nodeKey(node)];
    if(position){node.style.left=`${Math.min(position.x,1100-node.offsetWidth)}px`;node.style.top=`${Math.min(position.y,600-node.offsetHeight)}px`}
  });
  updateThreads(); if(currentView!=='graph')renderAlternate();updateAssistantBar();
}
function evidenceCard(e) {
  return `<button type="button" class="archive-card" data-action="evidence" data-id="${e.id}" data-search="${esc(e.title+' '+e.summary)}"><span class="archive-card-top"><span>${e.id}</span><small>${state.read.includes(e.id)?'✓ 已阅':'未读'}</small></span><span class="archive-card-icon">${icon(e.kind==='chat'?'note':'file')}</span><strong>${esc(e.title)}</strong><p>${esc(e.summary)}</p><span class="archive-card-bottom">${e.date}<span>翻阅档案 ↗</span></span></button>`;
}
function renderAlternate() {
  const host=$('#alternateView');if(currentView==='graph')return;
  if(currentView==='center'){renderCenter();return}
  if(currentView==='evidence')host.innerHTML=`<div class="reading-view-header"><div><span class="room-kicker">EVIDENCE ARCHIVE</span><h3>每一份原文，都是调查的起点。</h3></div><input class="archive-search" type="search" placeholder="搜索证据名称或内容" aria-label="搜索证据档案"/></div><div class="archive-grid">${available().map(evidenceCard).join('')}</div>`;
  else if(currentView==='timeline')host.innerHTML=`<div class="reading-view-header"><div><span class="room-kicker">EVENT CHRONOLOGY</span><h3>说法发生在何时，款项又在何时到账？</h3><p>人物说法、材料日期和实际发生时间分开呈现。</p></div></div><div class="chronology">${TIMELINE.filter(t=>!t.extra||state.extra).map(t=>`<button type="button" class="chronology-item ${t.warning?'warning':''}" data-action="evidence" data-id="${t.evidence}"><span class="chronology-time"><b>${t.date}</b><small>${t.time}</small></span><span class="chronology-dot"></span><span class="chronology-paper"><span>${t.type} / ${t.evidence}</span><strong>${t.title}</strong><p>${t.text}</p><small>查看原文 ↗</small></span></button>`).join('')}</div>`;
  else if(currentView==='people')host.innerHTML=`<div class="reading-view-header"><div><span class="room-kicker">PEOPLE & ENTITIES</span><h3>先看说法，再核对身份。</h3></div></div><div class="people-grid">${PEOPLE.map(p=>`<button class="person-card" type="button" data-action="person" data-id="${p.id}"><img src="${asset(p.image)}" alt="虚构${esc(p.name)}示意" style="object-position:${p.position}"/><span><small>${p.role}</small><strong>${p.name}</strong><p>${p.description}</p><em>打开人物档案 ↗</em></span></button>`).join('')}</div>`;
  else host.innerHTML=`<div class="reading-view-header"><div><span class="room-kicker">INVESTIGATION LOG</span><h3>把疑点，推进成可核查的判断。</h3><p>完成 ${progress()} / 3 步 · 进度保存在当前浏览器</p></div><button class="room-button" type="button" data-action="notebook">打开线索簿 ${icon('note')}</button></div><div class="task-page">${renderTasks()}<div class="unresolved-note"><strong>仍待核实：招募主体身份</strong><p>收款账户与“星跃工作室”的关系缺少证明。查看材料，记录下一步补证方向。</p><button type="button" class="text-link" data-action="identity">查看这一疑点 ↗</button></div></div>`;
}

// The investigation center keeps selection, source material and decisions on one page.
function centerPick(type,id,label,classes='') {
  return `<button type="button" class="${classes}" data-center-type="${type}" data-center-id="${id}">${label}</button>`;
}
function selectCenter(type,id) {
  if(type==='evidence'&&!evidence(id))return;
  if(type==='person'&&!PEOPLE.some(p=>p.id===id))return;
  centerSelection={type,id};
  if(type==='evidence'&&!evidence(id).upload&&!state.read.includes(id)){state.read.push(id);save()}
  renderMain();
}
function centerRecords() {
  return [...available().map(e=>({type:'evidence',id:e.id,title:e.title,detail:e.summary})),...PEOPLE.map(p=>({type:'person',id:p.id,title:p.name,detail:p.role}))];
}
function centerCatalog() {
  return centerRecords().map(item=>{
    const selected=centerSelection.type===item.type&&centerSelection.id===item.id;
    const collected=item.type==='evidence'&&CLAIMS.some(c=>c.sourceId===item.id&&state.clues.includes(c.id));
    return `<button class="center-catalog-item ${selected?'selected':''}" type="button" data-center-type="${item.type}" data-center-id="${item.id}" data-kind="${item.type}" data-search="${esc(item.title+' '+item.detail+' '+item.id)}" aria-pressed="${selected}"><small>${item.type==='evidence'?item.id:'人物 / 主体'}${collected?'<i>✓</i>':''}</small><strong>${esc(item.title)}</strong></button>`;
  }).join('');
}
function filterCenterCatalog() {
  const query=centerCatalogQuery.trim().toLowerCase();
  let visible=0;
  $$('.center-catalog-item').forEach(item=>{
    item.hidden=(centerFilter!=='all'&&item.dataset.kind!==centerFilter)||!item.dataset.search.toLowerCase().includes(query);
    if(!item.hidden)visible++;
  });
  if($('#catalogVisible'))$('#catalogVisible').textContent=visible;
  if($('#catalogEmpty'))$('#catalogEmpty').hidden=visible>0;
}
function centerMaterial() {
  if(centerSelection.type==='person') {
    const p=PEOPLE.find(item=>item.id===centerSelection.id);
    return `<div class="center-material-head"><div><span>PERSON / 主体资料</span><h3>${esc(p.name)}</h3></div><span class="center-material-stamp">身份待核实</span></div><div class="center-profile"><img src="${asset(p.image)}" alt="虚构人物或地点示意" style="object-position:${p.position}"/><div><strong>${p.role}</strong><p>${p.description}</p><small>图片为虚构示意，不构成身份认证。</small></div></div><div class="center-source-row"><span>关联材料</span>${p.evidence.filter(id=>evidence(id)).map(id=>centerPick('evidence',id,`${id} ↗`,'center-source-chip')).join('')}</div><div class="center-boundary"><b>当前能确认</b><p>该主体出现在以上材料中；具体组织关系和授权仍需证据支持。</p></div>`;
  }
  const e=evidence(centerSelection.id)||EVIDENCE[1];
  let excerpt;
  if(e.upload)excerpt=`<div class="center-boundary"><b>本地材料 · 未分析</b><p>已加入当前页面的材料档案。打开原文件后可自行核对，当前版本尚未进行 OCR 或 AI 解析。</p></div>`;
  else if(e.messages)excerpt=`<div class="center-transcript">${e.messages.filter(m=>m.claim).map(m=>`<div class="key-statement"><span>${m.speaker}<small>${m.time}</small></span><p>${esc(m.text)}</p></div>`).join('')}</div>`;
  else if(e.fields)excerpt=`<dl class="center-facts">${e.fields.filter(([name])=>['金额','退款金额','完成时间','实际到账','交易单号','退款项目','工作室授权证明'].includes(name)).map(([name,value])=>`<div><dt>${name}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>`;
  else excerpt=`<div class="center-document-lines">${e.lines.slice(1).map(line=>`<p>${esc(line)}</p>`).join('')}</div>`;
  return `<div class="center-material-head"><div><span>${e.id} / ${e.date}</span><h3>${esc(e.title)}</h3></div><button class="center-original-button" type="button" data-action="evidence" data-id="${e.id}">完整原文 ↗</button></div>${e.messages?'':`<p class="center-material-summary">${esc(e.summary)}</p>`}${excerpt}${(e.claims||[]).map(c=>`<div class="center-extract-row"><span><small>可摘录线索 / ${c.id}</small><strong>${c.label}</strong></span><button type="button" class="room-button ${state.clues.includes(c.id)?'quiet':'primary'}" data-action="collect" data-id="${c.id}" ${state.clues.includes(c.id)?'disabled':''}>${state.clues.includes(c.id)?'✓ 已收录':'摘录线索 ＋'}</button></div>`).join('')}`;
}
function centerPair(ids) {
  return `<div class="center-comparison">${ids.map(id=>{
    const c=claim(id);return `<div><span>${c.sourceId} / ${state.clues.includes(id)?'✓ 已收录':'待摘录'}</span><p>“${c.quote}”</p>${centerPick('evidence',c.sourceId,'查看这份材料 →','center-text-button')}</div>`;
  }).join('')}</div>`;
}
function centerVerdictForm(final) {
  const options=final?[
    ['supported','同一笔押金于周六到账，与“周五已退”的说法不一致；延迟原因仍待核实。'],
    ['accuse','可以直接认定对方诈骗。'],['discard','日期不同，所以所有材料都无效。']
  ]:[
    ['supported','时间信息存在差异，应先核实是否为同一笔交易。'],
    ['accuse','到账晚一天，足以证明对方诈骗。'],['discard','日期不同，说明聊天记录一定是伪造的。']
  ];
  return `<form id="centerVerdictForm" class="center-verdict-form"><fieldset><legend>${final?'补证之后，哪一项是有依据的复核结论？':'现在能支持哪一个阶段判断？'}</legend>${options.map(([value,text])=>`<label><input type="radio" name="verdict" value="${value}"/><span>${text}</span></label>`).join('')}</fieldset><div class="center-verdict-bottom"><span id="centerVerdictFeedback" role="status">${final?'单号与退款项目已经对应，继续保留未证明的部分。':'先提出疑点，再用补证核实。'}</span><button class="room-button primary" type="submit">${final?'记录复核结论':'记录阶段判断'} →</button></div></form>`;
}
function centerReview() {
  if(state.stage===2)return `<span class="center-review-label done">✓ 本轮退款时间已完成复核</span><div class="center-final-record"><h4>同一笔押金于 10月31日 17:35 到账。</h4><p>E-05 与 E-03 的单号一致，能够对应到本案押金。这与 10月30日晚“已全部退还”的说法不一致。</p><div class="center-source-row">${['E-02','E-03','E-05'].map(id=>centerPick('evidence',id,`${id} ↗`,'center-source-chip')).join('')}</div></div><div class="center-open-question"><span>仍待查明</span><p>招募主体、账户授权关系和退款延迟原因尚未证明。</p>${centerPick('person','studio','查看招募主体 →','center-text-button')}<button type="button" class="center-text-button" data-action="notebook">查看 / 导出调查笔记 ↗</button></div>`;
  if(state.stage===0&&!initialClues())return `<span class="center-review-label">第 1 步 / 先收录时间线索</span><p class="center-review-intro">把下面两份材料分别看清楚，再记录判断。</p>${centerPair(['C-02','C-03'])}<div class="center-review-hint">已收录 ${['C-02','C-03'].filter(id=>state.clues.includes(id)).length} / 2 条时间线索。点击左侧材料，在上方摘录关键内容。</div>`;
  if(state.stage===0)return `<span class="center-review-label">第 2 步 / 对照材料，记录判断</span>${centerPair(['C-02','C-03'])}${centerVerdictForm(false)}`;
  if(!state.extra)return `<span class="center-review-label">✓ 阶段判断已记录 · 第 3 步 / 补充核查</span><div class="center-supplement-task">${icon('folder')}<div><h4>还缺“同一笔交易”的证明。</h4><p>获取完整退款回单，核对交易单号、退款项目和实际到账时间。</p><button class="room-button primary" type="button" data-action="center-supplement">领取补充回单 E-05 →</button></div></div>`;
  if(!state.clues.includes('C-05'))return `<span class="center-review-label">第 3 步 / 读取新回单，补齐对应关系</span><div class="center-review-hint">E-05 已加入左侧目录。请核对它的单号及退款项目，并在材料区摘录这条补证线索。</div>${centerPair(['C-03','C-05'])}`;
  return `<span class="center-review-label">第 3 步 / 补证复核</span>${centerPair(['C-02','C-05'])}${centerVerdictForm(true)}`;
}
function assistantCue() {
  if(!state.clues.includes('C-02'))return {text:'退款说法与到账时间有差异，先看 E-02。',label:'查看 E-02',action:'evidence',id:'E-02'};
  if(!state.clues.includes('C-03'))return {text:'E-03 记载了实际到账时间。',label:'查看 E-03',action:'evidence',id:'E-03'};
  if(state.stage===0)return {text:'时间不同，还需核对是否为同一笔款项。',label:'对照两份材料',action:'compare'};
  if(!state.extra)return {text:'还缺能对应这笔退款的完整回单。',label:'加入补充回单',action:'unlock'};
  if(!state.clues.includes('C-05'))return {text:'完整回单已就绪，可以核对交易单号。',label:'查看 E-05',action:'evidence',id:'E-05'};
  if(state.stage===1)return {text:'同笔退款已对应，可以记录复核。',label:'记录复核',action:'compare'};
  return {text:'退款时间已复核，招募主体仍待确认。',label:'查看主体关系',action:'identity'};
}
function updateAssistantBar(){
  const cue=assistantCue(),bar=$('.ai-assistant-bar');
  bar.dataset.action='quick-hint';
  bar.innerHTML=`${icon('spark')}<strong>Synapse · 咪探长</strong><span>${cue.text}</span><small class="assistant-inline-cta">${cue.label} →</small>`;
  bar.setAttribute('aria-label',`Synapse · 咪探长：${cue.text} ${cue.label}`);
}
function centerGuide() {
  const cue=assistantCue();
  return `<div class="center-assistant-profile"><img src="${asset('inspector-avatar.png')}" alt="Synapse · 咪探长"/><div><strong>Synapse · 咪探长</strong><span>调查助手 · 示例提示</span></div></div><h4>${cue.text}</h4><button class="room-button primary full-width" type="button" data-action="center-next">${cue.label} →</button>`;
}
function renderCenterQuery() {
  const host=$('#centerQueryResults');if(!host)return;
  const q=centerQuery.trim().toLowerCase();
  const items=available().filter(e=>q?`${e.id} ${e.title} ${e.summary} ${JSON.stringify(e.fields||e.messages||e.lines||[])} ${e.text||''}`.toLowerCase().includes(q):['E-02','E-03','E-05'].includes(e.id)).slice(0,6);
  $('#centerResultCount').textContent=items.length;
  host.innerHTML=items.length?items.map(e=>{
    const facts=e.fields?.filter(([name])=>['交易单号','完成时间','实际到账'].includes(name));
    return centerPick('evidence',e.id,`<span>${e.id} · ${e.date}</span><strong>${esc(e.title)}</strong>${facts?facts.map(([name,value])=>`<p><b>${name}</b>${esc(value)}</p>`).join(''):`<p>${esc(e.summary)}</p>`}<small>查看关联材料 →</small>`,'center-lookup-result');
  }).join(''):'<p class="center-no-results">当前已载入材料中没有匹配记录。试试材料编号、人物名称或交易单号。</p>';
}
function renderCenter() {
  const selectedKey=centerSelection.type+':'+centerSelection.id;
  const previousScroll=centerRenderedKey===selectedKey?($('.center-main')?.scrollTop||0):0;
  const done=[initialClues(),state.stage>=1,state.stage===2];
  $('#alternateView').innerHTML=`<div class="center-shell"><div class="center-route"><div><span>当前专题</span><strong>退款时间核查</strong></div><nav aria-label="调查步骤">${['读材料','记录判断','补证复核'].map((text,i)=>`<button type="button" class="${done[i]?'done':''}" data-action="${i===0?'center-read':i===1?'center-review':'center-supplement'}"><b>${done[i]?'✓':i+1}</b>${text}</button>`).join('')}</nav><span class="center-route-progress">${progress()} / 3</span></div><div class="center-columns"><aside class="center-catalog"><div class="center-panel-heading"><h3>线索目录</h3><span id="catalogVisible">${centerRecords().length}</span></div><input id="centerCatalogSearch" type="search" placeholder="搜索线索、人物…" aria-label="搜索调查线索" value="${esc(centerCatalogQuery)}"/><div class="center-catalog-filters" aria-label="线索类型">${[['all','全部'],['evidence','证据'],['person','人物']].map(([value,label])=>`<button type="button" data-center-filter="${value}" class="${centerFilter===value?'active':''}" aria-pressed="${centerFilter===value}">${label}</button>`).join('')}</div><div class="center-catalog-list">${centerCatalog()}<p id="catalogEmpty" class="center-no-results" hidden>没有匹配线索。</p></div><div class="center-catalog-footer">${available().length} 份材料 · 4 位相关人物<br/>${state.clues.length} 条已摘录线索</div></aside><div class="center-main"><section class="center-material-section"><div class="center-section-heading"><span>01</span><h3>案件资料</h3><small>选择左侧线索查看</small></div><div class="center-material-paper">${centerMaterial()}</div></section><section class="center-review" aria-labelledby="centerReviewTitle"><div class="center-section-heading"><span>02</span><h3 id="centerReviewTitle" tabindex="-1">核查记录</h3><small>本轮进展集中在这里</small></div><div class="center-review-paper">${centerReview()}</div></section></div><aside class="center-right"><section class="center-guide">${centerGuide()}</section><section class="center-query"><div class="center-panel-heading"><h3>关联记录检索</h3>${icon('link')}</div><p>输入单号、姓名或关键词，查找本案已载入的材料。</p><form id="centerQueryForm"><input type="search" name="query" aria-label="检索案件关联记录" placeholder="如 R202610310017" value="${esc(centerQuery)}"/><button type="submit" aria-label="检索关联记录">${icon('chevron')}</button></form><div class="center-results-heading">匹配记录 <span id="centerResultCount">0</span></div><div id="centerQueryResults"></div><small>仅检索当前案件材料，不进行联网查询。</small></section></aside></div></div>`;
  $('.center-main').scrollTop=previousScroll;centerRenderedKey=selectedKey;
  filterCenterCatalog();renderCenterQuery();
}
function centerNext() {
  if(!state.clues.includes('C-02'))selectCenter('evidence','E-02');
  else if(!state.clues.includes('C-03'))selectCenter('evidence','E-03');
  else if(state.extra&&!state.clues.includes('C-05'))selectCenter('evidence','E-05');
  else if(state.stage===2)selectCenter('person','studio');
  else $('.center-review')?.scrollIntoView({behavior:'smooth',block:'nearest'});
}
function centerSupplement() {
  if(state.stage<1){$('.center-review')?.scrollIntoView({behavior:'smooth',block:'nearest'});toast('先核对两条时间线索，记录阶段判断，再补充回单');return}
  if(!state.extra){state.extra=true;save();toast('E-05 已加入目录，可在当前页核对完整交易明细')}
  selectCenter('evidence','E-05');
}

function openDialog(type,id) {activeDialog={type,id};renderDialog();if(!dialog.open)dialog.showModal()}
function closeDialog(){dialog.close();activeDialog=null}
function setDialog(title,kicker,html){$('#dialogTitle').textContent=title;$('#dialogKicker').textContent=kicker;$('#dialogContent').innerHTML=html;dialog.dataset.type=activeDialog.type}
function openEvidence(id){const e=evidence(id);if(!e)return;if(!e.upload&&!state.read.includes(id)){state.read.push(id);save();renderMain()}openDialog('dossier',id)}
function paperContent(e) {
  if(e.upload){
    if(e.kind==='image')return `<div class="local-image"><img src="${e.url}" alt="${esc(e.title)}"/></div>`;
    if(e.kind==='pdf')return `<object class="local-pdf" data="${e.url}" type="application/pdf"><p>无法内嵌 PDF。<a href="${e.url}" target="_blank" rel="noopener">打开文件</a></p></object>`;
    return `<pre class="local-text">${esc(e.text)}</pre>`;
  }
  if(e.kind==='chat')return `<div class="chat-document"><div class="chat-document-title">${e.id==='E-02'?'与李老师的聊天记录':'校园兼职群 (58)'}<small>${e.date} · 演示原文</small></div>${e.messages.map(m=>`<div class="message ${m.self?'self':''}"><span class="message-avatar">${m.speaker.slice(0,1)}</span><div><small>${m.speaker} · ${m.time}</small><p ${m.claim?`class="marked-passage" data-claim="${m.claim}"`:''}>${esc(m.text)}</p></div></div>`).join('')}<div class="document-watermark">FICTIONAL CASE / 模拟材料</div></div>`;
  if(e.kind==='poster')return `<div class="poster-document"><span>STUDENT RECRUITMENT / OCTOBER 2026</span><h3>校园活动<br/>协助人员招募</h3><div class="poster-rule"></div>${e.lines.slice(1).map((line,i)=>`<p class="${i===1?'marked-passage':''}">${line}</p>`).join('')}<div class="document-seal">星跃<br/>招募</div><small>FICTIONAL CASE · 模拟公告</small></div>`;
  return `<div class="receipt-document"><span class="receipt-badge">${e.extra?'补充回单 / E-05':'到账凭证 / E-03'}</span><div class="receipt-check">✓</div><h3>${e.extra?'报名保证金退还':'退款到账'}</h3><strong class="receipt-amount">+ ¥500.00</strong><div class="receipt-fields">${e.fields.map(([label,value])=>`<div><dt>${label}</dt><dd class="${['完成时间','实际到账','交易单号','退款项目'].includes(label)?'marked-value':''}">${value}</dd></div>`).join('')}</div><span class="document-watermark">演示回单 · 不是真实支付凭证</span></div>`;
}
function renderDossier(id) {
  const e=evidence(id);if(!e)return;
  const index=available().findIndex(item=>item.id===id), clues=e.claims||[];
  setDialog(e.title,`EVIDENCE DOSSIER / ${e.id}`,`<div class="dossier-layout"><nav class="dossier-index" aria-label="档案目录"><span>档案目录</span>${available().map(item=>`<button type="button" class="${item.id===id?'active':''}" data-action="evidence" data-id="${item.id}"><b>${item.id}</b>${esc(item.title)}<small>${state.read.includes(item.id)?'✓':'○'}</small></button>`).join('')}<div class="folder-label">${CASE_ID}<br/>校园兼职押金纠纷</div></nav><section class="document-stage"><div class="document-meta"><span>${esc(e.subtitle)}</span><span>档案 ${index+1} / ${available().length}</span></div><div class="document-sheet">${paperContent(e)}</div><div class="dossier-pagination"><button type="button" class="text-link" data-action="evidence" data-id="${available()[Math.max(0,index-1)].id}" ${index===0?'disabled':''}>← 上一份</button><span>${e.id}</span><button type="button" class="text-link" data-action="evidence" data-id="${available()[Math.min(available().length-1,index+1)].id}" ${index===available().length-1?'disabled':''}>下一份 →</button></div></section><aside class="clue-margin"><div class="margin-heading">${icon('note')}<span>线索摘录</span></div><p>留意原文中的时间、金额与主体。把有依据的内容放入线索簿。</p>${clues.map(c=>`<article class="clue-extract ${state.clues.includes(c.id)?'collected':''}"><small>${c.id} · 来源 ${e.id}</small><h3>${c.label}</h3><blockquote>“${c.quote}”</blockquote><button class="room-button ${state.clues.includes(c.id)?'quiet':'primary'}" type="button" data-action="collect" data-id="${c.id}" ${state.clues.includes(c.id)?'disabled':''}>${state.clues.includes(c.id)?'✓ 已收入线索簿':'＋ 摘录这条线索'}</button></article>`).join('')}${!clues.length?'<div class="margin-note">本地文件尚未进行 OCR 或 AI 解析。你可以先翻阅原文，在调查笔记中记录观察。</div>':''}<button class="room-button full-width" type="button" data-action="notebook">查看我的线索簿 <span>${state.clues.length}</span></button>${['E-02','E-03','E-05'].includes(id)?'<button class="text-link margin-compare" type="button" data-action="compare">去证据对照台 →</button>':''}</aside></div>`);
}
function renderCompare() {
  const final=state.stage>=1&&state.extra, ids=final?['C-02','C-05']:['C-02','C-03'];
  const ready=ids.every(id=>state.clues.includes(id)), done=state.stage===2;
  const options=final?[
    ['supported','同笔押金的实际到账为周六，与“周五已退”的说法不一致；延迟原因仍待核实。'],
    ['accuse','已经可以直接认定对方诈骗。'],['discard','日期不一致，所以所有材料都无效。']
  ]:[
    ['supported','时间信息存在差异，先核实两份材料是否对应同一笔交易。'],
    ['accuse','到账晚一天，就足以证明对方实施了诈骗。'],['discard','截图时间不同，说明聊天记录一定是伪造的。']
  ];
  const pair=`<div class="comparison-pair">${ids.map((id,i)=>{const c=claim(id);return `<article class="comparison-paper"><div><span>材料 ${i?'B':'A'} / ${c.sourceId}</span>${sourceButton(c.sourceId,'查看原文')}</div><h3>${c.label}</h3><blockquote>“${c.quote}”</blockquote><p>${c.text}</p><span class="collection-mark">${state.clues.includes(id)?'✓ 线索已摘录':'○ 尚未摘录，点击原文收录'}</span></article>`}).join('')}</div>`;
  let judgment;
  if(done)judgment=`<div class="verdict-complete"><span>✓</span><div><h3>时间疑点已复核，调查仍有下一步。</h3><p>回单确认本案押金于 10月31日 17:35 到账。招募主体、付款授权关系与延迟原因仍未得到证明。</p><div>${sourceButton('E-02')}${sourceButton('E-03')}${sourceButton('E-05')}</div></div></div><div class="dialog-actions"><button class="room-button" type="button" data-action="identity">继续核查主体身份</button><button class="room-button primary" type="button" data-action="notebook">打开调查笔记 →</button></div>`;
  else if(state.stage===1&&!state.extra)judgment=`<div class="verdict-complete pending"><span>✓</span><div><h3>阶段判断已经记录</h3><p>当前只能确认时间信息有差异。打开补充回单，再核实它们是否属于同一笔押金。</p></div></div><div class="dialog-actions"><button class="room-button primary" type="button" data-action="unlock">打开补充档案 →</button></div>`;
  else judgment=`<form id="verdictForm" class="verdict-form"><div class="question-heading"><span>YOUR DEDUCTION</span><h3>你会把哪一个判断写进调查笔记？</h3></div>${options.map(([value,text])=>`<label class="verdict-option"><input type="radio" name="verdict" value="${value}"/><span>${text}</span></label>`).join('')}<div id="verdictFeedback" class="verdict-feedback" role="status">${ready?'判断的边界，应与证据的边界一致。':'先收录上述两条线索，再提交你的判断。'}</div><button class="room-button primary" type="submit" ${ready?'':'disabled'}>${final?'记录复核结论':'记录阶段判断'} ${icon('note')}</button></form>`;
  setDialog(done?'退款时间 · 复核记录':'证据对照台',`CROSS CHECK / ${final?'补证复核':'阶段判断'}`,`<div class="compare-workbench"><div class="workbench-intro"><span class="chapter-chip">${done?'已完成复核':final?'第二步 · 交易对应核查':'第一步 · 时间信息核查'}</span><p>${final?'完整回单提供了交易单号和退款项目。它与原先的聊天说法，能共同支持什么判断？':'先比较聊天中声称的退款时间与凭证上的到账时间。信息不一致时，还缺少哪一环？'}</p></div>${pair}${judgment}</div>`);
}

function renderNotebook() {
  const clues=state.clues.map(id=>{const c=claim(id);return `<article class="notebook-clue"><span>${c.id}</span><div><h3>${c.label}</h3><p>${c.text}</p>${sourceButton(c.sourceId,'返回 '+c.sourceId+' 原文')}</div></article>`}).join('');
  const empty='<div class="notebook-empty">第一条线索，还在等你发现。<p>先打开退款承诺聊天记录，找到那句有关“周五”的说法。</p><button class="room-button primary" type="button" data-action="evidence" data-id="E-02">翻阅 E-02 →</button></div>';
  const verdict=state.stage===0?'尚未记录。对照两份证据后，把有依据的判断写在这里。':state.stage===1?'E-02 与 E-03 的时间信息不同；交易对应关系仍待补证。':'E-05 确认同笔押金于周六到账，与周五晚“已全部退还”的说法不一致。主体身份及原因仍待核实。';
  setDialog('我的调查笔记',`INVESTIGATOR'S NOTEBOOK / ${state.clues.length} CLUES`,`<div class="notebook-layout"><section class="notebook-page"><div class="notebook-title"><span>线索簿</span><small>每一条摘录都保留来源</small></div>${clues||empty}<div class="recorded-verdict"><span>阶段判断</span><p>${verdict}</p>${state.stage?'<button type="button" class="text-link" data-action="compare">查看对照记录 ↗</button>':''}</div><label class="personal-note-label" for="personalNote">我的观察</label><textarea id="personalNote" placeholder="写下尚未确认的地方，或下一步想核查什么…" maxlength="8000">${esc(state.note)}</textarea><span class="save-note">仅保存在当前浏览器 · 输入后自动保存</span></section><aside class="notebook-aside"><span class="room-kicker">INVESTIGATION ROUTE</span><h3>调查进度 ${progress()} / 3</h3>${renderTasks()}<div class="margin-note">尚未确认的主体关系应保留为疑点。没有材料证明，不等于某件事没有发生。</div><button class="room-button primary full-width" type="button" data-action="export">导出调查笔记 ↓</button><button class="text-link reset-case" type="button" data-action="reset">重新开始这次演示</button></aside></div>`);
}
function renderPerson(id) {
  const p=PEOPLE.find(item=>item.id===id);
  const sources=p.evidence.filter(id=>evidence(id)).map(id=>{const e=evidence(id);return `<button class="person-source" type="button" data-action="evidence" data-id="${id}"><span>${id}</span><div><strong>${e.title}</strong><p>${e.summary}</p></div><b>↗</b></button>`}).join('');
  setDialog(p.name,'PERSON DOSSIER / 人物与主体',`<div class="person-dossier"><div class="person-profile"><img src="${asset(p.image)}" alt="虚构人物或地点示意" style="object-position:${p.position}"/><span class="profile-stamp">身份待核实</span><h3>${p.name}</h3><span>${p.role}</span><p>${p.description}</p><small>图片为虚构示意，不是身份认证材料。</small></div><div class="person-evidence"><span class="room-kicker">LINKED EVIDENCE</span><h3>先查看这个主体出现在什么材料里</h3>${sources}<div class="unresolved-note"><strong>还想问什么？</strong><p>${['studio','wang','li'].includes(id)?'应补充组织主体信息、账户关系和授权证明，再判断各方责任。':'可以补充完整付款记录、活动经历和相关证言，避免只凭片段聊天推断。'}</p><button class="text-link" type="button" data-action="identity">查看主体身份疑点 ↗</button></div></div></div>`);
}
function renderIdentity() {
  setDialog('招募主体身份 · 待补证','OPEN QUESTION / 02',`<div class="identity-review"><span class="chapter-chip">这条关系，还缺一份证明。</span><h3>公告中的组织，与收款账户是什么关系？</h3><div class="comparison-pair">${['E-01','E-04'].map(id=>{const e=evidence(id);return `<article class="comparison-paper"><div><span>${id}</span>${sourceButton(id,'翻阅原文')}</div><h3>${e.title}</h3><p>${e.summary}</p></article>`}).join('')}</div><div class="unresolved-note"><strong>现有证据能支持的内容</strong><p>公告中出现“星跃工作室”，群聊中指定“王某的账户”。二者之间的授权、雇佣或委托关系，现有材料没有证明。</p></div><h4>下一步补证清单</h4><div class="identity-checklist">${['核对退款流水与实际到账时间','补充招募主体及账户授权证明','向其他报名者收集完整证言'].map((text,i)=>`<label><input type="checkbox" data-check="${i}" ${state.checks.includes(i)?'checked':''}/><span>${text}</span></label>`).join('')}</div><p class="small-explanation">勾选用于记录调查安排，不会自动把疑点标为已证实。</p><button class="room-button" type="button" data-action="notebook">把观察记进笔记 →</button></div>`);
}
function renderUnlock() {
  const allowed=state.stage>=1;
  setDialog('一份新的补充材料','NEW EVIDENCE / E-05',`<div class="unlock-scene"><div class="sealed-folder ${allowed?'can-open':''}"><span>SUPPLEMENTARY FILE</span><div>${icon('file')}</div><h3>支付平台退款回单</h3><p>E-05 / 完整交易明细</p><b>${state.extra?'已加入档案':allowed?'待开启':'待核查'}</b></div><div class="unlock-copy"><span class="room-kicker">FOLLOW THE EVIDENCE</span><h3>${state.extra?'回单已经在你的档案里。':allowed?'新的细节，可能改变你的判断。':'先把现有证据核对清楚。'}</h3><p>${allowed?'这份完整回单包含交易单号、退款项目和实际到账时间。打开后，看看它能否补上刚才缺失的那一环。':'先翻阅 E-02、E-03，摘录两条时间线索，并在对照台记录阶段判断。之后即可开启补充回单。'}</p><button class="room-button primary" type="button" data-action="${state.extra?'evidence':allowed?'add-extra':'next'}" ${state.extra?'data-id="E-05"':''}>${state.extra?'翻阅 E-05 原文':allowed?'拆封并加入证据墙':'继续现有调查'} →</button><small>演示材料已预设，用于体验补证后的复核流程。</small></div></div>`);
}
function renderIntro() {
  setDialog('欢迎来到现实档案调查局','FIELD GUIDE / CASE 2026-001',`<div class="case-intro"><span class="chapter-chip">模拟调查 · 约 3—5 分钟</span><h3>500 元押金，到底是什么时候退的？</h3><p>张同学参加了一场校园兼职。联系人称周五已退还押金，但张同学拿到的凭证显示完成时间是周六。你需要沿着材料查清这处差异，并保留尚未解决的问题。</p><div class="intro-steps"><article><span>01</span><h4>翻阅档案</h4><p>点证据卡，看完整聊天、公告与交易凭证。</p></article><article><span>02</span><h4>摘录与对照</h4><p>把关键句放入线索簿，用证据限定判断。</p></article><article><span>03</span><h4>补证与复核</h4><p>开启新回单，核对交易对应关系并记录结果。</p></article></div><div class="guide-controls"><span>拖动空白处平移画布；拖动卡片整理布局；双击空白处适应画布。</span><span>Esc 关闭档案 · 线索簿自动保存 · 可导出调查笔记</span></div><div class="dialog-actions"><button class="room-button" type="button" data-action="close">先看看证据墙</button><button class="room-button primary" type="button" data-action="next">开始调查 →</button></div></div>`);
}
function renderUpload() {
  setDialog('把新的材料放进档案','LOCAL EVIDENCE / 本地材料',`<div class="upload-room"><label class="upload-dropzone" id="uploadDropzone">${icon('folder')}<strong>把截图、PDF 或文本拖到这里</strong><span>也可以点击选择文件 · 单个文件不超过 15 MB</span><input id="uploadFiles" type="file" accept="image/*,.pdf,.txt,.md" multiple/></label><div class="upload-queue">${uploadQueue.map(f=>`<div>${icon('file')}<span>${esc(f.name)}</span><small>${(f.size/1024).toFixed(0)} KB</small></div>`).join('')||'<p>等待加入材料…</p>'}</div><p class="small-explanation">文件仅在当前页面本地预览，不会发送到服务器。当前版本不自动解析、联网分析或生成新结论；刷新页面后需重新选择文件。</p><button class="room-button primary" type="button" data-action="import-files" ${uploadQueue.length?'':'disabled'}>加入证据档案 →</button></div>`);
  $('#uploadFiles').addEventListener('change',e=>queueFiles(e.target.files));
  const zone=$('#uploadDropzone');
  zone.addEventListener('dragover',e=>{e.preventDefault();zone.classList.add('drag-over')});
  zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
  zone.addEventListener('drop',e=>{e.preventDefault();queueFiles(e.dataTransfer.files)});
}
function renderDialog() {
  switch(activeDialog?.type){
    case 'dossier':renderDossier(activeDialog.id);break;
    case 'compare':renderCompare();break;
    case 'notebook':renderNotebook();break;
    case 'person':renderPerson(activeDialog.id);break;
    case 'identity':renderIdentity();break;
    case 'unlock':renderUnlock();break;
    case 'upload':renderUpload();break;
    case 'intro':renderIntro();break;
    case 'reset':setDialog('重新开始这次调查？','RESTART DEMO',`<div class="reset-room"><h3>清空这起演示案件的本地进度。</h3><p>已摘录线索、判断、笔记、卡片位置和本次加入的本地预览文件都会重置。原始文件不会被改动。</p><div class="dialog-actions"><button class="room-button" type="button" data-action="notebook">保留，返回笔记</button><button class="room-button primary" type="button" data-action="confirm-reset">重新调查</button></div></div>`);break;
  }
}
function continueInvestigation() {
  if(!state.clues.includes('C-02'))openEvidence('E-02');
  else if(!state.clues.includes('C-03'))openEvidence('E-03');
  else if(state.stage===0)openDialog('compare');
  else if(!state.extra)openDialog('unlock');
  else if(!state.clues.includes('C-05'))openEvidence('E-05');
  else if(state.stage===1)openDialog('compare');
  else openDialog('notebook');
}
async function runAction(action,id) {
  switch(action){
    case 'case-home':entry.showHome();break;
    case 'quick-hint':case 'assistant':{
      if(currentView==='center')centerNext();else{const cue=assistantCue();runAction(cue.action,cue.id)}break;
    }
    case 'focus-finding':focusFinding(id);break;
    case 'clear-focus':clearFindingFocus();fitBoard(true);break;
    case 'center-read':selectCenter('evidence','E-02');break;
    case 'center-review':$('.center-review')?.scrollIntoView({behavior:'smooth',block:'nearest'});break;
    case 'center-next':centerNext();break;
    case 'center-supplement':centerSupplement();break;
    case 'center-hint':$('.center-guide')?.scrollIntoView({behavior:'smooth',block:'nearest'});break;
    case 'close':closeDialog();break;
    case 'evidence':openEvidence(id);break;
    case 'person':openDialog('person',id);break;
    case 'compare':case 'notebook':case 'identity':case 'intro':case 'unlock':case 'reset':openDialog(action);break;
    case 'upload':uploadQueue=[];openDialog('upload');break;
    case 'next':continueInvestigation();break;
    case 'collect':{
      const c=claim(id);if(!c||!evidence(c.sourceId)||state.clues.includes(id))return;
      if(!state.read.includes(c.sourceId))state.read.push(c.sourceId);
      state.clues.push(id);save();renderMain();renderDialog();toast(`线索 ${id} 已收入线索簿 · 来源 ${c.sourceId}`);break;
    }
    case 'add-extra':if(state.stage<1)return;state.extra=true;save();renderMain();openEvidence('E-05');toast('新证据 E-05 已加入证据墙，时间线同步更新');break;
    case 'export':{
      const url=URL.createObjectURL(new Blob([buildReport(state)],{type:'text/markdown;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download='TruthTrace-调查笔记.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('调查笔记已导出，保留来源编号与待核实事项');break;
    }
    case 'confirm-reset':uploadedEvidence.forEach(e=>URL.revokeObjectURL(e.url));uploadedEvidence=[];uploadQueue=[];state=createState();save();location.reload();break;
    case 'import-files':await importFiles();break;
  }
}
listen(document,'click',event=>{
  const selection=event.target.closest('[data-center-type]');
  if(selection){selectCenter(selection.dataset.centerType,selection.dataset.centerId);return}
  const filter=event.target.closest('[data-center-filter]');
  if(filter){centerFilter=filter.dataset.centerFilter;$$('[data-center-filter]').forEach(b=>{b.classList.toggle('active',b===filter);b.setAttribute('aria-pressed',String(b===filter))});filterCenterCatalog();return}
  const action=event.target.closest('[data-action]');if(action&&!action.disabled)runAction(action.dataset.action,action.dataset.id);
});
listen(document,'submit',event=>{
  if(event.target.id==='centerQueryForm'){
    event.preventDefault();centerQuery=String(new FormData(event.target).get('query')||'');renderCenterQuery();return;
  }
  if(!['verdictForm','centerVerdictForm'].includes(event.target.id))return;event.preventDefault();
  const inCenter=event.target.id==='centerVerdictForm';
  const feedback=$(inCenter?'#centerVerdictFeedback':'#verdictFeedback');
  const choice=new FormData(event.target).get('verdict');
  if(!choice){feedback.textContent='先选择一个判断，再记录。';return}
  const result=assessVerdict(state,choice);
  if(!result.ok){feedback.textContent=result.message;feedback.classList.add('needs-attention');return}
  state.stage=result.stage;save();renderMain();renderDialog();toast(result.message);
  if(inCenter)$('#centerReviewTitle')?.focus({preventScroll:true});
});
listen(document,'input',event=>{
  if(event.target.id==='centerCatalogSearch'){centerCatalogQuery=event.target.value;filterCenterCatalog()}
  if(event.target.id==='personalNote'){state.note=event.target.value;save()}
  if(event.target.matches('.archive-search')){const q=event.target.value.trim().toLowerCase();$$('#alternateView .archive-card').forEach(card=>card.hidden=!card.dataset.search.toLowerCase().includes(q))}
});
listen(document,'change',event=>{
  if(!event.target.matches('[data-check]'))return;const index=Number(event.target.dataset.check);state.checks=state.checks.filter(i=>i!==index);if(event.target.checked)state.checks.push(index);save();
});
$('.dialog-close').addEventListener('click',closeDialog);
dialog.addEventListener('click',event=>{if(event.target===dialog)closeDialog()});
dialog.addEventListener('close',()=>activeDialog=null);
function queueFiles(files){const {accepted,rejected}=validateFiles(files);if(!accepted.length){toast(rejected.join('；')||'请选择图片、PDF 或文本文件');return}uploadQueue=accepted;renderUpload();if(rejected.length)toast(rejected.join('；'))}
async function importFiles(){
  const button=$('[data-action="import-files"]');button.disabled=true;button.textContent='正在加入…';
  for(const file of uploadQueue){
    const id=`U-${count(uploadedEvidence.length+1)}`,kind=file.type.startsWith('image/')?'image':/\.pdf$/i.test(file.name)?'pdf':'text';
    uploadedEvidence.push({id,title:file.name,kind,date:'本次加入',subtitle:'本地材料 · 未分析',summary:'当前页面本地预览，尚未进行内容提取或证据关联。',upload:true,url:URL.createObjectURL(file),text:kind==='text'?(await file.text()).slice(0,40000):'',claims:[]});
  }
  uploadQueue=[];renderMain();closeDialog();showView('evidence');toast('材料已加入本地档案；尚未进行 AI 分析');
}

// Card dragging and panning share one coordinate system with the red threads.
function nodeKey(node){return [...node.classList].find(c=>/^node-(location|poster|chat|student|contact|peers|wang|receipt|group|supplement)$/.test(c))||'central-node'}
function openNode(node){const id=nodeKey(node);if(nodeSources[id])openEvidence(nodeSources[id]);else if(nodePeople[id])openDialog('person',nodePeople[id])}
function bindNode(node){
  node.setAttribute('role','button');node.setAttribute('aria-label',`打开${node.querySelector('h3').textContent}档案`);
  node.addEventListener('click',e=>{if(e.detail===0)openNode(node)});
  node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openNode(node)}});
}
function fitBoard(reset=false){
  if(reset){clearFindingFocus();zoom=1;pan={x:0,y:0}}
  const width=viewport.clientWidth,height=viewport.clientHeight;
  if(!width||!height)return;
  baseScale=Math.min((width-26)/1100,(height-16)/600);
  if(activeFinding){
    const nodes=$$('.node-focused'),padding=36;
    const left=Math.min(...nodes.map(n=>n.offsetLeft))-padding,right=Math.max(...nodes.map(n=>n.offsetLeft+n.offsetWidth))+padding;
    const top=Math.min(...nodes.map(n=>n.offsetTop))-padding,bottom=Math.max(...nodes.map(n=>n.offsetTop+n.offsetHeight))+padding;
    const scale=Math.min((width-24)/(right-left),(height-24)/(bottom-top),baseScale*1.8);
    zoom=scale/baseScale;pan={x:(550-(left+right)/2)*scale,y:(300-(top+bottom)/2)*scale};
  }
  const scale=baseScale*zoom;
  world.style.transform=`translate(${(width-1100*scale)/2+pan.x}px, ${(height-600*scale)/2+pan.y}px) scale(${scale})`;
  $('#zoomLabel').textContent=`${Math.round(zoom*100)}%`;
}
function clearFindingFocus(){
  activeFinding=null;world.classList.remove('has-finding-focus');$('#graphFocusBar').hidden=true;
  $$('.node-focused,.thread-focused,.finding-selected').forEach(el=>el.classList.remove('node-focused','thread-focused','finding-selected'));
  $$('.finding-paper').forEach(el=>el.setAttribute('aria-pressed','false'));
}
function focusFinding(id){
  const finding=graphFindings[id];if(!finding)return;
  const ids=id==='time'&&state.extra?[...finding.ids,'E-05']:finding.ids;
  if(currentView!=='graph')showView('graph');
  clearFindingFocus();activeFinding=id;
  $$('.evidence-node').forEach(node=>node.classList.toggle('node-focused',ids.includes(nodeSources[nodeKey(node)])));
  world.classList.add('has-finding-focus');
  const card=$(`.finding-paper[data-id="${id}"]`);card.classList.add('finding-selected');card.setAttribute('aria-pressed','true');
  $('#focusEvidenceIds').textContent=`已定位 ${ids.join(' / ')}`;
  $('#focusFindingTitle').textContent=id==='time'?$('.finding-paper h3').textContent:finding.title;
  $('#focusDetailButton').dataset.action=finding.action;$('#focusDetailButton').textContent=finding.detail;
  $('#graphFocusBar').hidden=false;updateThreads();fitBoard();
  if(!layout.classList.contains('graph-presenting'))wall.scrollIntoView({behavior:'smooth',block:'center'});
}
function updateThreads(){
  if(currentView!=='graph')return;
  const center=$('.central-node'),a={x:center.offsetLeft+center.offsetWidth/2,y:center.offsetTop+center.offsetHeight/2};
  const classes=['node-location','node-poster','node-chat','node-student','node-contact','node-peers','node-receipt'];
  const red=[...$('.red-threads').querySelectorAll('path:not(.supplement-thread)')];
  classes.forEach((cls,i)=>{const n=$('.'+cls),x=n.offsetLeft+n.offsetWidth/2,y=n.offsetTop+n.offsetHeight/2;red[i].setAttribute('d',`M${x} ${y} L${a.x} ${a.y}`);red[i].classList.toggle('thread-focused',n.classList.contains('node-focused'))});
  ['node-group','node-wang'].forEach((cls,i)=>{const n=$('.'+cls),x=n.offsetLeft+n.offsetWidth/2,y=n.offsetTop+n.offsetHeight/2;const line=$('.uncertain-threads').children[i];line.setAttribute('d',i===0?`M${a.x} ${a.y} Q${a.x+60} ${y+30} ${x} ${y}`:`M${a.x} ${a.y} L${x} ${y}`);line.classList.toggle('thread-focused',n.classList.contains('node-focused'))});
  const extra=$('.node-supplement');if(extra){$('.supplement-thread').setAttribute('d',`M${a.x} ${a.y} L${extra.offsetLeft+extra.offsetWidth/2} ${extra.offsetTop+extra.offsetHeight/2}`);$('.supplement-thread').classList.toggle('thread-focused',extra.classList.contains('node-focused'))}
  if(Object.keys(state.positions).length||drag?.moved){
    [['label-recruit','node-location',-22],['label-refund','node-chat',-22],['label-deposit','node-student',22],['label-money','node-receipt',16],['label-unsure','node-wang',12]].forEach(([labelClass,targetClass,dy])=>{
      const label=$('.'+labelClass),target=$('.'+targetClass);
      label.style.left=`${(a.x+target.offsetLeft+target.offsetWidth/2)/2-label.offsetWidth/2}px`;
      label.style.top=`${(a.y+target.offsetTop+target.offsetHeight/2)/2-label.offsetHeight/2+dy}px`;
    });
  }
  if(state.extra){
    $('.label-refund').style.left='700px';
    $('.label-refund').style.top='115px';
  }
}
viewport.addEventListener('pointerdown',event=>{
  if(currentView!=='graph'||event.button!==0||!event.isPrimary)return;
  const node=event.target.closest('.evidence-node');
  if(!node)clearFindingFocus();
  drag={node,startX:event.clientX,startY:event.clientY,x:node?node.offsetLeft:pan.x,y:node?node.offsetTop:pan.y,moved:false};
  viewport.setPointerCapture(event.pointerId);event.preventDefault();
});
viewport.addEventListener('pointermove',event=>{
  if(!drag)return;const dx=event.clientX-drag.startX,dy=event.clientY-drag.startY;
  if(Math.hypot(dx,dy)<5&&!drag.moved)return;drag.moved=true;viewport.classList.add('canvas-dragging');
  if(drag.node){
    const scale=baseScale*zoom,x=Math.max(0,Math.min(1100-drag.node.offsetWidth,drag.x+dx/scale)),y=Math.max(8,Math.min(600-drag.node.offsetHeight,drag.y+dy/scale));
    drag.node.style.left=`${x}px`;drag.node.style.top=`${y}px`;updateThreads();
  }else{pan={x:drag.x+dx,y:drag.y+dy};fitBoard()}
});
viewport.addEventListener('pointerup',()=>{
  if(!drag)return;
  if(drag.node&&drag.moved){state.positions[nodeKey(drag.node)]={x:drag.node.offsetLeft,y:drag.node.offsetTop};save()}
  else if(drag.node)openNode(drag.node);
  drag=null;viewport.classList.remove('canvas-dragging');
});
viewport.addEventListener('pointercancel',()=>{drag=null;viewport.classList.remove('canvas-dragging')});
viewport.addEventListener('dblclick',event=>{if(!event.target.closest('.evidence-node'))fitBoard(true)});
$('#zoomIn').addEventListener('click',()=>{clearFindingFocus();zoom=Math.min(2.4,zoom+.15);fitBoard()});
$('#zoomOut').addEventListener('click',()=>{clearFindingFocus();zoom=Math.max(.6,zoom-.15);fitBoard()});
$('#resetZoom').addEventListener('click',()=>fitBoard(true));$('#fitButton').addEventListener('click',()=>fitBoard(true));
function toggleCenterPresentation(force) {
  const active=typeof force==='boolean'?wall.classList.toggle('center-presenting',force):wall.classList.toggle('center-presenting');
  document.body.classList.toggle('presenting-center',active);
  updatePresentationButton();
}
function updatePresentationButton(){
  const center=currentView==='center',active=center?wall.classList.contains('center-presenting'):layout.classList.contains('graph-presenting');
  const label=active?(center?'退出展示':'退出全屏'):(center?'全屏展示':'沉浸全屏');
  $('#fullscreenButton').setAttribute('aria-label',`${label}${center?'调查中心':'关系图'}`);
  $('#fullscreenButton').setAttribute('aria-pressed',String(active));$('#fullscreenButton').title=label;
  $('.center-presentation-label').textContent=label;
}
async function toggleGraphPresentation(force){
  const active=typeof force==='boolean'?force:!layout.classList.contains('graph-presenting');
  if(active)presentationReturnFocus=document.activeElement;
  layout.classList.toggle('graph-presenting',active);document.body.classList.toggle('presenting-graph',active);
  document.querySelectorAll('.sidebar,.topbar,.case-hero,.case-stats,.page-footer').forEach(el=>el.inert=active);
  updatePresentationButton();fitBoard();
  if(active){
    $('#fullscreenButton').focus({preventScroll:true});
    if(document.fullscreenEnabled){try{await layout.requestFullscreen();nativeGraphFullscreen=true}catch{/* The immersive page remains usable when native fullscreen is unavailable. */}}
  }else{
    nativeGraphFullscreen=false;
    if(document.fullscreenElement===layout)await document.exitFullscreen();
    presentationReturnFocus?.focus({preventScroll:true});
  }
}
$('#fullscreenButton').addEventListener('click',async()=>{
  if(currentView==='center'){toggleCenterPresentation();return}
  if(currentView==='graph'){await toggleGraphPresentation();return}
  showView('graph');await toggleGraphPresentation(true);
});
listen(document,'keydown',event=>{
  if(event.key!=='Escape'||dialog.open)return;
  if(wall.classList.contains('center-presenting'))toggleCenterPresentation(false);
  else if(layout.classList.contains('graph-presenting'))toggleGraphPresentation(false);
  else if(activeFinding){clearFindingFocus();fitBoard(true)}
});
listen(document,'fullscreenchange',()=>{
  if(nativeGraphFullscreen&&document.fullscreenElement!==layout)toggleGraphPresentation(false);
  fitBoard();
});
const observer=new ResizeObserver(()=>fitBoard());observer.observe(viewport);
const cat=$('.detective-cat');
function petDetective(){
  clearTimeout(catTimer);cat.classList.remove('petting');void cat.offsetWidth;cat.classList.add('petting');
  catTimer=setTimeout(()=>cat.classList.remove('petting'),1800);
}
cat.addEventListener('pointerenter',petDetective);cat.addEventListener('click',petDetective);

// Connect the approved main-page elements to case-specific actions.
$$('[data-preview]').forEach(el=>el.removeAttribute('data-preview'));
$$('.evidence-node').forEach(bindNode);
$$('.nav-item').forEach((b,i)=>b.addEventListener('click',()=>showView(['center','graph','timeline','evidence','people','tasks'][i],i)));
$$('.view-tabs button').forEach((b,i)=>b.addEventListener('click',()=>showView(['graph','timeline','evidence'][i])));
$('.case-selector').dataset.action='case-home';$('.round-button[aria-label="使用帮助"]').dataset.action='intro';$('.notification').dataset.action='notebook';
$$('.hero-actions button')[0].dataset.action='unlock';$$('.hero-actions button')[1].dataset.action='upload';
$$('.finding-paper').forEach((el,i)=>{el.setAttribute('role','button');el.setAttribute('aria-pressed','false');el.dataset.action='focus-finding';el.dataset.id=i?'identity':'time';el.querySelector('.finding-sources>span').firstChild.textContent='定位证据 ';el.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();el.click()}})});
const notebookButton=document.createElement('button');notebookButton.type='button';notebookButton.className='notebook-toolbar-button';notebookButton.dataset.action='notebook';
notebookButton.innerHTML=`${icon('note')}<span>线索簿</span><b id="clueCount">0</b>`;
$('.wall-header-actions').insertBefore(notebookButton,$('#fullscreenButton'));
const presentationLabel=document.createElement('span');presentationLabel.className='center-presentation-label';presentationLabel.textContent='全屏展示';$('#fullscreenButton').append(presentationLabel);
renderMain();fitBoard(true);
const initialView=location.hash.slice(1);
const entry=initEntryFlow({root,signal,asset,onContext:bridge.onContext,onAnalyzeFiles:bridge.analyzeFiles,onAnalysisReady:bridge.onAnalysisReady,onDemoReady:(caseName,fresh)=>{
  bridge.onContext?.({caseName: caseName + "（虚构示例）", evidence:EVIDENCE.filter(e=>!e.extra).map(e=>({id:"sample-"+e.id,name:e.title,kind:"text",mimeType:"text/plain",source:"虚构示例",content:[e.subtitle,...(e.lines||[]),...(e.messages||[]).map(m=>m.time+" "+m.speaker+"："+m.text),...(e.fields||[]).map(([k,v])=>k+"："+v)].join("\n")}))});
  if(fresh){
    state=createState();uploadedEvidence.forEach(e=>URL.revokeObjectURL(e.url));uploadedEvidence=[];save();
    centerSelection={type:'evidence',id:'E-02'};centerCatalogQuery='';centerFilter='all';centerQuery='';centerRenderedKey='';
    $('.node-supplement')?.remove();$('.supplement-thread')?.remove();
    $$('.evidence-node,.thread-label').forEach(node=>{node.style.removeProperty('left');node.style.removeProperty('top')});
  }
  $$('.hero-title h1,.breadcrumb>strong,.case-selector strong,.immersive-context strong').forEach(el=>el.textContent=caseName);
  $('.hero-description').textContent='示例案件 · 从原始材料核对退款时间与主体关系。';
  renderMain();showView('graph');fitBoard(true);
}});
if(Object.hasOwn(viewNames,initialView)||initialView==='graph-demo'){
  entry.hide();showView(initialView==='graph-demo'?'graph':initialView);
  if(initialView==='graph-demo')toggleGraphPresentation(true);
}else if(initialView==='new')entry.startNew();else entry.showHome();

return ()=>{abort.abort();observer.disconnect();entry.dispose();clearTimeout(toastTimer);clearTimeout(catTimer);uploadedEvidence.forEach(item=>URL.revokeObjectURL(item.url));if(dialog.open)dialog.close();document.body.className=bodyClasses;root.replaceChildren()};
}
