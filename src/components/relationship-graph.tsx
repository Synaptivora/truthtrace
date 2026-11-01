"use client";

import { useEffect, useMemo, useRef } from "react";
import { Background, Controls, MarkerType, ReactFlow } from "@xyflow/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";

const noEvidence: Evidence[] = [];
const noFocus: string[] = [];
export function RelationshipGraph({ analysis, evidence = noEvidence, focusedEvidenceIds = noFocus, onOpenEvidence }: {
  analysis: AnalysisResult;
  evidence?: Evidence[];
  focusedEvidenceIds?: string[];
  onOpenEvidence?: (id: string) => void;
}) {
  const flow = useRef<ReactFlowInstance | null>(null);
  const nodes = useMemo<Node[]>(
    () =>
      [...analysis.people.map((person, index) => {
        const angle = (index / Math.max(analysis.people.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const radius = analysis.people.length > 1 ? 145 : 0;
        return {
          id: person.id,
          position: { x: 310 + Math.cos(angle) * radius, y: 120 + Math.sin(angle) * radius },
          data: {
            label: (
              <div className="graph-node-content">
                <span className="graph-node-role">{person.role}</span>
                <strong>{person.name}</strong>
                <span>{person.summary}</span>
              </div>
            ),
          },
          style: {
            width: 176,
            border: "1px solid #b78d53",
            borderRadius: 4,
            background: "#ecddbc",
            color: "#503820",
            boxShadow: "0 12px 36px rgba(0,0,0,.24)",
          },
        };
      }), ...evidence.map((item, index) => ({
        id: `evidence:${item.id}`,
        position: { x: (index % 4) * 210, y: 430 + Math.floor(index / 4) * 150 },
        data: { label: <button className="contract-graph-evidence" onClick={() => onOpenEvidence?.(item.id)}><small>原始材料 / {index + 1}</small><strong>{item.name}</strong><span>打开原文 ↗</span></button> },
        style: { width: 180, border: focusedEvidenceIds.includes(item.id) ? "3px solid #ffe0a0" : "1px solid #b78d53", borderRadius: 4, background: "#ecddbc", color: "#503820", boxShadow: focusedEvidenceIds.includes(item.id) ? "0 0 25px #ffcc7580" : "2px 7px 12px #35200f55", opacity: focusedEvidenceIds.length && !focusedEvidenceIds.includes(item.id) ? 0.35 : 1 },
      }))],
    [analysis.people, evidence, focusedEvidenceIds, onOpenEvidence],
  );

  const edges = useMemo<Edge[]>(
    () =>
      [...analysis.relationships.map((relationship) => ({
        id: relationship.id,
        source: relationship.sourcePersonId,
        target: relationship.targetPersonId,
        label: relationship.label,
        style: { stroke: "#ab4531", strokeWidth: 2 },
        labelStyle: { fill: "#51381f", fontSize: 11 },
        labelBgStyle: { fill: "#ebd9ad", fillOpacity: 0.94 },
        labelBgPadding: [6, 4] as [number, number],
        markerEnd: { type: MarkerType.ArrowClosed, color: "#ab4531" },
      })), ...analysis.people.flatMap(person => [...new Set(person.evidenceRefs.map(ref => ref.evidenceId))].filter(id => evidence.some(item => item.id === id)).map(id => ({
        id: `source:${person.id}:${id}`, source: person.id, target: `evidence:${id}`,
        style: { stroke: focusedEvidenceIds.includes(id) ? "#ffe0a0" : "#aa4a35", strokeWidth: focusedEvidenceIds.includes(id) ? 3 : 1.5 },
      })))],
    [analysis.relationships, analysis.people, evidence, focusedEvidenceIds],
  );

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void flow.current?.fitView({ nodes: focusedEvidenceIds.length ? focusedEvidenceIds.map(id => ({ id: `evidence:${id}` })) : undefined, padding: 0.25, duration: 350, maxZoom: 1.35 });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedEvidenceIds, nodes]);

  if (analysis.people.length === 0 && evidence.length === 0) {
    return <div className="empty-state">当前结果没有可绘制的人物关系。</div>;
  }

  return (
    <div className="graph-canvas" aria-label="人物关系图">
      <ReactFlow nodes={nodes} edges={edges} onInit={instance => { flow.current = instance; }} fitView minZoom={0.2} maxZoom={1.8} proOptions={{ hideAttribution: false }}>
        <Background color="#a77f47" gap={27} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
