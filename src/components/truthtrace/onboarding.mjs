import { EVIDENCE } from './case-data.mjs';

const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
// 渠道图标：钉钉=单气泡方框，微信=双气泡；只做识别，不冒充平台 logo
const channelIcon=name=>`<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${name==='wechat'?'<path d="M9.5 5.5c-3.6 0-6.5 2.4-6.5 5.4 0 1.7 1 3.2 2.5 4.2l-.6 2.2 2.4-1.2c.7.2 1.4.3 2.2.3"/><path d="M14.8 8.6c3.3 0 6 2.2 6 5 0 1.6-.9 3-2.3 3.9l.5 2-2.2-1.1c-.6.2-1.3.2-2 .2-3.3 0-6-2.2-6-5s2.7-5 6-5z"/>':'<path d="M4.5 6.5h15v9.5H9.8L5.8 19.5V16H4.5z"/><path d="M8.5 10.2h7M8.5 12.8h4"/>'}</svg>`;
const sessionKey='truthtrace.active-case.v1';

export function validateFiles(files) {
  const accepted=[],rejected=[];
  for(const file of files){
    if(file.size===0)rejected.push(`${file.name} 是空文件`);
    // json 也要收：钉钉/微信导出的聊天记录是 JSON，B 会把它转成「1 条 chat + N 张图」
    else if(!file.type.startsWith('image/')&&!/\.(pdf|txt|md|json)$/i.test(file.name))rejected.push(`${file.name} 的格式暂不支持`);
    else if(accepted.length===8)rejected.push('一次最多导入 8 份材料');
    else accepted.push(file);
  }
  return {accepted,rejected:[...new Set(rejected)]};
}

export function createSampleFiles() {
  return EVIDENCE.filter(e=>!e.extra).map(e=>{
    const text=[`${e.id} · ${e.title}`,e.subtitle,'虚构示例材料',...(e.lines||[]),...(e.messages||[]).map(m=>`${m.time} ${m.speaker}：${m.text}`),...(e.fields||[]).map(([name,value])=>`${name}：${value}`)].join('\n');
    return new File([text],`${e.id}-${e.title}.txt`,{type:'text/plain'});
  });
}

