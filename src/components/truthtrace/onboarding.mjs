import { EVIDENCE } from './case-data.mjs';

const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>`<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sessionKey='truthtrace.active-case.v1';

export function validateFiles(files) {
  const accepted=[],rejected=[];
  for(const file of files){
    if(file.size===0)rejected.push(`${file.name} 是空文件`);
    else if(file.size>8*1024*1024)rejected.push(`${file.name} 超过 8 MB`);
    else if(!file.type.startsWith('image/')&&!/\.(pdf|txt|md)$/i.test(file.name))rejected.push(`${file.name} 的格式暂不支持`);
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

export function initEntryFlow({root,signal,asset,onAnalyzeFiles,onAnalysisReady,onDemoReady}) {
  const host=root.querySelector('#caseEntry');
  let title='',items=[],mode='personal',screen='home',selected=0,run=0,feedback='',apiResult=null,pendingRequest=null;
  let lastCase;
  try{lastCase=JSON.parse(localStorage.getItem(sessionKey))}catch{/* An empty workspace is still available without storage. */}
  if(!lastCase||typeof lastCase.title!=='string'||!['sample','personal'].includes(lastCase.mode))lastCase=null;

  const brand=`<a class="entry-brand" href="#home" data-entry="home" aria-label="TruthTrace 首页"><img src="${asset('inspector-avatar.png')}" alt="咪探长"/><span><strong>TruthTrace</strong><small>AI 现实档案调查局</small></span></a>`;
  function shell(content,step){
    host.innerHTML=`<div class="entry-shell"><header class="entry-header">${brand}<span class="entry-breadcrumb">工作空间 <i>/</i> ${screen==='home'?'我的案件':screen==='local'?'材料工作台':'新建案件'}</span><span class="entry-private">${icon('folder')} 案件工作空间</span></header>${step?`<nav class="entry-steps" aria-label="创建案件进度">${['创建与导入','整理材料','进入调查'].map((label,i)=>`<span class="${step===i+1?'active':step>i+1?'done':''}" ${step===i+1?'aria-current="step"':''}><b>${step>i+1?'✓':`0${i+1}`}</b>${label}</span>`).join('')}</nav>`:''}${content}<footer class="entry-footer"><span>EVERY DETAIL MATTERS.</span><span>把每一条线索，放回它的来处。</span></footer></div>`;
  }
  function enter(next,hash){
    const changed=screen!==next;screen=next;document.body.classList.add('case-entry');
    history.replaceState(null,'',`#${hash||next}`);
    if(changed)window.scrollTo(0,0);
  }
  function hide(){document.body.classList.remove('case-entry')}
  function release(){items.forEach(item=>URL.revokeObjectURL(item.url));items=[]}
  function showHome(){
    run++;pendingRequest?.abort();pendingRequest=null;enter('home');
    shell(`<section class="entry-home"><div class="entry-home-heading"><div><p class="entry-eyebrow">YOUR INVESTIGATION ROOM</p><h1>我的案件</h1><p>从第一份材料开始，慢慢接近事情的全貌。</p></div><span class="entry-case-count">${lastCase?'01':'00'} 份案件档案</span></div>${lastCase?`<button class="entry-resume" type="button" data-entry="resume">${icon('folder')}<span><small>${lastCase.mode==='sample'?'示例案件':'本地案件'}</small><strong>${esc(lastCase.title)}</strong><span>${Number(lastCase.count)||0} 份材料 · ${lastCase.mode==='sample'?'继续调查':'继续查看材料'}</span></span><b>继续 →</b></button>`:''}<section class="empty-case-surface"><span class="empty-room-label">${lastCase?'A NEW CHAPTER':'NO CASE OPEN · 001'}</span><div class="empty-folder" aria-hidden="true"><span class="folder-sheet sheet-back"></span><span class="folder-sheet sheet-front"><i></i><i></i><i></i></span><span class="folder-cover">${icon('folder')}<small>TRUTHTRACE ARCHIVE</small></span></div><h2>${lastCase?'让新的线索，有自己的档案。':'你的调查室，等待第一份档案。'}</h2><p>创建案件，导入聊天记录、截图或文件。</p><button class="entry-primary" type="button" data-entry="new">${icon('plus')} 创建案件</button><button class="entry-text-button" type="button" data-entry="sample">用示例材料体验完整流程 <span>↗</span></button><div class="empty-room-cat"><span>先把材料放上来。</span><img src="${asset('detective-cat.png')}" alt="Synapse · 咪探长"/></div></section></section>`);
  }
  function startNew(){run++;apiResult=null;release();mode='personal';title='';feedback='';selected=0;showImport()}
  function showImport(){
    run++;pendingRequest?.abort();pendingRequest=null;enter('import','new');
    shell(`<section class="entry-title"><p class="entry-eyebrow">OPEN A CASE</p><h1>给线索，一个开始。</h1><p>给案件起个名字，把手边的材料放进来。</p></section><form id="entryImportForm" class="entry-import-grid"><section class="import-paper"><label class="entry-field-label" for="entryCaseName"><span>01</span> 案件名称</label><input id="entryCaseName" name="caseName" type="text" maxlength="60" required autocomplete="off" placeholder="例如：校园兼职押金纠纷" value="${esc(title)}"/><div class="entry-upload-heading"><span class="entry-field-label"><span>02</span> 导入材料</span><button class="entry-text-button" type="button" data-entry="sample">导入示例材料 ↗</button></div><label class="entry-dropzone" id="entryDropzone">${icon('folder')}<strong>把聊天截图、文件拖到这里</strong><span>或点击选择文件</span><small>图片 / PDF / TXT / MD · 单份不超过 8 MB · 最多 8 份</small><input id="entryFiles" type="file" accept="image/*,.pdf,.txt,.md" multiple aria-label="选择案件材料"/></label><div class="import-files-heading"><strong>已选材料 <span>${items.length.toString().padStart(2,'0')}</span></strong><small>${mode==='sample'?'虚构示例材料':'点击开始整理后上传服务器处理'}</small></div><div class="entry-file-list">${items.map((item,i)=>`<div class="entry-file-row ${i===selected?'selected':''}"><button type="button" data-entry-preview="${i}">${icon(item.kind==='image'?'layers':'file')}<span><strong>${esc(item.file.name)}</strong><small>${formatSize(item.file.size)} · ${item.kind==='image'?'图片':item.kind==='pdf'?'PDF':'文本'}</small></span></button><button type="button" class="entry-remove-file" data-entry-remove="${i}" aria-label="移除 ${esc(item.file.name)}">×</button></div>`).join('')||'<p class="entry-no-files">还没有材料。微信聊天截图、退款凭证都可以先放进来。</p>'}</div><p id="entryFeedback" class="entry-feedback" role="status">${esc(feedback)}</p><div class="entry-import-actions"><button class="entry-text-button" type="button" data-entry="home">← 返回案件首页</button><button class="entry-primary" id="entryStart" type="submit" ${!title.trim()||!items.length?'disabled':''}>开始整理 ${icon('chevron')}</button></div></section><aside class="import-preview"><div class="entry-preview-heading"><span>材料预览</span><small>${items.length?`${selected+1} / ${items.length}`:'等待导入'}</small></div><div id="entryPreview">${previewMarkup(items[selected])}</div><div class="import-preview-note">${icon('note')}<span>点击开始整理后，材料将发送至解析与分析服务。PDF 需配置解析服务；刷新页面后需重新选择文件。</span></div></aside></form>`,1);
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
    if(!item)return `<div class="entry-preview-empty"><img src="${asset('inspector-avatar.png')}" alt="咪探长"/><h3>先看看原始材料。</h3><p>选中一份文件，它会显示在这里。</p></div>`;
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
      try{if(kind==='text')text=await file.text()}catch{feedback=`无法读取 ${file.name}，请重新选择。`;continue}
      if(request!==run)return;
      items.push({file,kind,url:URL.createObjectURL(file),text:text.slice(0,40000),truncated:text.length>40000});
    }
    selected=Math.min(selected,Math.max(0,items.length-1));showImport();
  }
  async function useSample(){
    const sampleTitle=screen==='import'&&title.trim()?title.trim():'校园兼职押金纠纷';
    run++;release();mode='sample';title=sampleTitle;feedback='';selected=0;
    await addFiles(createSampleFiles(),true);
  }
  async function analyze(){
    title=title.trim();if(!title||!items.length)return;
    enter('analyzing');const request=++run;
    const stages=mode==='sample'?['整理 4 份示例材料','整理人物与时间线','建立示例证据关联']:['解析上传材料','生成结构化分析','准备调查工作台'];
    shell(`<section class="entry-analysis"><div class="analysis-emblem">${icon('network')}<span></span></div><p class="entry-eyebrow">${mode==='sample'?'SAMPLE CASE · 演示分析':'LOCAL CASE · 本地整理'}</p><h1>正在整理你的材料</h1><p class="analysis-case-name">${esc(title)} <span>· ${items.length} 份材料</span></p><div class="analysis-progress" role="progressbar" aria-label="材料整理进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div><ol class="analysis-stages">${stages.map((text,i)=>`<li class="${i===0?'active':''}"><b>${i+1}</b><span>${text}</span><i>${i===0?'进行中':'等待中'}</i></li>`).join('')}</ol><p class="analysis-disclosure">${mode==='sample'?'分析结果为虚构示例，用于体验完整流程。':'通过团队解析与分析接口处理，结果保留证据来源。'}</p><button class="entry-text-button" type="button" data-entry="back-import">返回修改材料</button><span class="entry-live-status" role="status" aria-live="polite">正在${stages[0]}</span></section>`,2);
    if(mode==='personal'){
      pendingRequest=new AbortController();
      try{
        apiResult=await onAnalyzeFiles(items.map(item=>item.file),pendingRequest.signal,()=>{
          if(request!==run)return;
          const rows=host.querySelectorAll('.analysis-stages li');rows[0].className='done';rows[0].querySelector('b').textContent='✓';rows[0].querySelector('i').textContent='已完成';rows[1].className='active';rows[1].querySelector('i').textContent='进行中';
          host.querySelector('.analysis-progress').setAttribute('aria-valuenow','50');host.querySelector('.analysis-progress>span').style.width='50%';
        });
        if(request!==run)return;pendingRequest=null;showReady();
      }catch(error){
        if(request!==run)return;pendingRequest=null;feedback=error instanceof Error?error.message:'材料处理失败，请稍后重试。';showImport();
      }
      return;
    }
    for(let i=0;i<stages.length;i++){
      await new Promise(resolve=>setTimeout(resolve,1200));
      if(request!==run)return;
      const row=host.querySelectorAll('.analysis-stages li')[i];row.className='done';row.querySelector('b').textContent='✓';row.querySelector('i').textContent='已完成';
      const bar=host.querySelector('.analysis-progress'),percent=Math.round((i+1)/stages.length*100);bar.setAttribute('aria-valuenow',percent);bar.firstElementChild.style.width=`${percent}%`;
      const next=host.querySelectorAll('.analysis-stages li')[i+1];if(next){next.className='active';next.querySelector('i').textContent='进行中';host.querySelector('.entry-live-status').textContent=`正在${stages[i+1]}`}
    }
    showReady();
  }
  function showReady(){
    enter('ready');
    shell(`<section class="entry-analysis entry-ready"><div class="ready-check">✓</div><p class="entry-eyebrow">${mode==='sample'?'SAMPLE CASE IS READY':'YOUR MATERIALS ARE READY'}</p><h1>${mode==='sample'?'线索已就位，开始调查。':'材料已就绪，开始查看。'}</h1><p class="analysis-case-name">${esc(title)}</p><div class="entry-result-stats"><div><strong>${items.length.toString().padStart(2,'0')}</strong><span>份材料</span></div><div><strong>${String(mode==='sample'?4:apiResult?.analysis.people.length||0).padStart(2,'0')}</strong><span>位相关人物</span></div><div><strong>${String(mode==='sample'?2:apiResult?.analysis.contradictions.length||0).padStart(2,'0')}</strong><span>处待核实疑点</span></div></div><div class="entry-ready-note"><img src="${asset('inspector-avatar.png')}" alt="Synapse · 咪探长"/><p>${mode==='sample'?'退款说法与到账时间有差异，先从原文查起。':'原始文件已导入，可以先核对材料。'}</p></div><button class="entry-primary" type="button" data-entry="open-workbench">进入调查工作台 ${icon('chevron')}</button><small class="ready-disclosure">${mode==='sample'?'示例分析 · 使用预设案件数据':apiResult?.analysis.analysisMode==='model'?'模型分析 · 请核对原文':'模拟分析 · 不代表真实识别'}</small></section>`,3);
  }
  function openWorkbench(fresh=true){
    lastCase={title,mode,count:items.length};
    try{localStorage.setItem(sessionKey,JSON.stringify(lastCase))}catch{/* Continue with the case in this page. */}
    if(mode==='sample'){hide();onDemoReady(title,fresh)}else if(apiResult){hide();onAnalysisReady({...apiResult,caseName:title})}else showLocal();
  }
  function showLocal(){
    enter('local','materials');
    shell(`<section class="local-case-heading"><div><p class="entry-eyebrow">YOUR CASE FILE</p><h1>${esc(title)}</h1><p>${items.length} 份材料已导入 <span>· 内容待解析</span></p></div><button class="entry-primary" type="button" data-entry="back-import">${icon('plus')} 补充材料</button></section><div class="local-desk"><aside class="local-file-catalog"><h2>证据档案 <span>${items.length}</span></h2>${items.map((item,i)=>`<button class="${i===selected?'selected':''}" type="button" data-local-preview="${i}"><small>U-${String(i+1).padStart(2,'0')}</small><strong>${esc(item.file.name)}</strong><span>${formatSize(item.file.size)}</span></button>`).join('')}</aside><section class="local-original"><header><span>原始材料</span><strong>${esc(items[selected]?.file.name||'')}</strong></header><div>${previewMarkup(items[selected])}</div></section><aside class="local-analysis-note"><img src="${asset('inspector-avatar.png')}" alt="Synapse · 咪探长"/><strong>Synapse · 咪探长</strong><p>材料已就位，先核对原始内容。</p><button class="entry-outline" type="button" data-entry="home">返回案件首页 →</button><div>${icon('network')}<h3>证据关联等待分析</h3><p>完成内容分析后，这里会显示人物、时间线和证据关联。</p><small>当前不会为上传文件生成结论。</small></div></aside></div>`);
  }
  root.addEventListener('click',event=>{
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
  return {showHome,startNew,hide,dispose(){run++;pendingRequest?.abort();release()}};
}
