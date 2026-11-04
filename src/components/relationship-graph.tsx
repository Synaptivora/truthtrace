"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Controls, Panel, ReactFlow } from "@xyflow/react";
import type { Edge, Node, NodeChange, ReactFlowInstance, XYPosition } from "@xyflow/react";
import { Building2, MapPin } from "lucide-react";
import type { AnalysisResult, Evidence } from "@/lib/contracts";
import { EvidenceThumbnail, PixelPerson } from "./truthtrace/evidence-thumbnail";

import styles from "./relationship-graph.module.css";

const noEvidence: Evidence[] = [], noFocus: string[] = [];
const WIDTH = 244, GAP_X = 54, GAP_Y = 58, PERSON_HEIGHT = 112;

export function RelationshipGraph({ analysis, evidence = noEvidence, focusedEvidenceIds = noFocus, onOpenEvidence }: {
  analysis: AnalysisResult; evidence?: Evidence[]; focusedEvidenceIds?: string[]; onOpenEvidence?: (id: string) => void;
}) {
  const [personId, setPersonId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, XYPosition>>({});
  const [canvasWidth, setCanvasWidth] = useState(900);
  const [relationshipId, setRelationshipId] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const relationships = useMemo(() => analysis.relationships.filter(r => analysis.analysisMode === "model" || !/^同一会话|同群|共同出现/.test(r.label)), [analysis]);
  const selectedRelationship = relationships.find(r => r.id === relationshipId);
  const visibleEvidence = showSources || !analysis.people.length || focusedEvidenceIds.length ? evidence : noEvidence;
  const selectedPerson = analysis.people.find(person => person.id === personId);
  const canvas = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance | null>(null);
  const columns = Math.min(3, Math.max(analysis.people.length, visibleEvidence.length, 1), Math.max(1, Math.floor((canvasWidth - 48) / 270)));
  const evidenceTop = analysis.people.length ? Math.ceil(analysis.people.length / columns) * (PERSON_HEIGHT + GAP_Y) + 50 : 0;
  const selectedSources = useMemo(() => selectedPerson?.evidenceRefs.map(ref => ref.evidenceId) || noFocus, [selectedPerson]);

  const nodes = useMemo<Node[]>(() => [
    ...analysis.people.map((person, index) => ({
      id: person.id,
      position: positions[person.id] || { x: (index % columns) * (WIDTH + GAP_X), y: Math.floor(index / columns) * (PERSON_HEIGHT + GAP_Y) },
      data: { label: <div className="graph-person-card">
        <span className="graph-portrait">{/(公司|工作室|机构|协会)$/.test(person.name) || /^(组织|机构|企业)$/.test(person.role) ? <Building2 /> : /^(地点|场所|地址)$/.test(person.role) ? <MapPin /> : <PixelPerson name={person.name} />}</span>
        <span className="graph-card-copy"><span>{person.role}</span><strong>{person.name}</strong></span>
      </div> },
      className: `graph-paper-node ${person.id === personId ? "is-focused" : ""}`,
      style: { width: WIDTH },
      ariaLabel: `${person.name}，${person.role}，点击查看便签`,
    })),
    ...visibleEvidence.map((item, index) => ({
      id: `evidence:${item.id}`,
      position: positions[`evidence:${item.id}`] || { x: (index % columns) * (WIDTH + GAP_X), y: evidenceTop + Math.floor(index / columns) * 238 },
      data: { label: <button className="contract-graph-evidence nodrag" title={item.name} onClick={() => onOpenEvidence?.(item.id)}><EvidenceThumbnail item={item} /><span className="graph-evidence-copy"><small>E-{String(index + 1).padStart(2, "0")}</small><strong>{/^(微信图片|IMG[_-]|image[_-]|Screenshot[_-])/i.test(item.name) ? `图片材料 ${index + 1}` : item.name}</strong></span></button> },
      className: `graph-paper-node graph-evidence-node ${focusedEvidenceIds.includes(item.id) || selectedSources.includes(item.id) ? "is-focused" : ""}`,
      style: { width: WIDTH, opacity: focusedEvidenceIds.length && !focusedEvidenceIds.includes(item.id) ? 0.4 : 1 },
    })),
  ], [analysis.people, visibleEvidence, columns, evidenceTop, focusedEvidenceIds, onOpenEvidence, positions, personId, selectedSources]);

  const edges = useMemo<Edge[]>(() => [
    ...relationships.filter(r => !personId || r.sourcePersonId === personId || r.targetPersonId === personId).map(relationship => ({
      id: relationship.id, source: relationship.sourcePersonId, target: relationship.targetPersonId,
      label: relationship.id === relationshipId ? (relationship.label.length > 18 ? relationship.label.slice(0, 18) + "…" : relationship.label.trim() || undefined) : undefined,
      style: { stroke: "#a63d2d", strokeWidth: relationship.id === relationshipId ? 3 : 2, opacity: relationshipId && relationship.id !== relationshipId ? 0.25 : 1 }, labelStyle: { fill: "#51381f", stroke: "none", fontSize: 12 },
      labelBgStyle: { fill: "#ebd9ad", fillOpacity: 0.96 }, labelBgPadding: [8, 5] as [number, number],
    })),
    ...analysis.people.flatMap(person => [...new Set(person.evidenceRefs.map(ref => ref.evidenceId))]
      .filter(id => visibleEvidence.some(item => item.id === id) && (person.id === personId || showSources))
      .map(id => ({ id: `source:${person.id}:${id}`, source: person.id, target: `evidence:${id}`, style: { stroke: "#b28a50", strokeWidth: 2 } }))),
  ], [relationships, analysis.people, visibleEvidence, personId, relationshipId, showSources]);

  const goToTop = useCallback(() => {
    const instance = flow.current, element = canvas.current;
    if (!instance || !element) return;
    const width = columns * WIDTH + (columns - 1) * GAP_X;
    const zoom = Math.min(1, Math.max(0.25, (element.clientWidth - 64) / width));
    void instance.setViewport({ x: (element.clientWidth - width * zoom) / 2, y: (element.querySelector(".graph-toolbar")?.getBoundingClientRect().height || 40) + 24, zoom });
  }, [columns]);
  const resetView = useCallback(() => {
    const instance = flow.current, element = canvas.current;
    if (!instance || !element) return;
    if (focusedEvidenceIds.length) {
      void instance.fitView({ nodes: focusedEvidenceIds.map(id => ({ id: `evidence:${id}` })), padding: 0.2, maxZoom: 1.15, duration: 250 });
    } else {
      goToTop();
    }
  }, [focusedEvidenceIds, goToTop]);
  useEffect(() => { const frame = requestAnimationFrame(resetView); return () => cancelAnimationFrame(frame); }, [resetView]);
  useEffect(() => {
    const element = canvas.current; if (!element) return;
    const observer = new ResizeObserver(() => { setCanvasWidth(element.clientWidth); resetView(); }); observer.observe(element); return () => observer.disconnect();
  }, [resetView]);
  function moveNodes(changes: NodeChange[]) {
    const moves = changes.filter(change => change.type === "position" && change.position);
    if (moves.length) setPositions(previous => { const next = { ...previous }; for (const change of moves) if (change.type === "position" && change.position) next[change.id] = change.position; return next; });
  }

  if (!analysis.people.length && !evidence.length) return <div className="empty-state">当前结果没有可绘制的人物或材料。</div>;
  return <div ref={canvas} className={`graph-canvas ${styles.root}`} onKeyDown={event=>{if(event.key==="Escape"){setRelationshipId(null);setPersonId(null);}}} aria-label="人物与材料关系图">
    <div className="graph-toolbar"><details className={styles.coverage}><summary>材料引用 · {analysis.people.filter(person=>person.evidenceRefs.some(ref=>evidence.some(item=>item.id===ref.evidenceId))).length}/{analysis.people.length} 人物</summary><p>{analysis.people.length?"统计人物是否关联当前案件中的材料，不表示引用逐字校验或事实已经证实。":"当前没有人物候选。导入材料或完成分析后再查看引用覆盖。"}</p><p>材料共 {evidence.length} 份 · 历史版本请从引用入口核对。互动次数不代表关系亲密或存在合谋。</p></details><label>关注人物<select aria-label="关注人物" value={personId || ""} onChange={event => { setPersonId(event.target.value || null); setRelationshipId(null); }}><option value="">全部人物</option>{analysis.people.map(person => <option value={person.id} key={person.id}>{person.name}</option>)}</select></label><label><input type="checkbox" checked={showSources} onChange={event => setShowSources(event.target.checked)} />显示材料连线</label><details><summary>互动清单 · {relationships.length}</summary>{relationships.length ? relationships.map(relationship => <button key={relationship.id} onClick={() => { setPersonId(null); setRelationshipId(relationship.id); }}>{analysis.people.find(person => person.id === relationship.sourcePersonId)?.name} → {analysis.people.find(person => person.id === relationship.targetPersonId)?.name}：{relationship.label}</button>) : <p>尚无足够依据连接人物。同群出现不代表实际关系，可用模型进一步分析。</p>}</details></div>
    <ReactFlow key={analysis.generatedAt} nodes={nodes} edges={edges} onNodesChange={moveNodes} onNodeClick={(_, node) => { if (analysis.people.some(person => person.id === node.id)) setPersonId(node.id); setRelationshipId(null); }} onEdgeClick={(_, edge) => { if (relationships.some(relationship => relationship.id === edge.id)) { setRelationshipId(edge.id); setPersonId(null); } }} onPaneClick={() => { setPersonId(null); setRelationshipId(null); }} onInit={instance => { flow.current = instance; resetView(); }} minZoom={0.1} maxZoom={1.8} panOnDrag preventScrolling ariaLabelConfig={{ "controls.ariaLabel": "画布控制", "controls.zoomIn.ariaLabel": "放大关系图", "controls.zoomOut.ariaLabel": "缩小关系图", "controls.fitView.ariaLabel": "查看整张关系图" }}>
      <Controls showInteractive={false} />
      <Panel position="bottom-right"><button className="graph-reset" onClick={goToTop}>回到顶部 ↑</button></Panel>
    </ReactFlow>
    {selectedRelationship && <aside className="graph-person-peek" aria-label="关系依据"><button className="peek-close" onClick={() => setRelationshipId(null)} aria-label="关闭关系依据">×</button><small>材料中提及的互动 · {analysis.analysisMode === "model" ? "模型整理" : "明确提及"}</small><h3>{selectedRelationship.label}</h3><p>{analysis.people.find(person => person.id === selectedRelationship.sourcePersonId)?.name} → {analysis.people.find(person => person.id === selectedRelationship.targetPersonId)?.name}</p>{selectedRelationship.evidenceRefs.map((ref, index) => <div key={index}><blockquote>{ref.quote}</blockquote><button disabled={!onOpenEvidence||!evidence.some(e=>e.id===ref.evidenceId)} onClick={() => onOpenEvidence?.(ref.evidenceId)}>{evidence.some(e=>e.id===ref.evidenceId)?"查看当前材料":"来源暂不可用"}</button></div>)}</aside>}
    {selectedPerson && <aside className="graph-person-peek" aria-label="主体便签"><button className="peek-close" onClick={() => setPersonId(null)} aria-label="关闭便签">×</button><small>{selectedPerson.role}</small><h3>{selectedPerson.name}</h3><p>{selectedPerson.summary}</p><details><summary>展开档案与来源</summary><p>别名：{selectedPerson.aliases.join("、") || "未记录"}</p>{selectedPerson.evidenceRefs.map((ref, i) => <button key={i} onClick={() => onOpenEvidence?.(ref.evidenceId)}>{evidence.find(e => e.id === ref.evidenceId)?.name || ref.evidenceId} ↗</button>)}</details></aside>}
  </div>;
}
