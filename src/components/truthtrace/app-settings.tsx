"use client";

import { useEffect, useRef, useState } from "react";
import { Settings, X } from "lucide-react";

type Preferences = { text: "standard" | "large"; reduceMotion: boolean };
const storageKey = "truthtrace.display-preferences";

function apply(preferences: Preferences) {
  document.documentElement.dataset.agentText = preferences.text;
  document.documentElement.dataset.reduceMotion = String(preferences.reduceMotion);
}

export function AppSettings({embedded=false}:{embedded?:boolean}) {
  const [open, setOpen] = useState(false);
  const [preferences, setPreferences] = useState<Preferences>({ text: "standard", reduceMotion: false });
  const [notice, setNotice] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      let next: Preferences = { text: "standard", reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches };
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
        if (saved) next = { text: saved.text === "large" ? "large" : "standard", reduceMotion: typeof saved.reduceMotion === "boolean" ? saved.reduceMotion : next.reduceMotion };
      } catch { /* 无法读取时沿用默认显示设置。 */ }
      setPreferences(next);
      apply(next);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    function outside(event: PointerEvent) {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  function update(next: Preferences) {
    setPreferences(next);
    apply(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setNotice(""); }
    catch { setNotice("当前浏览器无法保存偏好，设置仅在本页生效。"); }
  }
  function close() { setOpen(false); trigger.current?.focus(); }

  return <>
    <button ref={trigger} type="button" className={embedded?"app-settings-inline-trigger":"app-settings-trigger"} aria-expanded={open} aria-controls="app-settings" onClick={() => setOpen(value => !value)}><Settings size={16} />应用设置</button>
    {open && <section ref={panel} id="app-settings" className={embedded?"app-settings-panel app-settings-inline":"app-settings-panel"} role="dialog" aria-label="应用设置" tabIndex={-1} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header><h2>应用设置</h2><button type="button" onClick={close} aria-label="关闭应用设置"><X size={18} /></button></header>
      <div className="app-setting-row"><div><strong>模型连接</strong><small>用于材料分析、对话与自主调查</small></div><button type="button" className="app-model-link" onClick={() => { setOpen(false); window.dispatchEvent(new Event("truthtrace:configure-model")); }}>配置模型 →</button></div>
      <div className="app-setting-row"><div><strong>界面语言</strong><small>当前版本提供简体中文</small></div><span>简体中文</span></div>
      <label className="app-setting-row"><div><strong>咪探长面板字号</strong><small>调整对话和配置页的文字大小</small></div><select value={preferences.text} onChange={event => update({ ...preferences, text: event.target.value as Preferences["text"] })}><option value="standard">标准</option><option value="large">较大</option></select></label>
      <label className="app-setting-row"><div><strong>减少动态效果</strong><small>关闭装饰动画和过渡效果</small></div><input type="checkbox" role="switch" checked={preferences.reduceMotion} onChange={event => update({ ...preferences, reduceMotion: event.target.checked })} /></label>
      <p role={notice ? "status" : undefined}>{notice || "偏好保存在当前浏览器。"}</p>
    </section>}
  </>;
}
