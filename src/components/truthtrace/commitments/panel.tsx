"use client";
import {useState} from "react";
import type {EvidenceRef} from "@/lib/contracts";
import type {CaseAnalysis} from "../api-client";
import {commitmentProjection} from "@/lib/commitments";
import styles from './panel.module.css';
const labels={fulfilled:'记录为已履行',pending:'待履行',disputed:'履行存疑',unknown:'状态未知'};
export function CommitmentPanel({result,onOpenReference,onReview,reviewing=false}:{result:CaseAnalysis;onOpenReference:(ref:EvidenceRef)=>void;onReview:()=>void;reviewing?:boolean}) {
 const [filter,setFilter]=useState("all");
 const all=commitmentProjection(result);
 const rows=all.filter(row=>filter==="all"||filter==="due"&&row.dueForReview||filter===row.state).sort((a,b)=>(a.dueAt||"9999").localeCompare(b.dueAt||"9999"));
 return <section aria-label="承诺追踪" className={styles.panel} aria-busy={reviewing}>
 <header className={styles.heading}><div><h2>承诺追踪</h2><p>从原文承诺出发，逐项核对履行依据。</p></div><span className={styles.count}>{all.length} 项记录</span></header>
 <div className={styles.toolbar}><label>筛选承诺<select aria-label="筛选承诺" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部承诺</option><option value="due">已到明确期限，需核查</option>{Object.entries(labels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><button className={styles.primary} disabled={reviewing} onClick={onReview}>{reviewing?'正在重新核查…':'重新核查材料'}</button></div>
 <p className={styles.boundary}>到期只提示需要核查，不代表违约；未发现付款记录不代表未付款。</p>
 {reviewing&&<p role="status" className={styles.progress}>正在核对材料，现有承诺记录会保留。</p>}
 {!rows.length&&<div className={styles.empty}><strong>{all.length?'没有符合筛选条件的承诺':'尚未提取到明确承诺'}</strong><p>{all.length?'调整状态筛选，查看其他记录。':'可补充相关聊天或凭据，再重新核查材料。'}</p></div>}
 <div className={styles.list}>{rows.map(row=><article key={row.id} className={styles.card}><div className={styles.cardTop}><span className={styles.badge}>{labels[row.state]}</span>{row.dueForReview&&<span className={styles.reviewBadge}>到期待核查</span>}</div><h3>{row.text}</h3><dl><div><dt>原文期限</dt><dd>{row.dueLabel}</dd></div><div><dt>时间依据</dt><dd>{row.dueAt?new Date(row.dueAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':'时间精度或时区不足，不计算倒计时'}</dd></div></dl><div className={styles.sources}><span>核对来源</span>{row.sourceRefs.map((ref,i)=><button key={i} title={ref.quote} onClick={()=>onOpenReference(ref)}>{result.evidence.find(e=>e.id===ref.evidenceId)?.name||ref.evidenceId} · {ref.provenance?`v${ref.provenance.version}`:'旧引用，版本待核对'}</button>)}</div></article>)}</div>
 </section>;
}
