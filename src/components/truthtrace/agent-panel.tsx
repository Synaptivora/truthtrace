"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MessageCircle, X, Settings, Send, Square, Trash2, Cable } from "lucide-react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { providers, type Connection, type Protocol } from "@/lib/agent/providers";
import type { AgentEvent, AgentReply } from "@/lib/agent/contracts";
import { McpGuide } from "./mcp-guide";
import { AppSettings } from "./app-settings";

export type AgentContext = { evidence: Evidence[]; analysis?: AnalysisResult; caseName?: string; caseId?: string };
type Turn = { role: "user" | "assistant"; content: string; reply?: AgentReply };
type Mode = "server" | "demo" | "custom";
const initialConnection: Connection = { provider: "openai", protocol: "openai", baseUrl: providers[0].baseUrl, model: "", apiKey: "", tools: true };

export function AgentPanel({ context }: { context: AgentContext | null }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"chat" | "connection" | "model">("chat");
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
  const threadId = context?.caseId || context?.evidence.map(e => e.id).join("|") || "global";
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
        <button type="button" aria-pressed={view === "connection"} onClick={() => setView("connection")}><Cable size={17} />连接</button>
        <button type="button" aria-pressed={view === "model"} onClick={() => setView("model")}><Settings size={17} />模型设置</button>
      </nav>
      {view === "connection" && <McpGuide onClose={() => setView("chat")} />}
      {view === "model" && <section className="agent-settings" aria-label="模型连接设置">
        <div className="agent-section-title"><h2>模型设置</h2><p>选择咪探长使用的模型，也可以先用本地演示。</p></div>
        <label>连接方式<select aria-label="连接方式" value={mode} onChange={e => { testRequest.current?.abort(); setTesting(false); setMode(e.target.value as Mode); setProbe(""); }}><option value="server">使用已保存的模型</option><option value="custom">填写模型连接</option><option value="demo">本地演示 · 不调用模型</option></select></label>
        {mode === "server" && <div className="agent-model-status"><span className={`agent-model-dot ${serverConfigured ? "ready" : ""}`} /><p>{server}</p>{!serverConfigured && <button type="button" onClick={() => { setMode("custom"); setProbe(""); }}>配置模型 →</button>}</div>}
        {mode === "demo" && <p className="agent-model-status">对话仅检索示例和原始材料，不调用大模型。</p>}
        {mode === "custom" && <>
          <label>供应商<select aria-label="供应商" value={connection.provider} onChange={e => { const p = providers.find(p => p.id === e.target.value)!; update({ ...initialConnection, provider: p.id, protocol: p.protocol, baseUrl: p.baseUrl }); }}>{["国际旗舰", "国产大模型", "聚合 / 本地"].map(group => <optgroup key={group} label={group}>{providers.filter(p => p.group === group).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}</select></label>
          <label>模型名称<input aria-label="模型 ID" value={connection.model} onChange={e => update({ ...connection, model: e.target.value })} placeholder="填写供应商控制台中的完整模型名称" autoComplete="off" /></label>
          <label>访问密钥（API Key）<input aria-label="API Key" type="password" value={connection.apiKey} onChange={e => update({ ...connection, apiKey: e.target.value })} placeholder={connection.provider === "ollama" ? "本地 Ollama 可留空" : "从模型供应商的控制台获取"} autoComplete="off" /></label>
          <details className="agent-advanced"><summary>接口与高级选项</summary>
            <label>API 协议<select aria-label="API 协议" value={connection.protocol} onChange={e => changeProtocol(e.target.value as Protocol)}><option value="openai">OpenAI 兼容接口（含 Gemini）</option><option value="anthropic">Anthropic 接口</option><option value="responses">OpenAI Responses 接口</option></select></label>
            <label>接口地址<input aria-label="API Base URL" value={connection.baseUrl} onChange={e => update({ ...connection, baseUrl: e.target.value })} placeholder="https://…/v1" autoComplete="off" /></label>
            <label className="agent-checkbox"><input type="checkbox" checked={connection.tools} onChange={e => update({ ...connection, tools: e.target.checked })} />允许助手检索本案材料</label>
            <p>地址和协议已按供应商预填。不支持工具调用时，可关闭材料检索。</p>
          </details>
        </>}
        {mode === "server" && serverConfigured && <button className="agent-test" disabled={testing} onClick={() => void test()}>{testing ? "测试中…" : "测试连接"}</button>}
        {mode === "custom" && <><label>用于<select value={connectionRole} onChange={e=>setConnectionRole(e.target.value)}><option value="shared">对话、材料分析与调查</option><option value="chat">仅对话</option><option value="analysis">仅材料分析</option><option value="investigation">仅自主调查</option></select></label><button className="agent-test" disabled={testing || !connection.model.trim() || (connection.provider !== "ollama" && !connection.apiKey.trim())} onClick={() => void saveShared()}>{testing ? "验证并保存中…" : "验证并保存模型"}</button><p className="agent-settings-note">验证会调用模型。保存后，密钥加密存放在本机，不写入浏览器。</p></>}
        {probe && <p className="agent-probe" role="status">{probe}</p>}
      </section>}
      <div className="agent-chat" hidden={view !== "chat"}><ChatSession key={`${threadId}:${mode}:${connection.provider}:${connection.protocol}:${connection.model}:${connection.baseUrl}:${connection.tools}`} context={context} mode={mode} connection={connection} initialDraft={drafts[threadId] || ""} onDraft={draft => setDrafts(previous => ({ ...previous, [threadId]: draft }))} initialTurns={threads[threadId] || []} onTurns={turns => setThreads(previous => ({ ...previous, [threadId]: turns }))} /></div>
    </aside>}
  </>;
}

function ChatSession({ context, mode, connection, initialTurns, onTurns, initialDraft, onDraft }: { context: AgentContext | null; mode: Mode; connection: Connection; initialTurns: Turn[]; onTurns: (turns: Turn[]) => void; initialDraft: string; onDraft: (draft: string) => void }) {
  const [turns, setTurns] = useState(initialTurns);
  const [allowImages, setAllowImages] = useState(false);
  const [draft, updateDraft] = useState(initialDraft);
  function setDraft(value: string) { updateDraft(value); onDraft(value); }
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [source, setSource] = useState<Evidence | null>(null);
  const request = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => { if (turns.length || status) end.current?.scrollIntoView({ block: "nearest" }); }, [turns, status]);
  function save(next: Turn[]) { setTurns(next); onTurns(next); }
  function stop() { request.current?.abort(); setBusy(false); setStatus(""); setError("已停止，问题已保留，可重新发送。"); }
  async function send(question = draft) {
    if (!question.trim() || busy) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setStatus("正在准备对话");
    const history = [...turns, { role: "user" as const, content: question.trim() }].slice(-23);
    try {
      const response = await fetch("/api/agent/chat", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowImages, messages: history.map(({ role, content }) => ({ role, content })), mode, ...(mode === "custom" ? { connection } : {}), evidence: context?.evidence.map(e => e.kind === "image" && !allowImages ? { ...e, content: "[图片像素未发送给对话助手]" } : e) ?? [], analysis: context?.analysis }) });
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
      if (!controller.signal.aborted) { save([...history, { role: "assistant", content: result.text, reply: result }]); setDraft(""); }
    } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "发送失败，请重试。"); }
    finally { if (!controller.signal.aborted) { setBusy(false); setStatus(""); } }
  }
  return <>
    <div className="agent-scope"><span>{context ? `本案 ${context.evidence.length} 份材料` : "通用对话 · 不读取案件"} · {mode === "demo" ? "本地演示" : mode === "custom" ? connection.model || "未填写模型" : "已保存的模型"}</span><button aria-label="清空当前对话" disabled={busy} onClick={() => { save([]); setError(""); }}><Trash2 size={14} /></button></div>
    <div className="agent-messages" role="log" aria-label="对话记录">
      {!turns.length && <div className="agent-welcome"><h3>从一个问题开始。</h3><p>{context ? "输入问题，回复会保留材料来源。" : "创建案件后，可以就材料提问。"}</p>{(context ? ["这句话出自哪份材料？"] : ["我该怎么创建案件？", "可以导入哪些材料？"]).map(q => <button key={q} disabled={busy} onClick={() => { setDraft(q); void send(q); }}>{q}</button>)}</div>}
      {turns.map((turn, index) => <article key={index} className={`agent-message ${turn.role}`}><strong>{turn.role === "user" ? "你" : "咪探长"}</strong><p>{turn.content}</p>{turn.reply && <><small>{turn.reply.mode === "demo" ? "本地演示 · 非模型判断" : `模型回复 · ${turn.reply.model}`}</small>{turn.reply.citations.length > 0 && <div className="agent-citations">{turn.reply.citations.map(c => <button key={c.id} onClick={() => setSource(context?.evidence.find(e => e.id === c.evidenceId) ?? null)} title={c.excerpt}>[{c.id}] {c.name} ↗</button>)}</div>}<details><summary>来源与处理方式</summary><ul>{turn.reply.steps.map((s, i) => <li key={i}>{s}</li>)}</ul><p>引用表示读取过的来源，不代表事实已经核实。</p></details></>}</article>)}
      {busy && <div className="agent-progress" role="status">{status}</div>}<div ref={end} />
    </div>
    {error && <p className="agent-error" role="alert">{error}</p>}
    <form className="agent-compose" onSubmit={e => { e.preventDefault(); void send(); }}>{context?.evidence.some(e => e.kind === "image") && <label className="agent-vision"><input type="checkbox" checked={allowImages} disabled={busy} onChange={e => setAllowImages(e.target.checked)} />发送原图给视觉模型（需模型支持）</label>}<label className="agent-sr" htmlFor="agent-question">输入问题</label><textarea id="agent-question" value={draft} maxLength={12000} onChange={e => setDraft(e.target.value)} placeholder="和咪探长聊聊…" rows={3} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><div><small>Enter 发送 · Shift+Enter 换行</small>{busy ? <button key="stop" type="button" onClick={e => { e.preventDefault(); stop(); }}><Square size={14} />停止</button> : <button key="send" type="submit" disabled={!draft.trim()}><Send size={15} />发送</button>}</div><small>当前对话仅保留在本页。发送后，问题与所选材料会交给当前模型服务；原图仅在勾选视觉选项后发送。</small></form>
    {source && <section className="agent-source" aria-label="引用原文"><header><strong>{source.name}</strong><button onClick={() => setSource(null)} aria-label="关闭引用原文"><X size={18} /></button></header>{source.kind === "image" ? <Image src={source.content} alt={source.name} width={800} height={600} unoptimized style={{width:"100%",height:"auto"}} /> : <pre>{source.content}</pre>}</section>}
  </>;
}
