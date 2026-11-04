"use client";
import {useEffect,useState} from 'react';
import type {CommitmentProjection} from '@/lib/commitments';
type Case={caseId:string;name:string;tags:string[];archived:boolean;people:{id:string;name:string}[]};
type Hit={caseId:string;caseName:string;evidenceId:string;evidenceName:string;version:number;id:string;start:number;end:number;content:string;source:string};
type Result={cases:Case[];hits:Hit[];total:number;nextOffset:number|null;note:string;commitments:CommitmentProjection[]};
export function CaseSearch({onOpenCase}:{onOpenCase:(id:string)=>void}){
 const [pageOffset,setPageOffset]=useState(0);
 const [data,setData]=useState<Result|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[view,setView]=useState('search'),[state,setState]=useState('all');
 const [filters,setFilters]=useState({q:'',caseId:'',source:'',from:'',to:'',personId:'',tag:'',archived:'no'});
 async function search(offset=0){setBusy(true);setError('');try{const params=new URLSearchParams(Object.entries(filters).filter(([,v])=>v));params.set('offset',String(offset));const response=await fetch(`/api/case-search?${params}`);const result=await response.json();if(!response.ok)throw Error('检索失败，请缩小范围或检查筛选条件');setData(result);setPageOffset(offset);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 useEffect(()=>{let active=true;const abort=new AbortController();fetch('/api/case-search',{signal:abort.signal}).then(r=>{if(!r.ok)throw Error('读取案件检索失败');return r.json();}).then(r=>{if(active)setData(r);}).catch(()=>{if(active)setError('读取案件检索失败');});return()=>{active=false;abort.abort();};},[]);
 async function save(c:Case,tags:string[],archived:boolean){setError('');try{const r=await fetch('/api/case-search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caseId:c.caseId,tags,archived})});if(!r.ok)throw Error('保存失败');await search();}catch{setError('标签或归档保存失败');}}
 function open(hit:Hit){try{sessionStorage.setItem('truthtrace.pending-locator.v1',JSON.stringify({caseId:hit.caseId,evidenceId:hit.evidenceId,version:hit.version,segmentId:hit.id,start:hit.start,end:hit.end}));}catch{setError('浏览器无法保存定位信息，请打开案件后查找对应原文');}onOpenCase(hit.caseId);}
 const selected=data?.cases.find(c=>c.caseId===filters.caseId);
 const commitments=(data?.commitments||[]).filter(c=>(!filters.caseId||c.caseId===filters.caseId)&&(state==='all'||state==='due'&&c.dueForReview||c.state===state)).sort((a,b)=>(a.dueAt||'9999').localeCompare(b.dueAt||'9999'));
 return <section aria-label="案件搜索与承诺追踪" style={{background:'#fffdf7',padding:20,border:'1px solid #cfc6b4',borderRadius:12,margin:'20px 0'}}>
 <nav><button type="button" onClick={()=>setView('search')}>跨案件搜索</button> <button type="button" onClick={()=>setView('commitments')}>承诺追踪</button></nav>
 <label>案件 <select value={filters.caseId} onChange={e=>setFilters({...filters,caseId:e.target.value,personId:''})}><option value="">全部案件</option>{data?.cases.map(c=><option key={c.caseId} value={c.caseId}>{c.name}</option>)}</select></label>
 {view==='search'?<><form onSubmit={e=>{e.preventDefault();void search();}} style={{display:'flex',flexWrap:'wrap',gap:10,margin:'12px 0'}}>
 <label>关键词 <input value={filters.q} maxLength={200} onChange={e=>setFilters({...filters,q:e.target.value})}/></label>
 <label>来源 <input value={filters.source} onChange={e=>setFilters({...filters,source:e.target.value})}/></label>
 <label>起始日期 <input type="date" value={filters.from} onChange={e=>setFilters({...filters,from:e.target.value})}/></label><label>截止日期 <input type="date" value={filters.to} onChange={e=>setFilters({...filters,to:e.target.value})}/></label>
 <label>人物候选 <select value={filters.personId} disabled={!selected} onChange={e=>setFilters({...filters,personId:e.target.value})}><option value="">全部候选</option>{selected?.people.map(p=><option key={p.id} value={p.id}>{p.name}（候选）</option>)}</select></label>
 <label>标签 <input value={filters.tag} onChange={e=>setFilters({...filters,tag:e.target.value})}/></label><label>归档 <select value={filters.archived} onChange={e=>setFilters({...filters,archived:e.target.value})}><option value="no">未归档</option><option value="yes">已归档</option><option value="all">全部</option></select></label>
 <button disabled={busy}>{busy?'检索中…':'搜索'}</button></form>
 {selected&&<details><summary>管理当前案件标签与归档</summary><form onSubmit={e=>{e.preventDefault();const fd=new FormData(e.currentTarget);void save(selected,String(fd.get('tags')||'').split(',').map(s=>s.trim()).filter(Boolean),fd.get('archived')==='on');}} key={selected.caseId+selected.tags.join(',')+selected.archived}><label>标签（逗号分隔）<input name="tags" defaultValue={selected.tags.join(',')}/></label><label><input name="archived" type="checkbox" defaultChecked={selected.archived}/>归档</label><button>保存</button></form></details>}
 <p>{data?.note} 共 {data?.total||0} 条匹配。</p>{data?.hits.map(hit=><article key={hit.caseId+hit.id} style={{borderTop:'1px solid #ddd',padding:12}}><strong>{hit.caseName} · {hit.evidenceName}</strong><small> {hit.source||'来源未注明'} · v{hit.version} · 未做事实核实</small><blockquote style={{whiteSpace:'pre-wrap'}}>{hit.content}</blockquote><button onClick={()=>open(hit)}>打开案件并定位原文</button></article>)}{pageOffset>0&&<button disabled={busy} onClick={()=>void search(Math.max(0,pageOffset-20))}>上一页</button>}{data?.nextOffset!==null&&data?.nextOffset!==undefined&&<button disabled={busy} onClick={()=>void search(data.nextOffset!)}>下一页</button>}</>:<><label>承诺状态 <select value={state} onChange={e=>setState(e.target.value)}><option value="all">全部</option><option value="due">到期待核查</option><option value="fulfilled">已履行</option><option value="pending">待履行</option><option value="disputed">履行存疑</option><option value="unknown">尚未明确</option></select></label><p>到期不等于违约；缺少确定日期不计算倒计时。</p>{commitments.map(c=><article key={c.caseId+':'+c.id}><strong>{c.caseName} · {c.text}</strong><p>{c.dueLabel} · 需要核查</p><button onClick={()=>c.caseId&&onOpenCase(c.caseId)}>打开案件核查来源</button></article>)}{!commitments.length&&<p>当前筛选没有承诺。</p>}</>}
 {error&&<p role="alert">{error}</p>}
 </section>;
}
