"use client";
import Image from "next/image";
import { useEffect, useState } from "react";
import { skillNames, skillLabels, investigationModes, suggestMode, taskStages, type InvestigationMode, type Task } from "@/lib/investigator/contracts";
import type { CaseAnalysis } from "./api-client";

async function call(url:string,body?:unknown){const r=await fetch(url,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:undefined);const data=await r.json();if(!r.ok)throw new Error(data.error||"请求失败");return data;}
const terms:Record<string,string>={statement:"原文陈述",observation:"材料观察",inference:"推断",supported:"原文支持",partially_supported:"部分支持",disputed:"存在争议",insufficient:"证据不足",accepted:"已采纳",rejected:"已驳回",modified:"已修改",unverified:"待核实"};
const states:Record<string,string>={queued:"等待后台执行",running:"调查中",waiting_user:"等待你的判断",paused:"已暂停",completed:"报告已生成",failed:"执行失败",cancelled:"已取消"};
export function InvestigatorPanel({context}:{context:CaseAnalysis}) {
  const [open,setOpen]=useState(false),[goal,setGoal]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const [task,setTask]=useState<Task|null>(null),[source,setSource]=useState<string|null>(null);
  const [allowImages,setAllowImages]=useState(false);
  const [mode,setMode]=useState<InvestigationMode | "auto">("auto");
  const selectedMode=mode==="auto"?suggestMode(goal):mode;
  const stages=taskStages(task?.mode);
  const completed=task?stages.filter(stage=>stage<task.step).length:0;
  const gaps=task?[...new Set([...(task.collectionNotes||[]),...task.artifacts.flatMap(a=>a.gaps)])]:[];
  const [channel,setChannel]=useState(""),[conversationIds,setConversationIds]=useState(""),[startTime,setStartTime]=useState(""),[endTime,setEndTime]=useState("");
  const [reasons,setReasons]=useState<Record<string,string>>({});
  useEffect(()=>{if(!context.caseId)return;let active=true;const refresh=()=>call(`/api/cases/${context.caseId}/investigations`).then(d=>{if(active)setTask(d.tasks[0]||null);}).catch(e=>{if(active)setError(e.message);});void refresh();const timer=setInterval(refresh,2000);return()=>{active=false;clearInterval(timer);};},[context.caseId]);
  async function act(action:string){if(!task)return;setBusy(true);setError("");try{const d=await call(`/api/investigations/${task.id}/actions`,{action,...(action==="revise"&&goal.trim()?{goal}:{})});setTask(d.task);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function start(){setBusy(true);setError("");try{const saved=await call("/api/cases",context);const d=await call(`/api/cases/${saved.case.caseId}/investigations`,{goal,mode:selectedMode,idempotencyKey:crypto.randomUUID(),scope:{allowImages,sources:channel?[{source:channel,conversationIds:conversationIds.split(",").map(s=>s.trim()).filter(Boolean),start:startTime,end:endTime}]:[]}});setTask(d.task);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function decide(id:string,value:string){if(!task)return;setError("");try{const d=await call(`/api/investigations/${task.id}/decisions`,{id,value,reason:reasons[id]||""});setTask(d.task);}catch(e){setError((e as Error).message);}}
  const hasNewEvidence=task && context.evidence.some(e=>task.snapshot.filter(s=>s.evidenceId===e.id).map(s=>s.content).join("")!==e.content);
  return <div className="investigator"><button className="investigator-launch" onClick={()=>setOpen(!open)} aria-expanded={open}>自主调查</button>{open&&<section aria-label="自主调查" className="investigator-panel">
    <header><div><small>从问题到依据</small><h2>{task&&["completed","waiting_user"].includes(task.state)?"这次查到了什么？":task?.state==="running"?"正在核对你的问题":"这次想查清什么？"}</h2></div><button onClick={()=>setOpen(false)} aria-label="关闭自主调查">关闭</button></header>
    <p>围绕你的目标阅读本案材料，保留原文出处，并说明还缺什么。当前有 {context.evidence.length} 份材料。</p>
    <details key={task?.id || "new"} className="investigator-setup" open={!task}><summary>{task?"调整目标或开始下一次调查":"设置本次调查"}</summary>{task&&<p className="investigator-privacy">修订会沿用原调查方式。若要更换方式，请在当前任务结束后开始新调查。</p>}<label>调查目标<textarea value={goal} onChange={e=>setGoal(e.target.value)} maxLength={4000} placeholder="例如：梳理退款承诺、实际付款和仍需确认的事项"/></label>
    <div className="investigator-examples" aria-label="试试这些目标">{["核查是否有明确的退款日期", "梳理退款承诺与付款的时间线", "对照各方说法，找出矛盾与其他解释"].map(example=><button key={example} type="button" onClick={()=>setGoal(example)}>{example}</button>)}</div>
    <label>调查方式<select aria-label="调查方式" value={mode} onChange={e=>setMode(e.target.value as InvestigationMode | "auto")}><option value="auto">根据目标推荐</option>{Object.entries(investigationModes).map(([key,value])=><option key={key} value={key}>{value.label}</option>)}</select></label>
    <p className="investigator-route"><strong>{investigationModes[selectedMode].label}</strong> · {taskStages(selectedMode).length} 个步骤<br/>{investigationModes[selectedMode].description} 可手动切换；开始后按此方式执行。</p>
    <p className="investigator-privacy">本案材料将发送给已配置的调查模型。默认不发送原图，也不读取其他会话。</p>
    <label><input type="checkbox" checked={allowImages} onChange={e=>setAllowImages(e.target.checked)}/>允许将原图发送给模型（需视觉能力）</label>
    <details><summary>补充读取已连接渠道（可选）</summary><label>渠道<select value={channel} onChange={e=>setChannel(e.target.value)}><option value="">仅本案材料</option><option value="wechat">微信</option><option value="dingtalk">钉钉</option><option value="feishu">飞书</option></select></label>{channel&&<><label>会话 ID（从渠道目录获取，逗号分隔）<input value={conversationIds} onChange={e=>setConversationIds(e.target.value)}/></label><label>开始时间<input type="datetime-local" value={startTime} onChange={e=>setStartTime(e.target.value)}/></label><label>结束时间<input type="datetime-local" value={endTime} onChange={e=>setEndTime(e.target.value)}/></label><p>渠道必须已在本地授权。失败时会保留任务，不会扩大取数范围。</p></>}</details>
    <button disabled={busy||!goal.trim()||!!task&&!["completed","cancelled"].includes(task.state)} onClick={()=>void start()}>开始调查</button></details>
    {error&&<p role="alert">{error}</p>}
    {task&&<><h3>{states[task.state]} · {completed}/{stages.length}</h3><p>{task.goal}</p>{task.model&&<p>当前调查模型：{task.model.provider} · {task.model.name}</p>}{hasNewEvidence&&<p role="status">有新材料可纳入。先暂停当前调查，再点击“纳入新材料／修订目标”。</p>}<p>{task.error}</p>{task.state==="queued"&&<p>任务已保存，正在等待调查服务接手。关闭网页不会丢失进度；若长时间未开始，请检查本机调查服务。</p>}
      <p>本次方式：{investigationModes[task.mode || "deep"].label}</p><progress aria-label="调查进度" value={completed} max={stages.length}/><details open={task.state==="running"||task.state==="queued"}><summary>处理步骤 · {completed}/{stages.length}</summary><ol className="investigator-steps">{stages.map(i=><li key={skillNames[i]} data-state={i<task.step?"done":i===task.step?"current":"pending"}>{i<task.step?"✓ ":i===task.step?"→ ":""}{skillLabels[i]}</li>)}</ol></details>
      <div className="investigator-actions">
        {["queued","running","waiting_user"].includes(task.state)&&<button disabled={busy} onClick={()=>void act("pause")}>暂停</button>}
        {["paused","failed","waiting_user"].includes(task.state)&&<button disabled={busy} onClick={()=>void act("resume")}>继续</button>}
        {task.state!=="running"&&<button disabled={busy} onClick={()=>void act("revise")}>纳入新材料／修订目标</button>}
        {!["completed","cancelled"].includes(task.state)&&<button disabled={busy} onClick={()=>void act("cancel")}>取消</button>}
        {["completed","waiting_user"].includes(task.state)&&<a href={`/api/investigations/${task.id}/report`}>导出报告草稿</a>}
      </div>
      {task.state==="completed"&&<div className="investigator-result" role="status"><strong>{gaps.length?"结果已整理，还有待补充的依据":"结果已整理，可以核对原文"}</strong><p>{gaps.length?`有 ${gaps.length} 项证据缺口或覆盖限制。先核对下方主张，再补充材料继续。`:"查看主张的支持状态与引用，再决定是否采用。"}</p></div>}{task.artifacts.flatMap(a=>a.decisions).map(d=><article key={d.id}><strong>{d.question}</strong><p>用户决定与证据支持状态分别保存。</p><input aria-label="决定理由" value={reasons[d.id]||""} onChange={e=>setReasons({...reasons,[d.id]:e.target.value})} placeholder="填写判断和理由"/>{[["accepted","采纳"],["rejected","驳回"],["modified","修改"],["unverified","待核实"]].map(([value,label])=><button key={value} disabled={task.state==="running"||!reasons[d.id]?.trim()} onClick={()=>void decide(d.id,value)}>{label}</button>)}{task.decisions.filter(v=>v.id===d.id).map((v,i)=><p key={i}>{terms[v.value]||v.value}：{v.reason}</p>)}</article>)}
      {task.artifacts.flatMap(a=>a.claims).map(c=><article key={c.id}><strong>{c.id} · {c.content}</strong><p>{terms[c.kind]||c.kind} · {terms[task.artifacts.flatMap(a=>a.checks).find(v=>v.claimId===c.id)?.status||""]||"待核查"}</p>{c.refs.map((ref,i)=><button key={i} onClick={()=>setSource(ref.segmentId)}>查看原文：{ref.quote.slice(0,60)}</button>)}</article>)}
      {([["people","人物候选"],["relationships","关系"],["events","时间线"],["commitments","承诺"],["conflicts","潜在矛盾"]] as const).filter(([key])=>task.artifacts.some(a=>a[key].length)).map(([key,title])=><details key={key}><summary>{title}</summary>{task.artifacts.flatMap(a=>a[key]).map(f=><article key={f.id}><strong>{f.content}</strong><p>{f.time} · 依据：{f.claimIds.join("、")}</p>{f.alternatives.map((v,i)=><p key={i}>其他解释：{v}</p>)}</article>)}</details>)}
      <details><summary>证据缺口与覆盖限制</summary>{gaps.map((g,i)=><p key={i}>{g}</p>)}<p>共 {task.snapshot.length} 个片段，已读取 {task.reads.length} 个。未检出不等于不存在。</p></details>
      {source&&<article><button onClick={()=>setSource(null)}>关闭原文</button><p>{source}（字符片段定位）</p>{task.snapshot.find(s=>s.id===source)?.kind==="image"?<Image src={task.snapshot.find(s=>s.id===source)!.content} alt="引用原图" width={600} height={400} unoptimized style={{width:"100%",height:"auto"}}/>:<pre>{task.snapshot.find(s=>s.id===source)?.content}</pre>}</article>}
    </>}
  </section>}</div>;
}

