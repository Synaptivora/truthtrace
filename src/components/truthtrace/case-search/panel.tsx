"use client";
import styles from './panel.module.css';
import {useCallback,useEffect,useRef,useState} from 'react';
import type {CommitmentProjection} from '@/lib/commitments';
type Case={caseId:string;name:string;tags:string[];archived:boolean;people:{id:string;name:string}[]};
type Hit={caseId:string;caseName:string;evidenceId:string;evidenceName:string;version:number;id:string;start:number;end:number;content:string;source:string};
type Result={cases:Case[];hits:Hit[];total:number;nextOffset:number|null;note:string;commitments:CommitmentProjection[]};
export function CaseSearch({onOpenCase}:{onOpenCase:(id:string)=>void}){
 const defaults={q:'',caseId:'',source:'',from:'',to:'',personId:'',tag:'',archived:'no'};
 const [pageOffset,setPageOffset]=useState(0);
 const [data,setData]=useState<Result|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[view,setView]=useState('search'),[state,setState]=useState('all');
 const [filters,setFilters]=useState(defaults),[applied,setApplied]=useState(defaults),[saving,setSaving]=useState(false),[feedback,setFeedback]=useState('');
 const request=useRef<AbortController|null>(null),saveRequest=useRef<AbortController|null>(null),sequence=useRef(0);
 const latest=useRef({filters:applied,offset:pageOffset});
 const dirty=JSON.stringify(filters)!==JSON.stringify(applied);
 const load=useCallback(async(next:typeof defaults,offset=0)=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;const ticket=++sequence.current;
  if(next.from&&next.to&&next.from>next.to){setError('起始日期不能晚于截止日期');setBusy(false);return;}
  setBusy(true);setError('');latest.current={filters:next,offset};
  try{const params=new URLSearchParams(Object.entries(next).filter(([,v])=>v));params.set('offset',String(offset));const response=await fetch(`/api/case-search?${params}`,{signal:controller.signal});if(!response.ok)throw Error('检索失败，请缩小范围或检查筛选条件');const result=await response.json();if(ticket!==sequence.current||controller.signal.aborted)return;setData(result);setApplied(next);setPageOffset(offset);}
  catch(e){if(!controller.signal.aborted&&ticket===sequence.current)setError((e as Error).message);}finally{if(ticket===sequence.current&&!controller.signal.aborted)setBusy(false);}
 },[]);
 useEffect(()=>{const timer=setTimeout(()=>void load({q:'',caseId:'',source:'',from:'',to:'',personId:'',tag:'',archived:'no'}),0);return()=>{clearTimeout(timer);request.current?.abort();saveRequest.current?.abort();};},[load]);
 function search(offset=0){void load(offset===0?filters:applied,offset);}
 async function save(c:Case,tags:string[],archived:boolean){
  if(saving)return;if(tags.length>20||tags.some(t=>t.length>40)){setError('最多 20 个标签，每个不超过 40 字');return;}
  setSaving(true);setError('');setFeedback('');const controller=new AbortController();saveRequest.current=controller;
  try{const r=await fetch('/api/case-search',{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({caseId:c.caseId,tags,archived})});if(!r.ok)throw Error();if(controller.signal.aborted)return;setFeedback(`${c.name}：标签与归档已保存`);await load(latest.current.filters,0);}
  catch{if(!controller.signal.aborted)setError('保存失败，标签与归档未确认更新，请重试');}finally{if(!controller.signal.aborted)setSaving(false);}
 }
 function open(hit:Hit){try{sessionStorage.setItem('truthtrace.pending-locator.v1',JSON.stringify({caseId:hit.caseId,evidenceId:hit.evidenceId,version:hit.version,segmentId:hit.id,start:hit.start,end:hit.end}));}catch{setError('浏览器无法保存定位信息，请打开案件后查找对应原文');}onOpenCase(hit.caseId);}
 const selected=data?.cases.find(c=>c.caseId===filters.caseId);
 const commitments=(data?.commitments||[]).filter(c=>(!filters.caseId||c.caseId===filters.caseId)&&(state==='all'||state==='due'&&c.dueForReview||c.state===state)).sort((a,b)=>(a.dueAt||'9999').localeCompare(b.dueAt||'9999'));
 return <section aria-label="案件搜索与承诺追踪" className={styles.panel}>
 <details className={styles.drawer}><summary className={styles.entry}><span><strong>案件工具</strong><small>跨案件查找原文，查看承诺进展</small></span><span className={styles.toggle}>展开 / 收起</span></summary><div className={styles.body} aria-busy={busy}>
 <nav aria-label="案件工具"><button type="button" aria-pressed={view==='search'} onClick={()=>setView('search')}>跨案件搜索</button> <button type="button" aria-pressed={view==='commitments'} onClick={()=>setView('commitments')}>承诺追踪</button></nav>
 {busy&&!data&&<p role="status">正在读取案件与承诺记录…</p>}<label className={styles.caseField}>案件 <select aria-label="案件" value={filters.caseId} onChange={e=>setFilters({...filters,caseId:e.target.value,personId:''})}><option value="">全部案件</option>{data?.cases.map(c=><option key={c.caseId} value={c.caseId}>{c.name}</option>)}</select></label>
 {view==='search'?<><form onSubmit={e=>{e.preventDefault();void search();}} className={styles.filters}>
 <label>关键词 <input value={filters.q} maxLength={200} onChange={e=>setFilters({...filters,q:e.target.value})}/></label>
 <label>来源 <input value={filters.source} onChange={e=>setFilters({...filters,source:e.target.value})}/></label>
 <label>起始日期 <input type="date" value={filters.from} onChange={e=>setFilters({...filters,from:e.target.value})}/></label><label>截止日期 <input type="date" value={filters.to} onChange={e=>setFilters({...filters,to:e.target.value})}/></label>
 <label>人物候选 <select aria-label="人物候选" value={filters.personId} disabled={!selected} onChange={e=>setFilters({...filters,personId:e.target.value})}><option value="">全部候选</option>{selected?.people.map(p=><option key={p.id} value={p.id}>{p.name}（候选）</option>)}</select></label>
 <label>标签 <input value={filters.tag} onChange={e=>setFilters({...filters,tag:e.target.value})}/></label><label>归档 <select aria-label="归档" value={filters.archived} onChange={e=>setFilters({...filters,archived:e.target.value})}><option value="no">未归档</option><option value="yes">已归档</option><option value="all">全部</option></select></label>
 <button className={styles.primary} disabled={busy}>{busy?'检索中…':'搜索'}</button><button type="button" disabled={busy} onClick={()=>{setFilters(defaults);void load(defaults);}}>清除筛选</button></form>
 {selected&&<details className={styles.manage}><summary>管理当前案件标签与归档</summary><form onSubmit={e=>{e.preventDefault();const fd=new FormData(e.currentTarget);void save(selected,String(fd.get('tags')||'').split(',').map(s=>s.trim()).filter(Boolean),fd.get('archived')==='on');}} key={selected.caseId+selected.tags.join(',')+selected.archived}><label>标签（逗号分隔）<input name="tags" defaultValue={selected.tags.join(',')}/></label><label><input name="archived" type="checkbox" defaultChecked={selected.archived}/>归档</label><button disabled={saving}>{saving?'保存中…':'保存'}</button></form></details>}
 <div className={styles.resultHeader}><strong>{busy?'正在查找材料…':data?`${data.total} 条匹配`:'等待检索'}</strong><span>{data&&data.total>0?`第 ${Math.floor(pageOffset/20)+1} 页`:''}</span></div><p className={styles.help}>{data?.note||'选择案件或输入关键词，查找有来源的原文。'}</p>{dirty&&<p className={styles.notice}>筛选条件已修改，点击“搜索”应用；下方仍为上次检索结果。</p>}{!busy&&!error&&data&&!data.hits.length&&<div className={styles.empty}><strong>{data.cases.length?'没有符合条件的材料':'还没有保存的案件'}</strong><p>{data.cases.length?'试试更短的关键词，或清除日期与标签筛选。':'从首页导入材料后，即可在这里查找原文。'}</p></div>}{data?.hits.map(hit=><article key={hit.caseId+hit.id} className={styles.result}><strong>{hit.caseName} · {hit.evidenceName}</strong><small> {hit.source||'来源未注明'} · v{hit.version} · 未做事实核实</small><blockquote className={styles.quote}>{hit.content}</blockquote><button onClick={()=>open(hit)}>打开案件并定位原文</button></article>)}{pageOffset>0&&<button disabled={busy||dirty} onClick={()=>void search(Math.max(0,pageOffset-20))}>上一页</button>}{data?.nextOffset!==null&&data?.nextOffset!==undefined&&<button disabled={busy||dirty} onClick={()=>void search(data.nextOffset!)}>下一页</button>}</>:<><label>承诺状态 <select aria-label="承诺状态" value={state} onChange={e=>setState(e.target.value)}><option value="all">全部</option><option value="due">到期待核查</option><option value="fulfilled">已履行</option><option value="pending">待履行</option><option value="disputed">履行存疑</option><option value="unknown">尚未明确</option></select></label><p>到期不等于违约；缺少确定日期不计算倒计时。</p>{commitments.map(c=><article key={c.caseId+':'+c.id}><strong>{c.caseName} · {c.text}</strong><p>{c.dueLabel} · 需要核查</p><button onClick={()=>c.caseId&&onOpenCase(c.caseId)}>打开案件核查来源</button></article>)}{!busy&&!commitments.length&&<div className={styles.empty}><strong>当前筛选没有承诺。</strong><p>调整案件或状态筛选，或打开案件核对材料。</p></div>}</>}
 {feedback&&<p className={styles.feedback} role="status">{feedback}</p>}{error&&<div className={styles.error} role="alert"><p>{error}</p><button onClick={()=>void load(latest.current.filters,latest.current.offset)} disabled={busy}>重试检索</button></div>}
 </div></details>
 </section>;
}
