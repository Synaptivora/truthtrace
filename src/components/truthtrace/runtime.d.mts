import type { CaseAnalysis } from "./api-client";

export function mountStudio(root: HTMLElement, bridge: {
  onContext?: (context: { evidence: import("@/lib/contracts").Evidence[]; caseName?: string } | null) => void;
  assets: Record<string, string>;
  analyzeFiles: (files: File[], signal: AbortSignal, onParsed: () => void) => Promise<CaseAnalysis>;
  onAnalysisReady: (result: CaseAnalysis) => void;
}): () => void;