export function initEntryFlow({root,signal,asset,onAnalyzeFiles,onAnalysisReady,onDemoReady,onContext,cases=[],onOpenCase,onOpenChannel}) {
  const host=root.querySelector('#caseEntry');
  let title='',items=[],mode='personal',screen='home',selected=0,run=0,feedback='',apiResult=null,pendingRequest=null;
  let lastCase;
  try{lastCase=JSON.parse(localStorage.getItem(sessionKey))}catch{/* An empty workspace is still available without storage. */}
  if(!lastCase||typeof lastCase.title!=='string'||lastCase.mode!=='sample')lastCase=null;

  const petTimers=new Map();
  function pet(element){clearTimeout(petTimers.get(element));element.classList.remove('mascot-petting');void element.offsetWidth;element.classList.add('mascot-petting');petTimers.set(element,setTimeout(()=>{element.classList.remove('mascot-petting');petTimers.delete(element)},750))}
  const brand=`<a class="entry-brand" href="#home" data-entry="home" aria-label="TruthTrace 首页"><img src="${asset('inspector-avatar.png')}" alt="咪探长"/><span><strong>TruthTrace</strong><small>证据调查工作台</small></span></a>`;
  function shell(content,step){
    host.innerHTML=`<div class="entry-shell"><header class="entry-header">${brand}<span class="entry-breadcrumb">工作空间 <i>/</i> ${screen==='home'?'我的案件':screen==='local'?'材料工作台':'新建案件'}</span><span class="entry-private">${icon('folder')} 案件工作空间</span></header>${step?`<nav class="entry-steps" aria-label="创建案件进度">${['导入材料','整理材料','调查结果'].map((label,i)=>`<span class="${step===i+1?'active':step>i+1?'done':''}" ${step===i+1?'aria-current="step"':''}><b>${step>i+1?'✓':`0${i+1}`}</b>${label}</span>`).join('')}</nav>`:''}${content}<footer class="entry-footer"><span>EVERY DETAIL MATTERS.</span><span>原始材料随时可查。</span></footer></div>`;
  }
  function enter(next,hash){
    const changed=screen!==next;screen=next;document.body.classList.add('case-entry');
    history.replaceState(null,'',`#${hash||next}`);
    if(changed)window.scrollTo(0,0);
  }
  function hide(){document.body.classList.remove('case-entry')}
  function release(){items.forEach(item=>URL.revokeObjectURL(item.url));items=[]}
  function showHome(){
    onContext?.(null);
    run++;pendingRequest?.abort();pendingRequest=null;enter('home');
    shell(`<section class="entry-home"><div class="entry-home-heading"><div><p class="entry-eyebrow">YOUR INVESTIGATION ROOM</p><h1>我的案件</h1><p>导入材料，查看事件、关联与待核查问题。</p></div><span class="entry-case-count">${cases.length+(lastCase?1:0)} 份案件档案</span></div>${cases.map(item=>`<button class="entry-resume" type="button" data-entry-case="${esc(item.caseId)}">${icon('folder')}<span><strong>${esc(item.caseName||item.analysis.caseTitle)}</strong><span>${item.evidence.length} 份材料 · ${item.analysis.analysisMode==='mock'?'模拟分析':'模型分析'}</span></span><b>打开 →</b></button>`).join('')}${cases.length?'<p class="entry-session-note">案件仅保留在本次页面会话，关闭或刷新前请导出报告。</p>':''}${lastCase?`<button class="entry-resume" type="button" data-entry="resume">${icon('folder')}<span><small>${lastCase.mode==='sample'?'示例案件':'本地案件'}</small><strong>${esc(lastCase.title)}</strong><span>预设示例 · 继续查看</span></span><b>继续 →</b></button>`:''}<section class="empty-case-surface"><span class="empty-room-label">${lastCase?'A NEW CHAPTER':'NO CASE OPEN · 001'}</span><div class="empty-folder" aria-hidden="true"><span class="folder-sheet sheet-back"></span><span class="folder-sheet sheet-front"><i></i><i></i><i></i></span><span class="folder-cover">${icon('folder')}<small>TRUTHTRACE ARCHIVE</small></span></div><h2>${lastCase?'新建一份案件':'创建你的第一份案件'}</h2><p>创建案件，导入聊天记录、截图或文件。</p><div class="entry-create-actions"><button class="entry-primary" type="button" data-entry="new">${icon('plus')} 手动创建</button><button class="entry-channel" type="button" data-entry="import-dingtalk">${channelIcon('dingtalk')} 从钉钉导入</button><button class="entry-channel" type="button" data-entry="import-wechat">${channelIcon('wechat')} 从微信导入</button></div><button class="entry-text-button" type="button" data-entry="sample">用示例材料体验完整流程 <span>↗</span></button><button class="empty-room-cat" type="button" aria-label="摸摸首页咪探长"><span>材料准备好了吗？</span><img src="${asset('detective-cat.png')}" alt="Synapse · 咪探长"/></button></section></section>`);
  }
  function startNew(){onContext?.(null);run++;apiResult=null;release();mode='personal';title='';feedback='';selected=0;showImport()}
  function showImport(){
    run++;pendingRequest?.abort();pendingRequest=null;enter('import','new');
    shell(`<section class="entry-title"><p class="entry-eyebrow">OPEN A CASE</p><h1>新建案件</h1><p>填写案件名称，上传聊天截图或转账记录。</p></section><form id="entryImportForm" class="entry-import-grid"><section class="import-paper"><label class="entry-field-label" for="entryCaseName"><span>01</span> 案件名称</label><input id="entryCaseName" name="caseName" type="text" maxlength="60" required autocomplete="off" placeholder="例如：校园兼职押金纠纷" value="${esc(title)}"/><div class="entry-upload-heading"><span class="entry-field-label"><span>02</span> 导入材料</span><button class="entry-text-button" type="button" data-entry="sample">导入示例材料 ↗</button></div><label class="entry-dropzone" id="entryDropzone">${icon('folder')}<strong>把聊天截图、聊天记录 JSON 拖到这里</strong><span>或点击选择文件</span><small>图片 / PDF / TXT / MD / 聊天 JSON · 最多 8 份</small><input id="entryFiles" type="file" accept="image/*,.pdf,.txt,.md,.json" multiple aria-label="选择案件材料"/></label><div class="import-files-heading"><strong>已选材料 <span>${items.length.toString().padStart(2,'0')}</span></strong><small>${mode==='sample'?'虚构示例材料':'点击开始整理后上传服务器处理'}</small></div><div class="entry-file-list">${items.map((item,i)=>`<div class="entry-file-row ${i===selected?'selected':''}"><button type="button" data-entry-preview="${i}">${icon(item.kind==='image'?'layers':'file')}<span><strong>${esc(item.file.name)}</strong><small>${formatSize(item.file.size)} · ${item.kind==='image'?'图片':item.kind==='pdf'?'PDF':'文本'}</small></span></button><button type="button" class="entry-remove-file" data-entry-remove="${i}" aria-label="移除 ${esc(item.file.name)}">×</button></div>`).join('')||'<p class="entry-no-files">还没有材料。微信聊天截图、退款凭证都可以先放进来。</p>'}</div><p id="entryFeedback" class="entry-feedback" role="status">${esc(feedback)}</p><div class="entry-import-actions"><button class="entry-text-button" type="button" data-entry="home">← 返回案件首页</button><button class="entry-primary" id="entryStart" type="submit" ${!title.trim()||!items.length?'disabled':''}>开始整理 ${icon('chevron')}</button></div></section><aside class="import-preview"><div class="entry-preview-heading"><span>材料预览</span><small>${items.length?`${selected+1} / ${items.length}`:'等待导入'}</small></div><div id="entryPreview">${previewMarkup(items[selected])}</div><div class="import-preview-note">${icon('note')}<span>${mode==='sample'?'虚构示例使用预设结果，不发送到解析服务。':'材料发送至解析服务处理；PDF 需配置解析服务。'}</span></div></aside></form>`,1);
    const field=host.querySelector('#entryCaseName');
    field.addEventListener('input',()=>{title=field.value;host.querySelector('#entryStart').disabled=!title.trim()||!items.length});
    host.querySelector('#entryFiles').addEventListener('change',event=>addFiles(event.target.files));
    const zone=host.querySelector('#entryDropzone');
    zone.addEventListener('dragover',event=>{event.preventDefault();zone.classList.add('drag-over')});
    zone.addEventListener('dragleave',()=>zone.classList.remove('drag-over'));
    zone.addEventListener('drop',event=>{event.preventDefault();addFiles(event.dataTransfer.files)});
    host.querySelector('#entryImportForm').addEventListener('submit',event=>{event.preventDefault();analyze()});
  }
  function formatSize(size){return size<1024*1024?`${Math.max(1,Math.round(size/1024))} KB`:`${(size/1024/1024).toFixed(1)} MB`}
  function previewMarkup(item){
    if(!item)return `<div class="entry-preview-empty"><img src="${asset('inspector-avatar.png')}" alt="咪探长"/><h3>材料预览</h3><p>选中一份文件，它会显示在这里。</p></div>`;
    if(item.kind==='image')return `<img class="entry-preview-image" src="${item.url}" alt="${esc(item.file.name)}"/>`;
    if(item.kind==='pdf')return `<object class="entry-preview-pdf" data="${item.url}" type="application/pdf"><a href="${item.url}" target="_blank" rel="noopener">打开 PDF ↗</a></object>`;
    return `<article class="entry-text-preview"><small>原始文本 / ${esc(item.file.name)}</small><pre>${esc(item.text)}</pre>${item.truncated?'<small>预览显示前 40,000 字。</small>':''}</article>`;
  }
  async function addFiles(files,sample=false){
    const request=run;
    const result=validateFiles(files);feedback=result.rejected.join('；');
    if(!result.accepted.length){showImport();return}
    if(!sample&&mode==='sample'){
      feedback='示例材料和你的文件不会混合。已切换为本地案件。'+(feedback?' '+feedback:'');release();mode='personal';
    }
    for(const file of result.accepted){
      if(items.some(item=>item.file.name===file.name&&item.file.size===file.size))continue;
      if(items.length===8){feedback='最多导入 8 份材料，请先移除不需要的文件。';break}
      const kind=file.type.startsWith('image/')?'image':/\.pdf$/i.test(file.name)?'pdf':'text';
      let text='';
      try{if(kind==='text')text=await file.slice(0,160000).text()}catch{feedback=`无法读取 ${file.name}，请重新选择。`;continue}
      if(request!==run)return;
      items.push({file,kind,url:URL.createObjectURL(file),text:text.slice(0,40000),truncated:file.size>160000||text.length>40000});
    }
    selected=Math.min(selected,Math.max(0,items.length-1));showImport();
  }
  async function useSample(){
    const sampleTitle='校园兼职押金纠纷';
    run++;release();mode='sample';title=sampleTitle;feedback='';selected=0;
    await addFiles(createSampleFiles(),true);
  }
  async function analyze(){
    title=title.trim();if(!title||!items.length)return;
    enter('analyzing');const request=++run;
    const stages=mode==='sample'?['整理 4 份示例材料','整理人物与时间线','建立示例证据关联']:['解析上传材料','生成结构化分析','准备调查工作台'];
    shell(`<section class="entry-analysis"><div class="analysis-emblem">${icon('network')}<span></span></div><p class="entry-eyebrow">${mode==='sample'?'虚构示例':'材料整理'}</p><h1>正在整理你的材料</h1><p class="analysis-case-name">${esc(title)} <span>· ${items.length} 份材料</span></p><div class="analysis-progress" aria-hidden="true"><span></span></div><ol class="analysis-stages">${stages.map((text,i)=>`<li class="${i===0?'active':''}"><b>${i+1}</b><span>${text}</span><i>${i===0?'进行中':'等待中'}</i></li>`).join('')}</ol><p class="analysis-disclosure">${mode==='sample'?'分析结果为虚构示例，用于体验完整流程。':'通过团队解析与分析接口处理，结果保留证据来源。'}</p><button class="entry-text-button" type="button" data-entry="back-import">返回修改材料</button><span class="entry-live-status" role="status" aria-live="polite">正在${stages[0]}</span></section>`,2);
    if(mode==='personal'){
      pendingRequest=new AbortController();
      try{
        apiResult=await onAnalyzeFiles(items.map(item=>item.file),pendingRequest.signal,()=>{
          if(request!==run)return;
          const rows=host.querySelectorAll('.analysis-stages li');rows[0].className='done';rows[0].querySelector('b').textContent='✓';rows[0].querySelector('i').textContent='已完成';rows[1].className='active';rows[1].querySelector('i').textContent='进行中';
          host.querySelector('.entry-live-status').textContent='正在整理人物、时间与证据关联';
        });
        if(request!==run)return;pendingRequest=null;openWorkbench();
      }catch(error){
        if(request!==run)return;pendingRequest=null;feedback=error instanceof Error?error.message:'材料处理失败，请稍后重试。';showImport();
      }
      return;
    }
    for(let i=0;i<stages.length;i++){
      await new Promise(resolve=>setTimeout(resolve,350));
      if(request!==run)return;
      const row=host.querySelectorAll('.analysis-stages li')[i];row.className='done';row.querySelector('b').textContent='✓';row.querySelector('i').textContent='已完成';
      const bar=host.querySelector('.analysis-progress'),percent=Math.round((i+1)/stages.length*100);bar.firstElementChild.style.width=`${percent}%`;
      const next=host.querySelectorAll('.analysis-stages li')[i+1];if(next){next.className='active';next.querySelector('i').textContent='进行中';host.querySelector('.entry-live-status').textContent=`正在${stages[i+1]}`}
    }
    openWorkbench();
  }
  function openWorkbench(fresh=true){
    lastCase={title,mode,count:items.length};
    try{if(mode==='sample')localStorage.setItem(sessionKey,JSON.stringify(lastCase))}catch{/* Continue with the case in this page. */}
    if(mode==='sample'){hide();onDemoReady(title,fresh)}else if(apiResult){hide();onAnalysisReady({...apiResult,caseName:title})}else showLocal();
  }
  function showLocal(){
    enter('local','materials');
    shell(`<section class="local-case-heading"><div><p class="entry-eyebrow">YOUR CASE FILE</p><h1>${esc(title)}</h1><p>${items.length} 份材料已导入 <span>· 内容待解析</span></p></div><button class="entry-primary" type="button" data-entry="back-import">${icon('plus')} 补充材料</button></section><div class="local-desk"><aside class="local-file-catalog"><h2>证据档案 <span>${items.length}</span></h2>${items.map((item,i)=>`<button class="${i===selected?'selected':''}" type="button" data-local-preview="${i}"><small>U-${String(i+1).padStart(2,'0')}</small><strong>${esc(item.file.name)}</strong><span>${formatSize(item.file.size)}</span></button>`).join('')}</aside><section class="local-original"><header><span>原始材料</span><strong>${esc(items[selected]?.file.name||'')}</strong></header><div>${previewMarkup(items[selected])}</div></section><aside class="local-analysis-note"><img src="${asset('inspector-avatar.png')}" alt="Synapse · 咪探长"/><strong>Synapse · 咪探长</strong><p>材料已就位，先核对原始内容。</p><button class="entry-outline" type="button" data-entry="home">返回案件首页 →</button><div>${icon('network')}<h3>证据关联等待分析</h3><p>完成内容分析后，这里会显示人物、时间线和证据关联。</p><small>当前不会为上传文件生成结论。</small></div></aside></div>`);
  }
  root.addEventListener('pointerover',event=>{const target=event.target.closest('.empty-room-cat,.entry-brand>img');if(target&&!target.contains(event.relatedTarget))pet(target)},{signal});
  root.addEventListener('click',event=>{
    const mascot=event.target.closest('.empty-room-cat,.entry-brand>img');if(mascot){event.preventDefault();pet(mascot);return}
    const stored=event.target.closest('[data-entry-case]');if(stored){hide();onOpenCase(stored.dataset.entryCase);return}
    const preview=event.target.closest('[data-entry-preview]');
    if(preview){selected=Number(preview.dataset.entryPreview);showImport();return}
    const local=event.target.closest('[data-local-preview]');
    if(local){selected=Number(local.dataset.localPreview);showLocal();return}
    const remove=event.target.closest('[data-entry-remove]');
    if(remove){URL.revokeObjectURL(items[Number(remove.dataset.entryRemove)].url);items.splice(Number(remove.dataset.entryRemove),1);selected=Math.min(selected,Math.max(0,items.length-1));if(mode==='sample'){mode='personal';feedback='示例材料有变动，改为本地材料预览。'}showImport();return}
    const button=event.target.closest('[data-entry]');if(!button)return;event.preventDefault();
    switch(button.dataset.entry){
      case 'home':showHome();break;
      case 'new':startNew();break;
      // 渠道导入不在这个纯 DOM 流程里做（要会话多选 + 聊天预览），交给 React 覆盖层
      case 'import-dingtalk':onOpenChannel?.('dingtalk');break;
      case 'import-wechat':onOpenChannel?.('wechat');break;
      case 'sample':useSample();break;
      case 'back-import':showImport();break;
      case 'open-workbench':openWorkbench();break;
      case 'resume':
        title=lastCase.title;mode=lastCase.mode;
        if(mode==='sample'){hide();onDemoReady(title,false)}
        else if(items.length)showLocal();else{feedback='文件仍在你的电脑中，请重新选择后继续。';showImport()}
        break;
    }
  },{signal});
  return {showHome,startNew,hide,dispose(){run++;pendingRequest?.abort();petTimers.forEach(timer=>clearTimeout(timer));petTimers.clear();release()}};
}
