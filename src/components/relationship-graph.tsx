"use client";

import { useMemo } from "react";
import { Background, Controls, MarkerType, ReactFlow } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import type { AnalysisResult } from "@/lib/contracts";

export function RelationshipGraph({ analysis }: { analysis: AnalysisResult }) {
  const nodes = useMemo<Node[]>(
    () =>
      analysis.people.map((person, index) => {
        const angle = (index / Math.max(analysis.people.length, 1)) * Math.PI * 2 - Math.PI / 2;
        const radius = analysis.people.length > 1 ? 145 : 0;
        return {
          id: person.id,
          position: { x: 310 + Math.cos(angle) * radius, y: 200 + Math.sin(angle) * radius },
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
            border: "1px solid #2f5264",
            borderRadius: 12,
            background: "#10232d",
            color: "#edf6f7",
            boxShadow: "0 12px 36px rgba(0,0,0,.24)",
          },
        };
      }),
    [analysis.people],
  );

  const edges = useMemo<Edge[]>(
    () =>
      analysis.relationships.map((relationship) => ({
        id: relationship.id,
        source: relationship.sourcePersonId,
        target: relationship.targetPersonId,
        label: relationship.label,
        animated: true,
        style: { stroke: "#51c6c0", strokeWidth: 1.5 },
        labelStyle: { fill: "#b7cccf", fontSize: 11 },
        labelBgStyle: { fill: "#0b181f", fillOpacity: 0.94 },
        labelBgPadding: [6, 4] as [number, number],
        markerEnd: { type: MarkerType.ArrowClosed, color: "#51c6c0" },
      })),
    [analysis.relationships],
  );

  if (analysis.people.length === 0) {
    return <div className="empty-state">当前结果没有可绘制的人物关系。</div>;
  }

  return (
    <div className="graph-canvas" aria-label="人物关系图">
      <ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.45} maxZoom={1.6} proOptions={{ hideAttribution: false }}>
        <Background color="#28424d" gap={22} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
