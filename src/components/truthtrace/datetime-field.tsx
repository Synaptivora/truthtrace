"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

/* 自绘日期时间选择器。
 *
 * 为什么不用 <input type="datetime-local">：原生日历弹层在 Chromium 里是独立
 * popup layer，遇到带 backdrop-filter 的祖先（导入对话框就是这样）会被压到模糊层
 * 之下，用户看到的就是一块纯黑——点开等于没反应，还不能改时间。
 * 自己画一个，顺便把「分钟精度」和深色主题都握在手里。 */

function pad(value: number) { return String(value).padStart(2, "0"); }

export type LocalDate = { y: number; mo: number; d: number; h: number; mi: number };

export function parseLocalDate(value: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value || "");
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]), h: Number(m[4]), mi: Number(m[5]) };
}

export function emitLocalDate(parts: LocalDate) {
  return `${parts.y}-${pad(parts.mo + 1)}-${pad(parts.d)}T${pad(parts.h)}:${pad(parts.mi)}`;
}

export function formatLocalDate(parts: LocalDate) {
  return `${parts.y}/${pad(parts.mo + 1)}/${pad(parts.d)} ${pad(parts.h)}:${pad(parts.mi)}`;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const POP_W = 268;
const POP_H = 352;

export function DateTimeField({
  value,
  onChange,
  label,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  ariaLabel?: string;
}) {
  const nowParts = useMemo(() => {
    const now = new Date();
    return {
      y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(),
      h: now.getHours(), mi: now.getMinutes(),
    };
  }, []);

  const selected = parseLocalDate(value) ?? nowParts;
  const [open, setOpen] = useState(false);
  const [view, setView] = useState({ y: selected.y, mo: selected.mo });
  const [pos, setPos] = useState({ left: 0, top: 0 });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const openPicker = useCallback(() => {
    setView({ y: selected.y, mo: selected.mo });
    setOpen(true);
  }, [selected.y, selected.mo]);

  // 弹层挂在 body 上：对话框有 backdrop-filter，会裁剪/压盖内部 popup
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const left = Math.max(10, Math.min(rect.left, window.innerWidth - POP_W - 10));
      const below = rect.bottom + 6;
      const top = below + POP_H > window.innerHeight - 10
        ? Math.max(10, rect.top - POP_H - 6)
        : below;
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const patch = (next: Partial<LocalDate>) => onChange(emitLocalDate({ ...selected, ...next }));

  const monthLabel = `${view.y} 年 ${view.mo + 1} 月`;
  const firstWeekday = new Date(view.y, view.mo, 1).getDay();
  const daysInMonth = new Date(view.y, view.mo + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const shiftMonth = (delta: number) => {
    const next = new Date(view.y, view.mo + delta, 1);
    setView({ y: next.getFullYear(), mo: next.getMonth() });
  };

  const clampNumber = (raw: string, min: number, max: number, fallback: number) => {
    if (raw === "") return min;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
  };

  return (
    <div className="dt-field">
      {label && <span className="dt-label">{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        className={`dt-trigger ${open ? "open" : ""}`}
        onClick={() => (open ? setOpen(false) : openPicker())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel || label || "选择日期时间"}
      >
        <span className="dt-value">{formatLocalDate(selected)}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M8 3v4M16 3v4M3 10h18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="dt-pop"
          role="dialog"
          aria-label={ariaLabel || label || "选择日期时间"}
          style={{ left: pos.left, top: pos.top }}
        >
          <header className="dt-pop-head">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="上个月">‹</button>
            <strong>{monthLabel}</strong>
            <button type="button" onClick={() => shiftMonth(1)} aria-label="下个月">›</button>
          </header>

          <div className="dt-week">
            {WEEKDAYS.map(day => <span key={day}>{day}</span>)}
          </div>

          <div className="dt-days">
            {cells.map((day, index) => {
              if (day === null) return <span key={`pad-${index}`} className="dt-day is-blank" />;
              const isSelected = selected.y === view.y && selected.mo === view.mo && selected.d === day;
              const isToday = nowParts.y === view.y && nowParts.mo === view.mo && nowParts.d === day;
              return (
                <button
                  key={`day-${day}`}
                  type="button"
                  className={`dt-day ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
                  onClick={() => patch({ y: view.y, mo: view.mo, d: day })}
                  aria-pressed={isSelected}
                >
                  {day}
                </button>
              );
            })}
          </div>

          <div className="dt-time">
            <span>时间</span>
            <input
              type="number"
              min={0}
              max={23}
              value={pad(selected.h)}
              onChange={event => patch({ h: clampNumber(event.target.value, 0, 23, selected.h) })}
              aria-label="小时"
            />
            <b>:</b>
            <input
              type="number"
              min={0}
              max={59}
              value={pad(selected.mi)}
              onChange={event => patch({ mi: clampNumber(event.target.value, 0, 59, selected.mi) })}
              aria-label="分钟"
            />
            <button
              type="button"
              className="dt-now"
              onClick={() => {
                const now = new Date();
                patch({
                  y: now.getFullYear(), mo: now.getMonth(), d: now.getDate(),
                  h: now.getHours(), mi: now.getMinutes(),
                });
                setView({ y: now.getFullYear(), mo: now.getMonth() });
              }}
            >
              此刻
            </button>
          </div>

          <footer className="dt-pop-foot">
            <span>精确到分钟；秒级记录不受影响</span>
            <button type="button" className="dt-done" onClick={() => setOpen(false)}>完成</button>
          </footer>
        </div>,
        document.body,
      )}
    </div>
  );
}
