"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MessageCircle, X, Settings, Send, Square, Trash2, Cable } from "lucide-react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { providers, type Connection, type Protocol } from "@/lib/agent/providers";
import type { AgentEvent, AgentReply } from "@/lib/agent/contracts";
import { McpGuide } from "./mcp-guide";

export type AgentContext = { evidence: Evidence[]; analysis?: AnalysisResult; caseName?: string; caseId?: string };
type Turn = { role: "user" | "assistant"; content: string; reply?: AgentReply };
type Mode = "server" | "demo" | "custom";
const initialConnection: Connection = { provider: "openai", protocol: "openai", baseUrl: providers[0].baseUrl, model: "", apiKey: "", tools: true };

export function AgentPanel({ context }: { context: AgentContext | null }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(false);
  const [mcp, setMcp] = useState(false);
  const [mode, setMode] = useState<Mode>("server");
  const [connection, setConnection] = useState<Connection>(initialConnection);
  const [threads, setThreads] = useState<Record<string, Turn[]>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [server, setServer] = useState("正在检查服务端配置");
  const [probe, setProbe] = useState("");
  const [connectionRole, setConnectionRole] = useState("shared");
  const [testing, setTesting] = useState(false);
  const testRequest = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const threadId = context?.caseId || context?.evidence.map(e => e.id).join("|") || "global";
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/agent/connection", { signal: controller.signal }).then(r => r.json()).then(r => setServer(r.error || (r.configured ? `${r.provider} · ${r.model}` : "本地演示（服务端未连接模型）"))).catch(() => {});
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
    try { const r = await fetch("/api/settings/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection, role: connectionRole }) }); const data = await r.json(); setProbe(data.error || data.message); if (r.ok) { setMode("server"); setServer(`${connection.provider} · ${connection.model}`); } }
    catch { setProbe("保存失败，请检查本地服务。"); } finally { setTesting(false); }
  }
  return <>
    <button style={{position:"fixed",right:24,bottom:82,zIndex:60,padding:"8px 16px",background:"#f8efd9",color:"#243c32",borderRadius:8}} onClick={() => { setOpen(true); setSettings(true); setMcp(false); }}>设置</button>
    <button ref={launcher} className="agent-launcher" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-controls="agent-panel"><MessageCircle size={19} />和咪探长聊聊</button>
    {open && <aside id="agent-panel" className="agent-panel" ref={panel} tabIndex={-1} aria-label="咪探长对话" onKeyDown={e => { if (e.key === "Escape") close(); }}>
      <header className="agent-header"><div><strong>Synapse · 咪探长</strong><small>{context?.caseName || "全局助手 · 未选择案件"}</small></div><button className="agent-mcp-trigger" onClick={() => { setMcp(v => !v); setSettings(false); }} aria-label="聊天来源连接" aria-expanded={mcp}><Cable size={18} /></button><button onClick={() => { setSettings(v => !v); setMcp(false); }} aria-label="模型设置" aria-expanded={settings}><Settings size={18} /></button><button onClick={close} aria-label="关闭助手"><X size={20} /></button></header>
      {mcp && <McpGuide onClose={() => setMcp(false)} />}
      {settings && !mcp && <section className="agent-settings" aria-label="模型连接设置">
        <label>连接方式<select aria-label="连接方式" value={mode} onChange={e => { testRequest.current?.abort(); setTesting(false); setMode(e.target.value as Mode); setProbe(""); }}><option value="server">服务端配置</option><option value="custom">选择供应商</option><option value="demo">本地演示 · 不调用模型</option></select></label>
        {mode === "server" && <p>{server}</p>}
        {mode === "custom" && <>
          <label>供应商<select aria-label="供应商" value={connection.provider} onChange={e => { const p = providers.find(p => p.id === e.target.value)!; update({ ...initialConnection, provider: p.id, protocol: p.protocol, baseUrl: p.baseUrl }); }}>{["国际旗舰", "国产大模型", "聚合 / 本地"].map(group => <optgroup key={group} label={group}>{providers.filter(p => p.group === group).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>)}</select></label>
          <label>API 协议<select aria-label="API 协议" value={connection.protocol} onChange={e => changeProtocol(e.target.value as Protocol)}><option value="openai">OpenAI 兼容接口（含 Gemini）</option><option value="anthropic">Anthropic 接口</option><option value="responses">OpenAI Responses 接口</option></select></label>
          <label>接口地址<input aria-label="API Base URL" value={connection.baseUrl} onChange={e => update({ ...connection, baseUrl: e.target.value })} placeholder="https://…/v1" autoComplete="off" /></label>
          <label>模型名称<input aria-label="模型 ID" value={connection.model} onChange={e => update({ ...connection, model: e.target.value })} placeholder="填写供应商控制台中的完整模型名称" autoComplete="off" /></label>
          <label>访问密钥<input aria-label="API Key" type="password" value={connection.apiKey} onChange={e => update({ ...connection, apiKey: e.target.value })} placeholder={connection.provider === "ollama" ? "本地 Ollama 可留空" : "仅保留在本页内存中"} autoComplete="off" /></label>
          <label className="agent-checkbox"><input type="checkbox" checked={connection.tools} onChange={e => update({ ...connection, tools: e.target.checked })} />允许助手检索本案材料</label>
          <p>聚合平台不同模型可能使用不同协议；地域或套餐地址可修改。不支持工具的模型可关闭工具调用。密钥不会写入浏览器存储。</p>
        </>}
        {mode !== "demo" && <button className="agent-test" disabled={testing} onClick={() => void test()}>{testing ? "测试中…" : "测试连接（一次模型调用）"}</button>}
        {mode === "custom" && <><label>保存用途<select value={connectionRole} onChange={e=>setConnectionRole(e.target.value)}><option value="shared">默认共享</option><option value="chat">仅对话</option><option value="analysis">仅材料分析</option><option value="investigation">仅自主调查</option></select></label><button disabled={testing} onClick={() => void saveShared()}>测试并加密保存连接</button></>}
        {probe && <p role="status">{probe}</p>}
      </section>}
      <ChatSession key={`${threadId}:${mode}:${connection.provider}:${connection.protocol}:${connection.model}:${connection.baseUrl}:${connection.tools}`} context={context} mode={mode} connection={connection} initialDraft={drafts[threadId] || ""} onDraft={draft => setDrafts(previous => ({ ...previous, [threadId]: draft }))} initialTurns={threads[threadId] || []} onTurns={turns => setThreads(previous => ({ ...previous, [threadId]: turns }))} />
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
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [turns, status]);
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
    <div className="agent-scope"><span>{context ? `本案 ${context.evidence.length} 份材料` : "通用对话 · 不读取案件"} · {mode === "demo" ? "演示" : mode === "custom" ? connection.model || "未填写模型" : "服务端配置"}</span><button aria-label="清空当前对话" disabled={busy} onClick={() => { save([]); setError(""); }}><Trash2 size={14} /></button></div>
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
