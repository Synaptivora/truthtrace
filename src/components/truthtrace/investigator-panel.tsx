"use client";
import ui from "./investigator-ui.module.css";
import {currentClaimCheck} from "@/lib/investigator/plan";
import Image from "next/image";
import { Settings } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { skillNames, skillLabels, investigationModes, suggestMode, taskStages, type InvestigationMode, type Task } from "@/lib/investigator/contracts";
import type { CaseAnalysis } from "./api-client";
import type { ChannelId } from "./channel-import";

async function call(url:string,body?:unknown){const r=await fetch(url,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:undefined);const data=await r.json();if(!r.ok)throw new Error(data.error||"请求失败");return data;}
const terms:Record<string,string>={statement:"原文陈述",observation:"材料观察",inference:"推断",supported:"原文支持",partially_supported:"部分支持",disputed:"存在争议",insufficient:"证据不足"};
const states:Record<string,string>={queued:"正在准备调查",running:"正在核对材料",waiting_user:"有一个问题需要你确认",paused:"进度已保留",completed:"调查结果",failed:"遇到了问题，进度已保留",cancelled:"已结束本次调查"};
type Props={context:CaseAnalysis;initialGoal?:string;routedMode?:InvestigationMode;onGoalChange:(goal:string)=>void;onConfigure:(goal:string)=>void;onSupplement:(channel?:ChannelId,goal?:string)=>void};
export function InvestigatorPanel({context,initialGoal,routedMode,onGoalChange,onConfigure,onSupplement}:Props) {
  const [goal,setGoal]=useState(initialGoal||context.goal||""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  const latestSummary=useRef("");
  const [loading,setLoading]=useState(true),[refreshError,setRefreshError]=useState("");
  const [refreshKey,setRefreshKey]=useState(0);
  const sourcePanel=useRef<HTMLElement>(null);
  const [task,setTask]=useState<Task|null>(null),[source,setSource]=useState<string|null>(null);
  const [allowImages,setAllowImages]=useState(false),[mode,setMode]=useState<InvestigationMode|"auto">("auto");
  const [health,setHealth]=useState<{model:boolean;worker:boolean}|null>(null);
  const [reasons,setReasons]=useState<Record<string,string>>({});
  useEffect(()=>{const timer=setTimeout(()=>{if(initialGoal)setGoal(initialGoal);},0);return()=>clearTimeout(timer);},[initialGoal]);
  useEffect(()=>{let active=true;const refresh=async()=>{try{const [d,h]=await Promise.all([call(`/api/cases/${context.caseId}/investigations?view=summary`),call("/api/assistant/service")]);if(active){const summary=d.tasks[0];const signature=JSON.stringify(summary);if(signature!==latestSummary.current){const detail=summary?await call(`/api/investigations/${summary.id}`):null;if(active){setTask(detail?.task||null);latestSummary.current=signature;}}setHealth(h);setRefreshError("");}}catch(e){if(active)setRefreshError((e as Error).message);}finally{if(active)setLoading(false);}};void refresh();const timer=setInterval(refresh,2000);return()=>{active=false;clearInterval(timer);};},[context.caseId,refreshKey]);
  useEffect(()=>{if(source){sourcePanel.current?.focus();sourcePanel.current?.scrollIntoView({block:"nearest"});}},[source]);
  const selectedMode=mode==="auto"?(goal===initialGoal&&routedMode?routedMode:suggestMode(goal)):mode;
  const stages=taskStages(task?.mode);
  const stageDone=(stage:number)=>task?.executionPlan?task.executionPlan.nodes.findLast(n=>n.stage===stage)?.status==="completed":!!task&&stage<task.step;
  const completed=stages.filter(stageDone).length;
  const gaps=task?[...new Set([...(task.collectionNotes||[]),...task.artifacts.flatMap(a=>a.gaps)])]:[];
  const claims=task?.artifacts.flatMap(a=>a.claims)||[];
  const answer=task?.artifacts.findLast(a=>a.answer)?.answer;
  const hasNewEvidence=task&&context.evidence.some(e=>task.snapshot.filter(s=>s.evidenceId===e.id).map(s=>s.content).join("")!==e.content);
  async function prepare(){const h=await call("/api/assistant/service");setHealth(h);if(!h.model){onConfigure(goal);throw new Error("目标已保留。连接支持材料检索的模型后，即可继续。");}if(!h.worker)setHealth(await call("/api/assistant/service",{}));}
  async function act(action:string){if(!task)return;setBusy(true);setError("");try{if(action==="resume"||action==="revise")await prepare();if(action==="revise")await call("/api/cases",context);const d=await call(`/api/investigations/${task.id}/actions`,{action,...(action==="revise"&&goal.trim()?{goal}:{})});setTask(d.task);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function start(){setBusy(true);setError("");try{await prepare();const saved=await call("/api/cases",{...context,goal});const d=await call(`/api/cases/${saved.case.caseId}/investigations`,{goal,mode:selectedMode,idempotencyKey:crypto.randomUUID(),scope:{allowImages,sources:[]}});setTask(d.task);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function decide(id:string,unknown=false){if(!task)return;setBusy(true);setError("");try{await prepare();const d=await call(`/api/investigations/${task.id}/decisions`,{id,value:unknown?"unverified":"modified",reason:unknown?"目前无法确认，请保留不确定性。":reasons[id]||""});setTask(d.task);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const capped=task?.executionOutcome==="insufficient"&&task.step>=8;
  const staleCount=task?.executionPlan?.staleResultIds.length??0;
  const finished=task&&["completed","waiting_user"].includes(task.state);
  return <section aria-label="本次调查" className={`investigator-panel investigator-embedded ${ui.panel}`}>
    <header><div><small>本案调查 · 有来源，可复核</small><h2>{finished?"查到了什么，还缺什么":task?.state==="running"?"我正在核对你的问题":"先确认这次要查清的问题"}</h2></div><button onClick={()=>onConfigure(goal)}><Settings size={15} />模型设置</button></header>
    {loading&&<div className={ui.notice} role="status">正在恢复本案调查进度…</div>}
    {refreshError&&<div className={ui.warning} role="alert"><strong>暂时无法更新调查进度</strong><p>{refreshError} 已保存的内容仍会保留。</p><button disabled={busy} onClick={()=>setRefreshKey(v=>v+1)}>重新加载进度</button></div>}
    {!loading&&!task&&!context.evidence.length&&<div className={ui.notice}><strong>先添加与问题有关的材料</strong><p>可以上传聊天记录、截图或文件，之后再核对其中的说法。</p><button onClick={()=>onSupplement(undefined,goal)}>添加本案材料</button></div>}
    <details className={ui.setup} key={task?.id||"new"} open={!task}><summary>{task?"调整目标或开始新调查":"本次目标与范围"}</summary>
      <label>调查目标<textarea aria-label="调查目标" value={goal} onChange={e=>{setGoal(e.target.value);onGoalChange(e.target.value);}} maxLength={4000} placeholder="例如：退款承诺与实际到账是否一致？"/></label>
      <p className="investigator-route">{investigationModes[selectedMode].description} 只使用本案已选材料。</p>
      <details><summary>调整调查范围（可选）</summary><label>调查方式<select aria-label="调查方式" value={mode} onChange={e=>setMode(e.target.value as InvestigationMode|"auto")}><option value="auto">由助手安排</option>{Object.entries(investigationModes).map(([key,value])=><option key={key} value={key}>{value.label}</option>)}</select></label><p>当前调查方式不会因修改此选项而改变；新方式用于下一次调查。</p><label><input type="checkbox" checked={allowImages} onChange={e=>setAllowImages(e.target.checked)}/>允许模型查看原图（需视觉能力）</label></details>
      <p className="investigator-privacy">开始后，选定材料会发送给调查模型。你可以随时停止；没有选中的会话不会自动加入。</p>
      {task?.stale&&<p role="status">材料已更新，本报告基于旧版本。请重新核查后使用结论。</p>}<div className="investigator-actions"><button onClick={()=>onSupplement(undefined,goal)}>补充文件或截图</button><button onClick={()=>onSupplement("dingtalk",goal)}>选择钉钉会话</button><button onClick={()=>onSupplement("wechat",goal)}>选择微信会话</button></div>
      <button className={ui.primary} disabled={busy||loading||!goal.trim()||!context.evidence.length||!!task&&!["completed","cancelled"].includes(task.state)} onClick={()=>void start()}>{busy?"正在准备…":"开始核查"}</button>
    </details>
    {health&&!health.model&&<div role="status"><p>还差模型连接，目标和材料已保留。</p><button onClick={()=>onConfigure(goal)}>连接模型并继续</button></div>}
    {health&&!health.worker&&<div role="status"><p>调查服务尚未运行，开始时会自动准备。</p><button disabled={busy} onClick={()=>{setBusy(true);void call("/api/assistant/service",{}).then(setHealth).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>启动调查服务</button></div>}
    {error&&<p className={ui.warning} role="alert">{error}</p>}
    {task&&<><section className={ui.statusCard} aria-label="调查状态概览"><div className={ui.statusHeading}><span className={ui.badge} role="status">{capped?"需要补充依据或调整目标":states[task.state]}</span><small>修订 {task.revision}</small></div><p className={ui.goal}>{task.goal}</p><div className={ui.metrics}><span><strong>{task.reads.length}/{task.snapshot.length}</strong>片段已读取</span><span><strong>{task.executionPlan?.replans??0}/{task.executionPlan?.maxReplans??2}</strong>轮反证复核</span><span><strong>{staleCount}</strong>项待重新核查</span></div><p className={ui.hint}>已读取不等于已证实；发现反证后，相关旧结论会先标为待复核。</p></section>{task.error&&<p className={ui.warning} role="alert">{task.error}</p>}
      {(task.executionPlan?.replans??0)>0&&<div className={ui.replan}><strong>{capped?"已达到本轮自动复核上限":"正在跟进反证"}</strong><p>{task.executionPlan?.requests.at(-1)?.reason}</p>{capped&&<p>原依据与进度已保存。请补充材料或调整目标，再开始新的修订。</p>}</div>}
      {hasNewEvidence&&<p className={ui.notice}>发现新材料。<button disabled={busy} onClick={()=>void act("revise")}>加入新材料，继续核查</button></p>}
      {finished&&<div className="investigator-result"><h3>对这个问题的回答</h3>{answer?<><p>{answer.text}</p><small>依据：{answer.claimIds.join("、")}，原文见下方。</small></>:<p>{claims.length?"已核对以下说法；这些依据尚不足以自动给出完整结论，请结合支持状态与原文判断。":"现有材料不足以支持结论。请补充相关记录后继续核查。"}</p>}<h3>还不能确定</h3>{gaps.length?<ul>{gaps.map(g=><li key={g}>{g}</li>)}</ul>:<p>未列出额外缺口；仍需注意未读取材料和图像识别的限制。</p>}<button onClick={()=>onSupplement(undefined,goal)}>补充材料，继续这个问题</button></div>}
      {!finished&&!capped&&<progress aria-label="调查进度" value={completed} max={stages.length}/>}
      {task.artifacts.flatMap(a=>a.decisions).filter(d=>!task.decisions.some(v=>v.id===d.id)).map(d=><article className={ui.decision} key={d.id}><h3>{d.question}</h3><p>请说明你知道的情况；你的回答会作为补充说明，不会替代原始证据。</p><label>你的回答<textarea value={reasons[d.id]||""} onChange={e=>setReasons({...reasons,[d.id]:e.target.value})} placeholder="例如：是同一个人，两个昵称都属于这位同学。"/></label><button disabled={busy||task.state==="running"||!reasons[d.id]?.trim()} onClick={()=>void decide(d.id)}>提交回答并继续</button><button disabled={busy||task.state==="running"} onClick={()=>void decide(d.id,true)}>暂时无法确认</button></article>)}
      {claims.length>0&&<h3>依据与原文</h3>}{claims.map(c=><article className={ui.claim} key={c.id}><strong>{c.content}</strong><p className={ui.claimStatus}>{terms[c.kind]} · {terms[currentClaimCheck(task,c.id)?.status||""]||"尚未独立核查"}</p><p>{task.executionPlan?.staleResultIds.includes(c.id)?"发现新反证，原核查状态已失效，等待重新核查。":currentClaimCheck(task,c.id)?.reason}</p>{c.refs.map((ref,i)=><button className={ui.sourceButton} title={ref.quote} key={i} onClick={()=>setSource(ref.segmentId)}>查看原文：{ref.quote.slice(0,60)}</button>)}</article>)}
      {([["people","人物候选"],["relationships","关系"],["events","时间线"],["commitments","承诺"],["conflicts","需要对照的说法"]] as const).filter(([key])=>task.artifacts.some(a=>a[key].length)).map(([key,title])=><details key={key}><summary>{title}</summary>{task.artifacts.flatMap(a=>a[key]).map(f=><article key={f.id}><strong>{f.content}</strong><p>{f.time}</p>{f.alternatives.map((v,i)=><p key={i}>其他解释：{v}</p>)}</article>)}</details>)}
      <details><summary>查看处理过程与覆盖范围</summary><p>{completed}/{stages.length} · {task.model?.name}</p><ol className="investigator-steps">{stages.map(i=><li data-state={stageDone(i)?"done":i===task.step?"current":"pending"} key={skillNames[i]}>{stageDone(i)?"✓ ":i===task.step?"→ ":""}{skillLabels[i]}</li>)}</ol><p>共 {task.snapshot.length} 个片段，读取 {task.reads.length} 个。未检出不等于不存在。</p></details>
      {task?.stale&&<p role="status">材料已更新，本报告基于旧版本。请重新核查后使用结论。</p>}<div className="investigator-actions">{["queued","running","waiting_user"].includes(task.state)&&<button disabled={busy} onClick={()=>void act("pause")}>先停一下</button>}{["paused","failed","waiting_user"].includes(task.state)&&!capped&&<button disabled={busy} onClick={()=>void act("resume")}>继续核查</button>}{task.state!=="running"&&<button disabled={busy} onClick={()=>void act("revise")}>按调整后的目标重新核查</button>}{!["completed","cancelled"].includes(task.state)&&<button disabled={busy} onClick={()=>void act("cancel")}>结束本次调查</button>}{finished&&<a href={`/api/investigations/${task.id}/report`}>保存报告</a>}</div>
      {source&&<article className={ui.source} ref={sourcePanel} tabIndex={-1} aria-label="调查引用原文"><strong>{task.snapshot.find(s=>s.id===source)?.name||"引用原文"}</strong><button onClick={()=>setSource(null)}>关闭原文</button>{task.snapshot.find(s=>s.id===source)?.kind==="image"?<Image src={task.snapshot.find(s=>s.id===source)!.content} alt="引用原图" width={600} height={400} unoptimized style={{width:"100%",height:"auto"}}/>:<pre>{task.snapshot.find(s=>s.id===source)?.content}</pre>}</article>}
    </>}
  </section>;
}
