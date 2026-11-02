import { EVIDENCE, PEOPLE, TIMELINE, CLAIMS } from './case-data.mjs';
import { createState, normalizeState, buildReport } from './investigation.mjs';
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
let centerSelection={type:'evidence',id:'E-02'}, centerCatalogQuery='', centerFilter='all', centerQuery='';
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
function publishDemoContext(caseName=$('.hero-title h1').textContent){ bridge.onContext?.({caseId:'demo-case',caseName: caseName + "（虚构示例）", evidence:EVIDENCE.filter(e=>!e.extra||state.extra).map(e=>({id:"sample-"+e.id,name:e.title,kind:"text",mimeType:"text/plain",source:"虚构示例",content:[e.subtitle,...(e.lines||[]),...(e.messages||[]).map(m=>m.time+" "+m.speaker+"："+m.text),...(e.fields||[]).map(([k,v])=>k+"："+v)].join("\n")}))}); }
function save() { try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Remain usable without browser storage. */ } }
function available() { return [...EVIDENCE.filter(e=>!e.extra||state.extra), ...uploadedEvidence]; }
function evidence(id) { return available().find(e=>e.id===id); }
function claim(id) { return CLAIMS.find(c=>c.id===id); }




function count(n) { return String(n).padStart(2,'0'); }
function toast(message) {
  $('#previewToast').textContent=message; $('#previewToast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#previewToast').classList.remove('visible'),3200);
}
function sourceButton(id, label=id) { return `<button type="button" class="source-chip" data-action="evidence" data-id="${id}">${esc(label)} ↗</button>`; }
const viewNames={center:'材料核查',graph:'线索关系图',timeline:'事件时间线',evidence:'证据档案',people:'人物档案',tasks:'补证建议'};
function showView(view) {
  if(view!=='center'&&wall.classList.contains('center-presenting'))toggleCenterPresentation(false);
  if(!['graph','timeline','evidence'].includes(view)&&layout.classList.contains('graph-presenting'))toggleGraphPresentation(false);
  if(view!=='graph'){clearFindingFocus();zoom=1;pan={x:0,y:0}}
  layout.dataset.view=view;
  currentView=view; $('#wallTitle').textContent=['graph','timeline','evidence'].includes(view)?'调查工作台':viewNames[view];
  $('.view-tabs').hidden=!['graph','timeline','evidence'].includes(view);
  $('.canvas-controls').hidden=view!=='graph';
  $('.board-caption').hidden=view!=='graph';
  $('.detective-cat').hidden=view!=='graph';
  $('.investigation-layout').classList.toggle('center-mode',view==='center');
  viewport.classList.toggle('center-viewport',view==='center');
  $$('.hero-actions button')[0].dataset.action=view==='center'?'center-supplement':'unlock';

  updatePresentationButton();
  world.hidden=view!=='graph'; $('#alternateView').hidden=view==='graph'; viewport.classList.toggle('reading-view',view!=='graph');
  $$('.view-tabs button').forEach((b,i)=>{const selected=['graph','timeline','evidence'][i]===view;b.classList.toggle('selected',selected);b.setAttribute('aria-pressed',String(selected))});
  const moduleView=['graph','timeline','evidence'].includes(view)?'graph':view;
  $$('.nav-item').forEach(b=>{const selected=b.dataset.view===moduleView;b.classList.toggle('active',selected);if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  renderAlternate(); if(view==='graph'){fitBoard();updateThreads()}
  history.replaceState(null,'',`#${view}`);
}
function tasks() {
  return [
    {title:'核对退款单号与到账时间',detail:'完整回单用于确认是否为同一笔押金。',action:state.extra?'compare':'unlock'},
    {title:'补充主体与账户授权证明',detail:'现有材料尚不能证明招募方与收款账户的关系。',action:'identity'}
  ];
}

function renderTasks(compact=false) {
  return tasks().map(t=>`<button type="button" class="mission-step" data-action="${t.action}"><span><strong>${t.title}</strong>${compact?'':`<small>${t.detail}</small>`}</span><span class="mission-end">查看 →</span></button>`).join('');
}

function renderMain() {
  const items=available();
  state.clues=CLAIMS.filter(c=>items.some(e=>e.id===c.sourceId)).map(c=>c.id);
  $('#immersiveSummary').textContent='虚构示例 · 原始材料可追溯';
  $('.case-badge').textContent='待核实';
  $('.sync-status').innerHTML='<i></i>虚构示例';
  $('.recent-evidence').innerHTML=`<div class="sidebar-heading">最近证据 <span>${count(items.length)}</span></div>`+items.slice().reverse().slice(0,5).map(e=>`<button class="recent-file" type="button" data-action="evidence" data-id="${e.id}"><span class="file-icon">${icon('file')}</span><span><strong>${esc(e.title)}</strong><small>${e.id} · ${e.date}${state.read.includes(e.id)?' · 已阅':''}</small></span></button>`).join('');
  $('#clueCount').textContent=state.clues.length;
  const finding=$('.finding-paper');
  finding.querySelector('h3').textContent='退款时间待核实';
  finding.querySelector('.finding-status').textContent='待核实';
  finding.querySelector('p').textContent='E-02 的退款说法与 E-03 的到账日期不同。';
  finding.querySelector('.finding-sources b').textContent=state.extra?'E-02 · E-03 · E-05':'E-02 · E-03';
  $('.next-panel .panel-heading h2').textContent='待补材料';$('.next-panel .panel-heading>span').textContent='02';
  $('.next-paper').innerHTML=renderTasks(true);
  $('.verification-note').innerHTML=`<button type="button" class="text-link" data-action="export">导出调查报告 ↓</button>`;
  $('.case-index span:last-child').textContent='虚构案件 · 可交互演示';
  if(state.extra&&!$('.node-supplement')) {
    const node=document.createElement('article');node.className='evidence-node node-supplement';node.tabIndex=0;
    node.innerHTML=`<span class="pin"></span><span class="supplement-symbol">${icon('file')}</span><span class="node-category">E-05 / 新补证</span><h3>完整退款回单</h3><small>点击翻阅 ↗</small>`;
    world.append(node);bindNode(node);
    const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.classList.add('supplement-thread');$('.red-threads').append(line);
  }
  $$('.evidence-node').forEach(node=>{
    const id=nodeSources[nodeKey(node)];node.classList.toggle('node-read',!!id&&state.read.includes(id));
    const position=state.positions[nodeKey(node)];
    if(position){node.style.left=`${Math.min(position.x,1100-node.offsetWidth)}px`;node.style.top=`${Math.min(position.y,600-node.offsetHeight)}px`}
  });
  updateThreads(); if(currentView!=='graph')renderAlternate();
}
function evidenceCard(e) {
  return `<button type="button" class="archive-card" data-action="evidence" data-id="${e.id}" data-search="${esc(e.title+' '+e.summary)}"><span class="archive-card-top"><span>${e.id}</span><small>${state.read.includes(e.id)?'✓ 已阅':'未读'}</small></span><span class="archive-card-icon">${icon(e.kind==='chat'?'note':'file')}</span><strong>${esc(e.title)}</strong><p>${esc(e.summary)}</p><span class="archive-card-bottom">${e.date}<span>翻阅档案 ↗</span></span></button>`;
}
function renderAlternate() {
  const host=$('#alternateView');if(currentView==='graph')return;
  if(currentView==='center'){renderCenter();return}
  if(currentView==='evidence')host.innerHTML=`<div class="reading-view-header"><div><h3>证据档案</h3></div><input class="archive-search" type="search" placeholder="搜索证据名称或内容" aria-label="搜索证据档案"/></div><div class="archive-grid">${available().map(evidenceCard).join('')}</div>`;
  else if(currentView==='timeline')host.innerHTML=`<div class="reading-view-header"><div><h3>事件时间线</h3></div></div><div class="chronology">${TIMELINE.filter(t=>!t.extra).map(t=>`<button type="button" class="chronology-item ${t.warning?'warning':''}" data-action="evidence" data-id="${t.evidence}"><span class="chronology-time"><b>${t.date}</b><small>${t.time}</small></span><span class="chronology-dot"></span><span class="chronology-paper"><span>${t.type} / ${t.evidence}</span><strong>${t.title}</strong><p>${t.text}</p><small>查看原文 ↗</small></span></button>${state.extra&&t.evidence==='E-03'?sourceButton('E-05','补充回单 E-05'):''}`).join('')}</div>`;
  else if(currentView==='people')host.innerHTML=`<div class="reading-view-header"><div><h3>人物与组织</h3></div></div><div class="people-grid">${PEOPLE.map(p=>`<button class="person-card" type="button" data-action="person" data-id="${p.id}"><img src="${asset(p.image)}" alt="虚构${esc(p.name)}示意" style="object-position:${p.position}"/><span><small>${p.role}</small><strong>${p.name}</strong><p>${p.description}</p><em>打开人物档案 ↗</em></span></button>`).join('')}</div>`;
  else host.innerHTML=`<div class="reading-view-header"><div><h3>补证建议</h3></div><button class="room-button" type="button" data-action="notebook">打开线索簿 ${icon('note')}</button></div><div class="task-page">${renderTasks()}<div class="unresolved-note"><strong>仍待核实：招募主体身份</strong><p>收款账户与“星跃工作室”的关系缺少证明。查看材料，记录下一步补证方向。</p><button type="button" class="text-link" data-action="identity">查看这一疑点 ↗</button></div></div>`;
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
  return `<div class="center-material-head"><div><span>${e.id} / ${e.date}</span><h3>${esc(e.title)}</h3></div><button class="center-original-button" type="button" data-action="evidence" data-id="${e.id}">完整原文 ↗</button></div>${e.messages?'':`<p class="center-material-summary">${esc(e.summary)}</p>`}${excerpt}${(e.claims||[]).map(c=>`<div class="center-extract-row"><span><small>提取信息 · 来源 ${e.id}</small><strong>${c.label}</strong></span></div>`).join('')}`;
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
  $('#alternateView').innerHTML=`<div class="center-shell"><div class="center-columns"><aside class="center-catalog"><div class="center-panel-heading"><h3>材料与主体</h3><span id="catalogVisible">${centerRecords().length}</span></div><input id="centerCatalogSearch" type="search" placeholder="搜索材料、人物…" aria-label="搜索调查线索" value="${esc(centerCatalogQuery)}"/><div class="center-catalog-filters">${[['all','全部'],['evidence','材料'],['person','人物与组织']].map(([value,label])=>`<button type="button" data-center-filter="${value}" class="${centerFilter===value?'active':''}">${label}</button>`).join('')}</div><div class="center-catalog-list">${centerCatalog()}<p id="catalogEmpty" hidden>没有匹配材料。</p></div></aside><div class="center-main"><section class="center-material-section"><div class="center-material-paper">${centerMaterial()}</div></section></div><aside class="center-right"><section class="center-query"><div class="center-panel-heading"><h3>查找关联记录</h3></div><form id="centerQueryForm"><input type="search" name="query" aria-label="检索案件关联记录" placeholder="单号、姓名或关键词" value="${esc(centerQuery)}"/><button type="submit" aria-label="检索关联记录">${icon('chevron')}</button></form><div class="center-results-heading">匹配材料 <span id="centerResultCount">0</span></div><div id="centerQueryResults"></div></section></aside></div></div>`;
  filterCenterCatalog();renderCenterQuery();
}



function centerSupplement() {
  if(!state.extra){state.extra=true;save();renderMain()}
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
  const items=available(),index=items.findIndex(item=>item.id===id);
  setDialog(e.title,`原始材料 / ${e.id}`,`<section class="document-viewer"><div class="document-sheet">${paperContent(e)}</div><footer class="document-viewer-footer"><button type="button" class="text-link" data-action="evidence" data-id="${items[Math.max(0,index-1)].id}" ${index===0?'disabled':''}>← 上一份</button><span>${e.id} · ${index+1} / ${items.length}</span><button type="button" class="text-link" data-action="evidence" data-id="${items[Math.min(items.length-1,index+1)].id}" ${index===items.length-1?'disabled':''}>下一份 →</button></footer></section>`);
}

function renderCompare() {
  const ids=state.extra?['C-02','C-03','C-05']:['C-02','C-03'];
  setDialog('退款时间待核实','证据对照',`<div class="compare-workbench"><p>聊天中的退款说法与凭证日期不同。核对交易单号，确认是否对应同一笔押金。</p><div class="comparison-pair">${ids.map(id=>{const c=claim(id);return `<article class="comparison-paper"><div>${sourceButton(c.sourceId,'查看完整原文')}</div><h3>${c.label}</h3><blockquote>“${c.quote}”</blockquote></article>`}).join('')}</div>${state.extra?'<p>示例回单的单号与 E-03 一致，记载到账时间为 10月31日 17:35。延迟原因仍待核实。</p>':'<button class="room-button" type="button" data-action="unlock">补充完整回单 →</button>'}<button class="room-button" type="button" data-action="notebook">添加核查备注</button></div>`);
}

function renderNotebook() {
  setDialog('核查备注','本次示例案件',`<div class="notebook-page"><label class="personal-note-label" for="personalNote">我的观察</label><textarea id="personalNote" placeholder="记录识别有误或尚未确认的内容…" maxlength="8000">${esc(state.note)}</textarea><p>自动保存于此浏览器，随报告导出。</p><button class="room-button" type="button" data-action="export">导出调查报告 ↓</button></div>`);
}

function renderPerson(id) {
  const p=PEOPLE.find(item=>item.id===id);
  const sources=p.evidence.filter(id=>evidence(id)).map(id=>{const e=evidence(id);return `<button class="person-source" type="button" data-action="evidence" data-id="${id}"><span>${id}</span><div><strong>${e.title}</strong><p>${e.summary}</p></div><b>↗</b></button>`}).join('');
  setDialog(p.name,'人物与组织',`<div class="person-dossier"><div class="person-profile"><img src="${asset(p.image)}" alt="虚构人物或地点示意" style="object-position:${p.position}"/><span class="profile-stamp">身份待核实</span><h3>${p.name}</h3><span>${p.role}</span><p>${p.description}</p><small>图片为虚构示意，不是身份认证材料。</small></div><div class="person-evidence"><span class="room-kicker">LINKED EVIDENCE</span><h3>关联材料</h3>${sources}<div class="unresolved-note"><strong>还想问什么？</strong><p>${['studio','wang','li'].includes(id)?'应补充组织主体信息、账户关系和授权证明，再判断各方责任。':'可以补充完整付款记录、活动经历和相关证言，避免只凭片段聊天推断。'}</p><button class="text-link" type="button" data-action="identity">查看主体身份疑点 ↗</button></div></div></div>`);
}
function renderIdentity() {
  setDialog('招募主体身份 · 待补证','OPEN QUESTION / 02',`<div class="identity-review"><span class="chapter-chip">账户关系待核实</span><h3>公告中的组织，与收款账户是什么关系？</h3><div class="comparison-pair">${['E-01','E-04'].map(id=>{const e=evidence(id);return `<article class="comparison-paper"><div><span>${id}</span>${sourceButton(id,'翻阅原文')}</div><h3>${e.title}</h3><p>${e.summary}</p></article>`}).join('')}</div><div class="unresolved-note"><strong>现有证据能支持的内容</strong><p>公告中出现“星跃工作室”，群聊中指定“王某的账户”。二者之间的授权、雇佣或委托关系，现有材料没有证明。</p></div><h4>下一步补证清单</h4><div class="identity-checklist">${['核对退款流水与实际到账时间','补充招募主体及账户授权证明','向其他报名者收集完整证言'].map((text,i)=>`<label><input type="checkbox" data-check="${i}" ${state.checks.includes(i)?'checked':''}/><span>${text}</span></label>`).join('')}</div><p class="small-explanation">勾选用于记录调查安排，不会自动把疑点标为已证实。</p><button class="room-button" type="button" data-action="notebook">把观察记进笔记 →</button></div>`);
}
function renderUnlock() {
  setDialog('补充完整退款回单','虚构示例 · E-05',`<div class="unlock-copy"><h3>核对交易单号与到账时间</h3><p>这份预设回单仅用于示例，不属于你上传的材料。</p><button class="room-button primary" type="button" data-action="${state.extra?'evidence':'add-extra'}" data-id="E-05">${state.extra?'查看原文':'加入示例回单'} →</button></div>`);
}

function renderIntro() {
  setDialog('使用帮助','调查工作台',`<section class="help-content"><p>左侧选择案件模块，在工作台上方切换关系图、时间线或证据档案。</p><ul><li>点击证据查看原文；点击人物先看便签。</li><li>拖动空白处移动关系图，右下角缩放或适应画布。</li><li>重点发现可定位关联材料，再打开原文对照。</li><li>三个工作台视图都支持沉浸展示，按 Esc 退出。</li></ul><p>需要补充材料或导出报告，使用案件内对应入口。</p></section>`);
}

function renderUpload() {
  setDialog('把新的材料放进档案','LOCAL EVIDENCE / 本地材料',`<div class="upload-room"><label class="upload-dropzone" id="uploadDropzone">${icon('folder')}<strong>把截图、PDF、文本或聊天记录 JSON 拖到这里</strong><span>也可以点击选择文件</span><input id="uploadFiles" type="file" accept="image/*,.pdf,.txt,.md,.json" multiple/></label><div class="upload-queue">${uploadQueue.map(f=>`<div>${icon('file')}<span>${esc(f.name)}</span><small>${(f.size/1024).toFixed(0)} KB</small></div>`).join('')||'<p>等待加入材料…</p>'}</div><p class="small-explanation">文件仅在当前页面本地预览，不会发送到服务器。当前版本不自动解析、联网分析或生成新结论；刷新页面后需重新选择文件。</p><button class="room-button primary" type="button" data-action="import-files" ${uploadQueue.length?'':'disabled'}>加入证据档案 →</button></div>`);
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
    case 'reset':setDialog('重新开始这次调查？','RESTART DEMO',`<div class="reset-room"><h3>清空这起演示案件的本地进度。</h3><p>备注、卡片位置和本次加入的预览文件将重置。原始文件不会被改动。</p><div class="dialog-actions"><button class="room-button" type="button" data-action="notebook">保留，返回笔记</button><button class="room-button primary" type="button" data-action="confirm-reset">重新调查</button></div></div>`);break;
  }
}
function continueInvestigation() { openDialog('compare'); }

async function runAction(action,id) {
  switch(action){
    case 'case-home':entry.showHome();break;

    case 'focus-finding':focusFinding(id);break;
    case 'clear-focus':clearFindingFocus();fitBoard(true);break;
    case 'center-read':selectCenter('evidence','E-02');break;
    case 'center-review':$('.center-review')?.scrollIntoView({behavior:'smooth',block:'nearest'});break;

    case 'center-supplement':centerSupplement();break;
    case 'center-hint':$('.center-guide')?.scrollIntoView({behavior:'smooth',block:'nearest'});break;
    case 'close':closeDialog();break;
    case 'evidence':openEvidence(id);break;
    case 'person':openDialog('person',id);break;
    case 'compare':case 'notebook':case 'identity':case 'intro':case 'unlock':case 'reset':openDialog(action);break;
    case 'upload':uploadQueue=[];openDialog('upload');break;
    case 'next':continueInvestigation();break;

    case 'add-extra':state.extra=true;save();renderMain();publishDemoContext();openEvidence('E-05');toast('新证据 E-05 已加入证据墙，时间线同步更新');break;
    case 'export':{
      const url=URL.createObjectURL(new Blob([buildReport(state)],{type:'text/markdown;charset=utf-8'}));
      const a=document.createElement('a');a.href=url;a.download='TruthTrace-调查报告.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('报告已导出');break;
    }
    case 'confirm-reset':uploadedEvidence.forEach(e=>URL.revokeObjectURL(e.url));uploadedEvidence=[];uploadQueue=[];state=createState();save();location.reload();break;
    case 'import-files':await importFiles();break;
  }
}
listen(document,'pointerdown',event=>{if(root.contains(event.target)&&!event.target.closest('.person-peek,.evidence-node'))closePersonPeek()});
listen(document,'click',event=>{
  if(!root.contains(event.target))return;

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
    uploadedEvidence.push({id,title:file.name,kind,date:'本次加入',subtitle:'本地材料 · 未分析',summary:'当前页面本地预览，尚未进行内容提取或证据关联。',upload:true,url:URL.createObjectURL(file),text:kind==='text'?(await file.slice(0,160000).text()).slice(0,40000):'',claims:[]});
  }
  uploadQueue=[];renderMain();closeDialog();showView('evidence');toast('材料已加入本地档案；尚未进行 AI 分析');
}

// Card dragging and panning share one coordinate system with the red threads.
function nodeKey(node){return [...node.classList].find(c=>/^node-(location|poster|chat|student|contact|peers|wang|receipt|group|supplement)$/.test(c))||'central-node'}
function openNode(node){const id=nodeKey(node);if(nodeSources[id])openEvidence(nodeSources[id]);else if(nodePeople[id])showPersonPeek(nodePeople[id],node)}
function closePersonPeek(){ $('.person-peek')?.remove(); }
function showPersonPeek(id,node){
  closePersonPeek();const p=PEOPLE.find(p=>p.id===id),peek=document.createElement('aside');
  peek.className='person-peek';peek.setAttribute('aria-label','主体便签');
  peek.innerHTML=`<button type="button" class="peek-close" aria-label="关闭便签">×</button><small>${id==='studio'?'组织':'人物'} · ${p.role}</small><h3>${p.name}</h3><p>${p.description}</p><button class="room-button" type="button" data-action="person" data-id="${id}">展开档案与来源 →</button>`;
  viewport.append(peek);const rect=node.getBoundingClientRect(),area=viewport.getBoundingClientRect();
  peek.style.left=`${Math.max(8,Math.min(rect.right-area.left+8,viewport.clientWidth-peek.offsetWidth-8))}px`;
  peek.style.top=`${Math.max(8,Math.min(rect.top-area.top,viewport.clientHeight-peek.offsetHeight-8))}px`;
  peek.querySelector('.peek-close').addEventListener('click',closePersonPeek);
}
function bindNode(node){
  node.setAttribute('role','button');node.setAttribute('aria-label',`打开${node.querySelector('h3').textContent}档案`);
  node.addEventListener('click',e=>{if(e.detail===0)openNode(node)});
  node.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openNode(node)}});
}
function fitBoard(reset=false){
  if(reset){clearFindingFocus();zoom=1;pan={x:0,y:0}}
  closePersonPeek();
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
  if(event.target.closest('.person-peek'))return;
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
  $('#fullscreenButton').setAttribute('aria-label',`${label}${viewNames[currentView]}`);
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
    layout.append(dialog);
    if(document.fullscreenEnabled){try{await layout.requestFullscreen();nativeGraphFullscreen=true}catch{/* The immersive page remains usable when native fullscreen is unavailable. */}}
  }else{
    root.append(dialog);
    nativeGraphFullscreen=false;
    if(document.fullscreenElement===layout)await document.exitFullscreen();
    presentationReturnFocus?.focus({preventScroll:true});
  }
}
$('#fullscreenButton').addEventListener('click',async()=>{
  if(currentView==='center'){toggleCenterPresentation();return}
  await toggleGraphPresentation();
});
listen(document,'keydown',event=>{
  if(event.key!=='Escape'||dialog.open)return;
  closePersonPeek();
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
$$('.nav-item').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));
$$('.view-tabs button').forEach((b,i)=>b.addEventListener('click',()=>showView(['graph','timeline','evidence'][i])));
$('.case-selector').dataset.action='case-home';$('.round-button[aria-label="使用帮助"]').dataset.action='intro';$('.notification').remove();
$$('.hero-actions button')[0].dataset.action='unlock';$$('.hero-actions button')[1].dataset.action='upload';
$$('.finding-paper').forEach((el,i)=>{el.setAttribute('role','button');el.setAttribute('aria-pressed','false');el.dataset.action='focus-finding';el.dataset.id=i?'identity':'time';el.querySelector('.finding-sources>span').firstChild.textContent='定位证据 ';el.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();el.click()}})});
const notebookButton=document.createElement('button');notebookButton.type='button';notebookButton.className='notebook-toolbar-button';notebookButton.dataset.action='notebook';
notebookButton.innerHTML=`${icon('note')}<span>核查备注</span><b id="clueCount" hidden>0</b>`;
$('.wall-header-actions').insertBefore(notebookButton,$('#fullscreenButton'));
const presentationLabel=document.createElement('span');presentationLabel.className='center-presentation-label';presentationLabel.textContent='全屏展示';$('#fullscreenButton').append(presentationLabel);
renderMain();fitBoard(true);
const initialView=location.hash.slice(1);
const entry=initEntryFlow({root,signal,asset,onContext:bridge.onContext,cases:bridge.cases,onOpenCase:bridge.onOpenCase,onAnalyzeFiles:bridge.analyzeFiles,onAnalysisReady:bridge.onAnalysisReady,onOpenChannel:bridge.onOpenChannel,onDemoReady:(caseName,fresh)=>{
  publishDemoContext(caseName);
  if(fresh){
    state=createState();uploadedEvidence.forEach(e=>URL.revokeObjectURL(e.url));uploadedEvidence=[];save();
    centerSelection={type:'evidence',id:'E-02'};centerCatalogQuery='';centerFilter='all';centerQuery='';
    $('.node-supplement')?.remove();$('.supplement-thread')?.remove();
    $$('.evidence-node,.thread-label').forEach(node=>{node.style.removeProperty('left');node.style.removeProperty('top')});
  }
  $$('.hero-title h1,.breadcrumb>strong,.case-selector strong,.immersive-context strong').forEach(el=>el.textContent=caseName);
  $('.hero-description').textContent='张同学申请退还 500 元押金，退款时间与招募主体仍待核实。';
  renderMain();showView('graph');fitBoard(true);
}});
if(Object.hasOwn(viewNames,initialView)||initialView==='graph-demo'){
  entry.hide();publishDemoContext();showView(initialView==='graph-demo'?'graph':initialView);
  if(initialView==='graph-demo')toggleGraphPresentation(true);
}else if(initialView==='new')entry.startNew();else entry.showHome();

return ()=>{abort.abort();observer.disconnect();entry.dispose();clearTimeout(toastTimer);clearTimeout(catTimer);uploadedEvidence.forEach(item=>URL.revokeObjectURL(item.url));if(dialog.open)dialog.close();document.body.className=bodyClasses;root.replaceChildren()};
}
