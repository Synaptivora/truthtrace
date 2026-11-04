"use client";
import {useState} from "react";
import type {CaseAnalysis} from "../api-client";
import {commitmentProjection} from "@/lib/commitments";
export function CommitmentPanel({result,onOpen,onReview}:{result:CaseAnalysis;onOpen:(id:string)=>void;onReview:()=>void}) {
 const [filter,setFilter]=useState("all");
 const rows=commitmentProjection(result).filter(row=>filter==="all"||filter==="due"&&row.dueForReview||filter===row.state).sort((a,b)=>(a.dueAt||"9999").localeCompare(b.dueAt||"9999"));
 return <section aria-label="承诺追踪"><h2>承诺追踪</h2><p>到期只提示需要核查，不代表违约；未发现付款记录不代表未付款。</p><label>筛选承诺<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部</option><option value="due">已到明确期限，需核查</option>{["fulfilled","pending","disputed","unknown"].map((s,i)=><option key={s} value={s}>{["记录为已履行","待履行","有争议","状态未知"][i]}</option>)}</select></label><button onClick={onReview}>重新核查材料</button>{!rows.length&&<p>没有符合筛选条件的承诺。</p>}{rows.map(row=><article key={row.id}><h3>{row.text}</h3><p>{row.dueLabel} · {row.dueAt?`明确时间：${row.dueAt}`:"时间精度或时区不足，不计算倒计时"} · 需要核查</p>{row.sourceRefs.map((ref,i)=><button key={i} title={ref.quote} onClick={()=>onOpen(ref.evidenceId)}>来源 {ref.evidenceId}</button>)}</article>)}</section>;
}
