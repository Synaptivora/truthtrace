"use client";
import { MarkdownContent } from "./markdown-content";

import ui from "./conversation-ui.module.css";
import type { Conversation } from "@/lib/conversation/store";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MessageCircle, X, Settings, Send, Square, Trash2, Cable } from "lucide-react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { providers, type Connection, type Protocol } from "@/lib/agent/providers";
import type { AgentEvent, AgentReply } from "@/lib/agent/contracts";
import { McpGuide } from "./mcp-guide";
import { AppSettings } from "./app-settings";
import { InvestigatorPanel } from "./investigator-panel";
import { analyzeFiles, type CaseAnalysis } from "./api-client";
import type { ChannelId } from "./channel-import";
import type { InvestigationMode } from "@/lib/investigator/contracts";

export type AgentContext = { evidence: Evidence[]; analysis?: AnalysisResult; caseName?: string; caseId?: string; goal?: string };
type Turn = { role: "user" | "assistant"; content: string; reply?: AgentReply };
type Mode = "server" | "demo" | "custom";
const initialConnection: Connection = { provider: "openai", protocol: "openai", baseUrl: providers[0].baseUrl, model: "", apiKey: "", tools: true };

export function AgentPanel({ context, onReady, onChannel }: { context: AgentContext | null; onReady:(result:CaseAnalysis)=>Promise<void>; onChannel:(channel:ChannelId,goal:string)=>void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "connection" | "model" | "settings" | "materials" | "investigation">("chat");
  const [mode, setMode] = useState<Mode>("server");
  const [connection, setConnection] = useState<Connection>(initialConnection);
  const [threads, setThreads] = useState<Record<string, Turn[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [server, setServer] = useState("正在检查模型连接…");
  const [serverConfigured, setServerConfigured] = useState(false);
  const [probe, setProbe] = useState("");
  const [connectionRole, setConnectionRole] = useState("shared");
  const [testing, setTesting] = useState(false);
  const testRequest = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const [goal,setGoal]=useState("");
  const [routeMode,setRouteMode]=useState<InvestigationMode>();
  const [routeReason,setRouteReason]=useState("");
  const [materialBusy,setMaterialBusy]=useState(false),[materialError,setMaterialError]=useState("");
  const upload=useRef<HTMLInputElement>(null);
  const returnTo=useRef<"chat"|"investigation">("chat");
  const routeRef=useRef<(goal:string,signal?:AbortSignal,force?:boolean)=>Promise<boolean>>(async()=>false);
  async function routeGoal(text:string, signal?:AbortSignal, force=false){
    const response=await fetch("/api/assistant/intent",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({goal:text.slice(0,4000),hasEvidence:!!context?.evidence.length}),signal});
    if(!response.ok){if(force)throw new Error("意图识别暂不可用");return false;}
    const route=await response.json();
    if(signal?.aborted)return false;
    if(route.action==="chat"&&!force)return false;
    if(route.action!=="supplement"||!context?.goal)setGoal(text.slice(0,4000));else setGoal(context.goal);
    setRouteMode(route.mode);setRouteReason(route.reason);setOpen(true);
    setView(route.action==="supplement"||!context?.evidence.length?"materials":"investigation");
    return true;
  }
  useEffect(()=>{routeRef.current=routeGoal;});
  useEffect(()=>{
    function handle(event:Event){const detail=(event as CustomEvent<{goal?:string;view?:"materials"|"investigation"}>).detail;
      if(detail?.goal)void routeRef.current(detail.goal,undefined,true).catch(()=>{setGoal(detail.goal!);setOpen(true);setView("materials");});
      else {setOpen(true);setView(detail?.view||"chat");}}
    window.addEventListener("truthtrace:assistant",handle);return()=>window.removeEventListener("truthtrace:assistant",handle);
  },[]);
  useEffect(()=>{const timer=setTimeout(()=>{setGoal(context?.goal||"");if(context?.caseId&&context.goal){setOpen(true);setView("investigation");}else if(!context?.caseId)setView("chat");},0);return()=>clearTimeout(timer);},[context?.caseId,context?.goal]);
  async function importFiles(files:File[]){if(!files.length)return;setMaterialBusy(true);setMaterialError("");try{
    const next=await analyzeFiles(files,new AbortController().signal,()=>{},context?.evidence||[]);
    await onReady({...next,caseId:context?.caseId,caseName:context?.caseName||goal.slice(0,60)||"新的调查",goal:goal||context?.goal});
    setView("investigation");
  }catch(e){setMaterialError((e as Error).message);}finally{setMaterialBusy(false);}}
  function configure(draft:string){setGoal(draft);returnTo.current="investigation";setView("model");}
  function supplement(channel?:ChannelId,draft=goal){setGoal(draft);if(channel)onChannel(channel,draft||context?.goal||"");else setView("materials");}
  const threadId = context?.caseId || context?.evidence.map(e => e.id).join("|") || "global";
  useEffect(() => {
    function configure() { if (document.fullscreenElement) void document.exitFullscreen(); setOpen(true); setView("model"); }
    window.addEventListener("truthtrace:configure-model", configure);
    return () => window.removeEventListener("truthtrace:configure-model", configure);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/agent/connection", { signal: controller.signal }).then(r => r.json()).then(r => { setServerConfigured(Boolean(r.configured)); setServer(r.error || (r.configured ? `${r.provider} · ${r.model}` : "尚未配置模型，可先使用本地演示。")); }).catch(() => { if (!controller.signal.aborted) setServer("暂时无法读取模型配置，请稍后重试。"); });
    return () => { controller.abort(); testRequest.current?.abort(); };
  }, []);
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  function close() { setOpen(false); launcher.current?.focus(); }
  function update(next: Connection) { testRequest.current?.abort(); setTesting(false); setConnection(next); setProbe(""); }
  function changeProtocol(protocol: Protocol) {
    const baseUrl = connection.provider === "opencode" && /^https:\/\/opencode.ai\/inference\/(openai|anthropic)\/v1$/.test(connection.baseUrl)
      ? `https://opencode.ai/inference/${protocol === "anthropic" ? "anthropic" : "openai"}/v1` : connection.baseUrl;
    update({ ...connection, protocol, baseUrl });
  }
  async function test() {
    const controller = new AbortController(); testRequest.current?.abort(); testRequest.current = controller;
    setTesting(true); setProbe("正在连接，可能产生一次模型调用费用…");
    try {
      const response = await fetch("/api/agent/connection", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(mode === "custom" ? { connection } : {}) });
      const data = await response.json(); if (!controller.signal.aborted) setProbe(data.error || data.message);
    } catch { if (!controller.signal.aborted) setProbe("连接失败，请检查网络和配置。"); }
    finally { if (!controller.signal.aborted) setTesting(false); }
  }
  async function saveShared() {
    setTesting(true); setProbe("正在验证文本和工具能力并加密保存…");
    try { const r = await fetch("/api/settings/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection, role: connectionRole }) }); const data = await r.json(); setProbe(data.error || data.message); if (r.ok) { setMode("server"); const current = await fetch("/api/agent/connection").then(response => response.json()).catch(() => null); if (current) { setServerConfigured(Boolean(current.configured)); setServer(current.error || (current.configured ? `${current.provider} · ${current.model}` : "尚未配置对话模型。")); } } }
    catch { setProbe("保存失败，请检查本地服务。"); } finally { setTesting(false); }
  }
  return <>
    <AppSettings />
    <button ref={launcher} className="agent-launcher" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-controls="agent-panel"><MessageCircle size={19} />和咪探长聊聊</button>
    {open && <aside id="agent-panel" className={`agent-panel agent-view-${view}`} ref={panel} tabIndex={-1} aria-label="Synapse · 咪探长" onKeyDown={e => { if (e.key === "Escape") close(); }}>
      <header className="agent-header"><div><strong>Synapse · 咪探长</strong><small>{context?.caseName || "全局助手 · 未选择案件"}</small></div><button onClick={close} aria-label="关闭助手"><X size={20} /></button></header>
      <nav className="agent-nav" aria-label="咪探长功能">
        <button type="button" aria-pressed={view === "chat"} onClick={() => setView("chat")}><MessageCircle size={17} />对话</button>
        {context?.analysis&&<button type="button" aria-pressed={view === "investigation"} onClick={()=>setView("investigation")}>本次调查</button>}
        <button type="button" aria-pressed={view === "materials"} onClick={()=>setView("materials")}>补充材料</button>
        <button type="button" aria-pressed={["settings","model","connection"].includes(view)} onClick={()=>setView("settings")}><Settings size={17}/>设置</button>
      </nav>
      <section hidden={view!=="settings"} className="agent-settings"><h2>连接与显示设置</h2><p>按当前需要配置，目标和材料会保留。</p><button onClick={()=>{returnTo.current=context?.analysis?"investigation":"chat";setView("model");}}>模型设置</button><button onClick={()=>setView("connection")}><Cable size={16}/>连接渠道</button></section>
      {view === "materials"&&<section className="agent-settings"><h2>{context?"把新材料交给我":"先选与问题有关的材料"}</h2><p>{goal||context?.goal||"可以先输入目标，也可以直接添加材料。"}</p><p>导入后保留你的目标；已有调查会纳入新材料重新核查。</p><input ref={upload} type="file" hidden multiple accept="image/*,.pdf,.txt,.md,.json" onChange={e=>{void importFiles(Array.from(e.target.files||[]));e.target.value="";}}/><button disabled={materialBusy} onClick={()=>upload.current?.click()}>上传文件或截图</button><button disabled={materialBusy} onClick={()=>supplement("dingtalk")}>选择钉钉会话</button><button disabled={materialBusy} onClick={()=>supplement("wechat")}>选择微信会话</button>{materialBusy&&<p role="status">正在整理，原有材料和目标会保留…</p>}{materialError&&<p role="alert">{materialError}</p>}</section>}
      {view === "investigation"&&context?.analysis&&<InvestigatorPanel key={context.caseId} context={{...context,analysis:context.analysis}} initialGoal={goal||context.goal} routedMode={routeMode} onGoalChange={value=>{setGoal(value);setRouteMode(undefined);}} onConfigure={configure} onSupplement={supplement}/>}
      {view === "investigation"&&routeReason&&<small className="agent-route-note">{routeReason}</small>}
      {view === "connection" && <McpGuide onClose={() => setView("settings")} />}
      {view === "model" && <section className="agent-settings" aria-label="模型连接设置">
        <div className="agent-section-title"><h2>模型设置</h2><p>选择咪探长使用的模型，也可以先用本地演示。</p></div>
        <label>连接方式<select aria-label="连接方式" value={mode} onChange={e => { testRequest.current?.abort(); setTesting(false); setMode(e.target.value as Mode); setProbe(""); }}><option value="server">使用已保存的模型</option><option value="custom">填写模型连接</option><option value="demo">本地演示 · 不调用模型</option></select></label>
        {mode === "server" && <div className="agent-model-status"><span className={`agent-model-dot ${serverConfigured ? "ready" : ""}`} /><p>{server}</p>{!serverConfigured && <button type="button" onClick={() => { setMode("custom"); setProbe(""); }}>配置模型 →</button>}</div>}
        {mode === "demo" && <p className="agent-model-status">对话仅检索示例和原始材料，不调用大模型。</p>}
        {mode === "custom" && <>
          <label>供应商<select aria-label="供应商" value={connection.provider} onChange={e => { const p = providers.find(p => p.id === e.target.value)!; update({ ...initialConnection, provider: p.id, protocol: p.protocol, baseUrl: p.baseUrl,model:p.id==="deepseek"?"deepseek-flash":"" }); }}>{["国际旗舰", "国产大模型", "聚合 / 本地"].map(group => <optgroup key={group} label={group}>{providers.filter(p => p.group === group).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}</select></label>
          <label>模型名称<input aria-label="模型 ID" value={connection.model} onChange={e => update({ ...connection, model: e.target.value })} placeholder="填写供应商控制台中的完整模型名称" autoComplete="off" /></label>
          <label>访问密钥（API Key）<input aria-label="API Key" type="password" value={connection.apiKey} onChange={e => update({ ...connection, apiKey: e.target.value })} placeholder={connection.provider === "ollama" ? "本地 Ollama 可留空" : "从模型供应商的控制台获取"} autoComplete="off" /></label>
          <details className="agent-advanced"><summary>接口与高级选项</summary>
            <label>API 协议<select aria-label="API 协议" value={connection.protocol} onChange={e => changeProtocol(e.target.value as Protocol)}><option value="openai">OpenAI 兼容接口（含 Gemini）</option><option value="anthropic">Anthropic 接口</option><option value="responses">OpenAI Responses 接口</option></select></label>
            <label>接口地址<input aria-label="API Base URL" value={connection.baseUrl} onChange={e => update({ ...connection, baseUrl: e.target.value })} placeholder="https://…/v1" autoComplete="off" /></label>
            <label className="agent-checkbox"><input type="checkbox" checked={connection.tools} onChange={e => update({ ...connection, tools: e.target.checked })} />允许助手检索本案材料</label>
            <p>地址和协议已按供应商预填。不支持工具调用时，可关闭材料检索。</p>
          </details>
        </>}
        {(mode === "custom" || (mode === "server" && serverConfigured)) && <button className="agent-test" disabled={testing} onClick={() => void test()}>{testing ? "测试中…" : mode === "custom" ? "临时测试（不会保存）" : "检查已保存的连接"}</button>}
        {mode === "custom" && <><label>用于<select value={connectionRole} onChange={e=>setConnectionRole(e.target.value)}><option value="shared">对话、材料分析与调查</option><option value="chat">仅对话</option><option value="analysis">仅材料分析</option><option value="investigation">仅自主调查</option></select></label><button className="agent-test" disabled={testing || !connection.model.trim() || (connection.provider !== "ollama" && !connection.apiKey.trim())} onClick={() => void saveShared()}>{testing ? "验证并保存中…" : "连接并保存模型"}</button><p className="agent-settings-note">点击「连接并保存模型」后，对话、材料分析和调查才会一起使用此连接。临时测试不会保存配置；密钥加密存放在本机。</p></>}
        {probe && <p className="agent-probe" role="status">{probe}</p>}<button onClick={()=>setView(returnTo.current)}>返回并继续</button>
      </section>}
      <div className="agent-chat" hidden={view !== "chat"}><ChatSession key={`${threadId}:${mode}:${connection.provider}:${connection.protocol}:${connection.model}:${connection.baseUrl}:${connection.tools}`} onIntent={routeGoal} context={context} mode={mode} connection={connection} initialDraft={drafts[threadId] || ""} onDraft={draft => setDrafts(previous => ({ ...previous, [threadId]: draft }))} initialTurns={threads[threadId] || []} onTurns={turns => setThreads(previous => ({ ...previous, [threadId]: turns }))} /></div>
    </aside>}
  </>;
}

function ChatSession({ onIntent, context, mode, connection, initialTurns, onTurns, initialDraft, onDraft }: { onIntent:(text:string,signal:AbortSignal)=>Promise<boolean>; context: AgentContext | null; mode: Mode; connection: Connection; initialTurns: Turn[]; onTurns: (turns: Turn[]) => void; initialDraft: string; onDraft: (draft: string) => void }) {
  const [turns, setTurns] = useState(initialTurns);
  const [error, setError] = useState("");
  const savedCaseId=context?.caseId;
  const [saving,setSaving]=useState(false);
  const [reloadKey,setReloadKey]=useState(0);
  const [loadFailed,setLoadFailed]=useState(false);
  const [editing,setEditing]=useState<{index:number;content:string}|null>(null);
  const editInput=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{editInput.current?.focus();},[editing?.index]);
  const [deleting,setDeleting]=useState<number|"all"|null>(null);
  const [conversation,setConversation]=useState<Conversation|null>(null);
  const [conversationOptions,setConversationOptions]=useState<{id:string;updated:number}[]>([]);
  const [restoring,setRestoring]=useState(!!context?.caseId);
  useEffect(()=>{
    if(!savedCaseId)return;
    const controller=new AbortController();
    async function load(){
      try{
        const response=await fetch(`/api/conversations?caseId=${encodeURIComponent(savedCaseId!)}`,{signal:controller.signal});if(!response.ok)throw Error("会话恢复失败");
        let saved=await response.json();
        if(!saved){const created=await fetch("/api/conversations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({caseId:savedCaseId,action:"create"}),signal:controller.signal});if(!created.ok)throw Error("会话创建失败");saved=await created.json();}
        if(!controller.signal.aborted){setConversation(saved);setTurns(saved.turns);setRestoring(false);setLoadFailed(false);setEditing(null);setDeleting(null);}
      }catch{if(!controller.signal.aborted){setError("未能恢复本案会话，已保存的内容不会丢失。");setLoadFailed(true);setRestoring(true);}}
    }
    void load();return()=>controller.abort();
  },[savedCaseId,reloadKey]);
  useEffect(()=>{if(!context?.caseId)return;const controller=new AbortController();fetch(`/api/conversations?caseId=${encodeURIComponent(context.caseId)}&list=1`,{signal:controller.signal}).then(r=>r.ok?r.json():[]).then(rows=>{if(!controller.signal.aborted)setConversationOptions(rows);}).catch(()=>{});return()=>controller.abort();},[context?.caseId,conversation?.id,conversation?.revision]);
  async function selectConversation(id:string){if(busy||saving||!context?.caseId)return;setSaving(true);try{const response=await fetch(`/api/conversations?caseId=${encodeURIComponent(context.caseId)}&id=${encodeURIComponent(id)}`);if(!response.ok)throw Error("无法读取会话，请重试。");const next=await response.json();setConversation(next);save(next.turns);setEditing(null);setDeleting(null);setSource(null);setError("");}catch(e){setError((e as Error).message);}finally{setSaving(false);}}
  async function changeConversation(action:string,index?:number,content?:string){
    if(!context?.caseId||busy||saving)return;
    setSaving(true);
    try{
      const response=await fetch("/api/conversations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({caseId:context.caseId,id:conversation?.id,revision:conversation?.revision,action,index,content})});
      if(!response.ok)throw Error("会话修改失败，请重新打开助手刷新。");
      let next=await response.json();
      if(action==="delete"){const created=await fetch("/api/conversations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({caseId:context.caseId,action:"create"})});if(!created.ok)throw Error("新会话创建失败");next=await created.json();}
      setConversation(next);save(next.turns);setError("");setEditing(null);setDeleting(null);setSource(null);
    }catch(e){setError((e as Error).message);}finally{setSaving(false);}
  }

  const [allowImages, setAllowImages] = useState(false);
  const [draft, updateDraft] = useState(initialDraft);
  function setDraft(value: string) { updateDraft(value); onDraft(value); }
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [source, setSource] = useState<Evidence | null>(null);
  const request = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (turns.length || status) end.current?.scrollIntoView({ block: "nearest" }); }, [turns, status]);
  function save(next: Turn[]) { setTurns(next); onTurns(next); }
  function stop() { request.current?.abort(); setBusy(false); setStatus(""); setError("已停止，问题已保留，可重新发送。"); }
  async function send(question = draft) {
    if (!question.trim() || busy || restoring || saving || editing || deleting!==null) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setStatus("正在准备对话");
    const history = [...turns, { role: "user" as const, content: question.trim() }].slice(-23);
    try {
      if(await onIntent(question,controller.signal)){setDraft("");return;}
      const response = await fetch("/api/agent/chat", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId:context?.caseId,conversationId:conversation?.id,conversationRevision:conversation?.revision, allowImages, messages: history.map(({ role, content }) => ({ role, content })), mode, ...(mode === "custom" ? { connection } : {}), evidence: context?.caseId ? [] : context?.evidence.map(e => e.kind === "image" && !allowImages ? { ...e, content: "[图片像素未发送给对话助手]" } : e) ?? [], analysis: context?.caseId ? undefined : context?.analysis }) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "请求失败"); }
      const reader = response.body?.getReader(); if (!reader) throw new Error("未收到回复流。");
      const decoder = new TextDecoder(); let buffer = ""; let result: AgentReply | undefined;
      function consume(line: string) {
        if (!line.trim()) return;
        const event = JSON.parse(line) as AgentEvent;
        if (event.type === "status") setStatus(event.text);
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "result") result = event.reply;
      }
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline; while ((newline = buffer.indexOf("\n")) >= 0) { consume(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
        }
        consume(buffer + decoder.decode());
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (!result) throw new Error("回复连接中断，请重试。");
      if (!controller.signal.aborted) {
        if(conversation&&context?.caseId){const updated=await fetch(`/api/conversations?caseId=${encodeURIComponent(context.caseId)}&id=${encodeURIComponent(conversation.id)}`,{signal:controller.signal});if(!updated.ok)throw Error("回复已保存，但会话刷新失败，请重新打开助手");const next=await updated.json();setConversation(next);save(next.turns);}
        else save([...history, { role: "assistant", content: result.text, reply: result }]);
        setDraft("");
      }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "发送失败，请重试。"); }
    finally { if (!controller.signal.aborted) { setBusy(false); setStatus(""); } }
  }
  return <>
    <div className="agent-scope"><span>{context ? `本案 ${context.evidence.length} 份材料` : "通用对话 · 不读取案件"} · {mode === "demo" ? "本地演示" : mode === "custom" ? connection.model || "未填写模型" : "已保存的模型"}</span><button aria-label="清空当前对话" title="删除当前对话" disabled={busy||saving||restoring} onClick={()=>{setEditing(null);setDeleting("all");}}><Trash2 size={15}/></button></div>
    {context?.caseId&&<section className={ui.toolbar} aria-label="本案会话管理" aria-busy={restoring||saving}>
      <div className={ui.toolbarTop}><strong>本案会话</strong><span role="status" className={ui.saved}>{loadFailed?"暂未连接":restoring?"正在恢复…":saving?"正在保存…":`已保存 · ${conversation?.turns.length??0} 条消息`}</span></div>
      <div className={ui.controls}><label className={ui.selectLabel}><span className="agent-sr">选择本案会话</span><select aria-label="选择本案会话" disabled={busy||saving||restoring} value={conversation?.id??""} onChange={e=>void selectConversation(e.target.value)}>{!conversationOptions.some(c=>c.id===conversation?.id)&&<option value={conversation?.id??""}>{restoring?"正在读取历史…":"当前会话"}</option>}{conversationOptions.map((c,i)=><option key={c.id} value={c.id}>{new Date(c.updated).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})} · 会话 {conversationOptions.length-i}</option>)}</select></label><button className={ui.secondary} disabled={busy||saving||restoring} onClick={()=>void changeConversation("create")}>＋ 新会话</button></div>
      {conversation?.summary&&<details className={ui.summary}><summary>历史上下文已压缩 · 查看说明</summary><p>摘要仅是过往对话摘录，不代表事实已核实。清空后会保留完整消息。</p><button className={ui.textButton} disabled={busy||saving} onClick={()=>void changeConversation("clear_summary")}>清空上下文摘要</button></details>}
    </section>}
    {deleting!==null&&<section className={ui.confirm} role="group" aria-label="确认删除对话内容"><strong>{deleting==="all"?"删除当前对话？":"删除这条消息及后续回答？"}</strong><p>{deleting==="all"?"此操作会删除本条会话的历史。案件材料和其他会话会保留。":"后续回答依赖这条消息，将一并删除；案件原始材料不受影响。"}</p><div className={ui.actions}><button className={ui.danger} disabled={saving} onClick={()=>{if(conversation)void changeConversation(deleting==="all"?"delete":"delete_turn",typeof deleting==="number"?deleting:undefined);else{save([]);setDeleting(null);}}}>确认删除</button><button className={ui.secondary} disabled={saving} onClick={()=>setDeleting(null)}>取消</button></div></section>}
    <div className="agent-messages" role="log" aria-label="对话记录">
      {!turns.length && !restoring && <div className="agent-welcome"><h3>从一个问题开始。</h3><p>{context ? "输入问题，回复会保留材料来源。" : "先告诉我想查清什么，我会帮你选择材料和下一步。"}</p>{(context ? ["这句话出自哪份材料？"] : ["我想查清退款承诺是否兑现", "我有一张截图想补充"]).map(q => <button key={q} disabled={busy||saving} onClick={() => { setDraft(q); void send(q); }}>{q}</button>)}</div>}
      {turns.map((turn, index) => <article key={index} className={`agent-message ${turn.role}`}><strong>{turn.role === "user" ? "你" : "咪探长"}</strong>{editing?.index===index?<div className={ui.editor}><label htmlFor={`edit-message-${index}`}>编辑消息</label><textarea ref={editInput} id={`edit-message-${index}`} aria-label="编辑消息" value={editing.content} maxLength={12000} onChange={e=>setEditing({...editing,content:e.target.value})}/><p>保存后将移除后续回答，避免沿用已过期的结论。</p><div className={ui.actions}><button className={ui.primary} disabled={saving||!editing.content.trim()} onClick={()=>void changeConversation("edit",index,editing.content)}>保存修改</button><button className={ui.secondary} disabled={saving} onClick={()=>setEditing(null)}>取消编辑</button></div></div>:turn.role==="assistant"?<MarkdownContent text={turn.content}/>:<p>{turn.content}</p>}{conversation&&editing?.index!==index&&<div className={ui.messageActions}><button disabled={busy||saving} onClick={()=>{setEditing({index,content:turn.content});setDeleting(null);}}>编辑</button><button disabled={busy||saving} onClick={()=>{setDeleting(index);setEditing(null);}}>删除此条及后续</button></div>}{turn.reply && <><small>{turn.reply.mode === "demo" ? "本地演示 · 非模型判断" : `模型回复 · ${turn.reply.model}`}</small>{turn.reply.citations.length > 0 && <div className="agent-citations">{turn.reply.citations.map(c => <button key={c.id} onClick={() => {
        const current=context?.evidence.find(e=>e.id===c.evidenceId);
        const refs=c.refs??[];
        const exact=!!current&&refs.length>0&&refs.every(ref=>!!ref.provenance&&ref.provenance.caseId===context?.caseId&&ref.provenance.version===current.version);
        setSource(exact?current!:{id:c.evidenceId,name:`${c.name} · 引用摘录（非当前原文）`,kind:"text",mimeType:"text/plain",content:`无法确认当前原文与引用版本一致；以下仅为当时保留的摘录。\n引用版本：${refs.map(ref=>ref.provenance?.version??"未知").join("、")||"未知"}\n\n${refs.length?refs.map(ref=>ref.quote).join("\n\n"):c.excerpt}`});
      }} title={c.excerpt}>[{c.id}] {c.name} ↗</button>)}</div>}<details><summary>来源与处理方式</summary><ul>{turn.reply.steps.map((s, i) => <li key={i}>{s}</li>)}</ul><p>引用表示读取过的来源，不代表事实已经核实。</p></details></>}</article>)}
      {busy && <div className="agent-progress" role="status">{status}</div>}<div ref={end} />
    </div>
    {error && <div className={`agent-error ${ui.error}`} role="alert"><span>{error}</span>{context?.caseId&&<button className={ui.secondary} disabled={busy||saving} onClick={()=>{setLoadFailed(false);setRestoring(true);setError("");setReloadKey(v=>v+1);}}>重新加载会话</button>}</div>}
    <form className="agent-compose" onSubmit={e => { e.preventDefault(); void send(); }}>{context?.evidence.some(e => e.kind === "image") && <label className="agent-vision"><input type="checkbox" checked={allowImages} disabled={busy} onChange={e => setAllowImages(e.target.checked)} />发送原图给视觉模型（需模型支持）</label>}<label className="agent-sr" htmlFor="agent-question">输入问题</label><textarea id="agent-question" value={draft} maxLength={12000} onChange={e => setDraft(e.target.value)} placeholder="和咪探长聊聊…" rows={3} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div><small>Enter 发送 · Shift+Enter 换行</small>{busy ? <button key="stop" type="button" onClick={e => { e.preventDefault(); stop(); }}><Square size={14} />停止</button> : <button key="send" type="submit" disabled={!draft.trim()||restoring||saving||!!editing||deleting!==null}><Send size={15} />发送</button>}</div><details className={ui.privacy}><summary>对话保存与模型使用说明</summary><p>已保存案件的对话保存在本机，可编辑或删除；未保存材料的对话仅保留在本页。发送后，问题与所选材料会交给当前模型服务；原图仅在勾选视觉选项后发送。</p></details></form>
    {source && <section className="agent-source" aria-label="引用原文"><header><strong>{source.name}</strong><button onClick={() => setSource(null)} aria-label="关闭引用原文"><X size={18} /></button></header>{source.kind === "image" ? <Image src={source.content} alt={source.name} width={800} height={600} unoptimized style={{width:"100%",height:"auto"}} /> : <pre>{source.content}</pre>}</section>}
  </>;
}
