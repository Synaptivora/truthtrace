"use client";

import { Clock3, Quote } from "lucide-react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";

import { mergeTimeline } from "./truthtrace/case-view";

type TimelineProps = {
  analysis: AnalysisResult;
  evidence: Evidence[];
  onOpenEvidence: (evidenceId: string) => void;
};

export function Timeline({ analysis, evidence, onOpenEvidence }: TimelineProps) {
  const events = mergeTimeline(analysis.events);

  if (events.length === 0) return <div className="empty-state">暂无可展示的事件。</div>;

  return (
    <div className="timeline-scroll">
      <div className="timeline">
        {events.map((event) => (
          <article className="timeline-item" key={event.id}>
            <div className="timeline-marker" />
            <div className="timeline-time">
              <Clock3 size={14} />
              {event.timeLabel}
            </div>
            <div className="timeline-card">
              <div className="timeline-card-heading">
                <h3>{event.title}</h3>
                <span className={`precision precision-${event.timePrecision}`}>
                  {event.timePrecision === "exact" ? "明确时间" : event.timePrecision === "approximate" ? "约略时间" : "时间未知"}
                </span>
              </div>
              {event.description.trim() !== event.title.trim() && <p>{event.description}</p>}
              <div className="evidence-chips">
                {[...new Map(event.evidenceRefs.map(ref => [ref.evidenceId, ref])).values()].map((ref, index) => {
                  const source = evidence.find((item) => item.id === ref.evidenceId);
                  return (
                    <button key={`${ref.evidenceId}-${index}`} onClick={() => onOpenEvidence(ref.evidenceId)}>
                      <Quote size={12} />
                      {source?.name ?? ref.evidenceId}
                    </button>
                  );
                })}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
