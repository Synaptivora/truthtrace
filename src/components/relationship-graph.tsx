"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MarkerType, ReactFlow } from "@xyflow/react";
import type { Edge, Node, ReactFlowInstance } from "@xyflow/react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";

const noEvidence: Evidence[] = [];
const noFocus: string[] = [];
/** 人物卡片网格参数：宽度固定，高度按 4 行摘要估，间距留出连线标签的位置 */
const PERSON_COLUMNS = 3;
const PERSON_W = 200;
const PERSON_H = 186;
const PERSON_GAP_X = 46;
const PERSON_GAP_Y = 62;
export function RelationshipGraph({ analysis, evidence = noEvidence, focusedEvidenceIds = noFocus, onOpenEvidence }: {
  analysis: AnalysisResult;
  evidence?: Evidence[];
  focusedEvidenceIds?: string[];
  onOpenEvidence?: (id: string) => void;
}) {
  const [personId, setPersonId] = useState<string | null>(null);
  const selectedPerson = analysis.people.find(person => person.id === personId);
  const canvas = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  // 材料卡片接在人物网格下面，避免人物的摘要溢出后盖住材料
  const evidenceTop =
    (Math.ceil(analysis.people.length / PERSON_COLUMNS) * (PERSON_H + PERSON_GAP_Y) || 0) +
    (analysis.people.length ? 70 : 0);
  const nodes = useMemo<Node[]>(
    () =>
      [...analysis.people.map((person, index) => {
        // 网格布局，不再把人物摆成半径 145 的圆：4 个人时圆心角只有 90°，
        // 176px 宽的卡片一定互相压住（实测「本人」和「97个涨停板」直接叠在一起）。
        const column = index % PERSON_COLUMNS;
        const row = Math.floor(index / PERSON_COLUMNS);
        return {
          id: person.id,
          position: {
            x: column * (PERSON_W + PERSON_GAP_X),
            y: row * (PERSON_H + PERSON_GAP_Y),
          },
          data: {
            label: (
              <div className="graph-node-content">
                <span className="graph-node-role">{person.role}</span>
                <strong>{person.name}</strong>
                <span>查看便签 ↗</span>
              </div>
            ),
          },
          style: {
            width: PERSON_W,
            border: "1px solid #b78d53",
            borderRadius: 4,
            background: "#ecddbc",
            color: "#503820",
            boxShadow: "0 12px 36px rgba(0,0,0,.24)",
          },
        };
      }), ...evidence.map((item, index) => ({
        id: `evidence:${item.id}`,
        position: { x: (index % 4) * 210, y: evidenceTop + Math.floor(index / 4) * 150 },
        data: { label: <button className="contract-graph-evidence nodrag" onClick={() => onOpenEvidence?.(item.id)}><small>原始材料 / {index + 1}</small><strong>{item.name}</strong><span>打开原文 ↗</span></button> },
        style: { width: 180, border: focusedEvidenceIds.includes(item.id) ? "3px solid #ffe0a0" : "1px solid #b78d53", borderRadius: 4, background: "#ecddbc", color: "#503820", boxShadow: focusedEvidenceIds.includes(item.id) ? "0 0 25px #ffcc7580" : "2px 7px 12px #35200f55", opacity: focusedEvidenceIds.length && !focusedEvidenceIds.includes(item.id) ? 0.35 : 1 },
      }))],
    [analysis.people, evidence, evidenceTop, focusedEvidenceIds, onOpenEvidence],
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

  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const observer = new ResizeObserver(() => { void flow.current?.fitView({ padding: 0.25, duration: 0, nodes: focusedEvidenceIds.length ? focusedEvidenceIds.map(id => ({ id: `evidence:${id}` })) : undefined }); });
    observer.observe(element); return () => observer.disconnect();
  }, [focusedEvidenceIds]);

  if (analysis.people.length === 0 && evidence.length === 0) {
    return <div className="empty-state">当前结果没有可绘制的人物关系。</div>;
  }

  return (
    <div ref={canvas} className="graph-canvas" aria-label="人物与材料关系图">
      <ReactFlow ariaLabelConfig={{ "controls.ariaLabel": "画布控制", "controls.zoomIn.ariaLabel": "放大关系图", "controls.zoomOut.ariaLabel": "缩小关系图", "controls.fitView.ariaLabel": "适应画布" }} onNodeClick={(_, node) => { if (analysis.people.some(p => p.id === node.id)) setPersonId(node.id); }} onPaneClick={() => setPersonId(null)} nodes={nodes} edges={edges} onInit={instance => { flow.current = instance; }} fitView minZoom={0.2} maxZoom={1.8} proOptions={{ hideAttribution: false }}>
        <Background color="#a77f47" gap={27} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {selectedPerson && <aside className="graph-person-peek" aria-label="主体便签"><button className="peek-close" onClick={() => setPersonId(null)} aria-label="关闭便签">×</button><small>人物 / 主体 · {selectedPerson.role}</small><h3>{selectedPerson.name}</h3><p>{selectedPerson.summary}</p><details><summary>展开档案与来源</summary><p>别名：{selectedPerson.aliases.join("、") || "未记录"}</p>{selectedPerson.evidenceRefs.map((ref, i) => <button key={i} onClick={() => onOpenEvidence?.(ref.evidenceId)}>{evidence.find(e => e.id === ref.evidenceId)?.name || ref.evidenceId} ↗</button>)}</details></aside>}
    </div>
  );
}
