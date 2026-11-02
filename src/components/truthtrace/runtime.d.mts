import type { CaseAnalysis } from "./api-client";

export function mountStudio(root: HTMLElement, bridge: {
  onContext?: (context: { evidence: import("@/lib/contracts").Evidence[]; caseName?: string } | null) => void;
  cases: CaseAnalysis[];
  onOpenCase: (id: string) => void;
  assets: Record<string, string>;
  analyzeFiles: (files: File[], signal: AbortSignal, onParsed: () => void) => Promise<CaseAnalysis>;
  onAnalysisReady: (result: CaseAnalysis) => void;
  // 「从钉钉/微信导入」入口：案件首页的按钮把渠道交给 React 覆盖层，DOM 流程不自己实现导入
  onOpenChannel?: (channel: "dingtalk" | "wechat") => void;
}): () => void;
