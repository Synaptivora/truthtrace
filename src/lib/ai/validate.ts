import {
  AnalysisPayloadSchema,
  AnalysisResultSchema,
  type AnalysisPayload,
  type AnalysisResult,
  type Evidence,
} from "../contracts";

export function validateAnalysis(
  input: unknown,
  evidence: Evidence[],
  analysisMode: AnalysisResult["analysisMode"],
  options: { looseQuoteIds?: Set<string> } = {},
): AnalysisResult {
  const payload: AnalysisPayload = AnalysisPayloadSchema.parse(input);
  // 正文被字符预算截断过的证据：模型读到的只是前半段，若仍要求引文逐字命中原文，
  // 证据一多就会大面积 502。对这几条只校验「引用的证据存在」。
  const loose = options.looseQuoteIds ?? new Set<string>();
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const peopleIds = new Set(payload.people.map((person) => person.id));
  const eventIds = new Set(payload.events.map((event) => event.id));

  const collections = [
    payload.people,
    payload.relationships,
    payload.events,
    payload.contradictions,
    payload.commitments,
    payload.evidenceGaps,
  ];

  if (evidenceIds.size !== evidence.length) throw new Error("证据 ID 重复");
  for (const collection of collections) {
    if (new Set(collection.map(item => item.id)).size !== collection.length) {
      throw new Error("分析结果 ID 重复");
    }
    for (const item of collection) {
      for (const ref of item.evidenceRefs) {
        if (!evidenceIds.has(ref.evidenceId)) {
          throw new Error(`模型引用了不存在的证据：${ref.evidenceId}`);
        }
        const source = evidence.find(item => item.id === ref.evidenceId)!;
        if (analysisMode === "model" && source.kind !== "image"
            && !loose.has(ref.evidenceId) && !source.content.includes(ref.quote)) {
          throw new Error(`引用原文不存在于证据：${ref.evidenceId}`);
        }
      }
    }
  }

  for (const relationship of payload.relationships) {
    if (!peopleIds.has(relationship.sourcePersonId) || !peopleIds.has(relationship.targetPersonId)) {
      throw new Error(`关系 ${relationship.id} 引用了不存在的人物`);
    }
  }

  for (const event of payload.events) {
    if (event.participantIds.some((id) => !peopleIds.has(id))) {
      throw new Error(`事件 ${event.id} 引用了不存在的人物`);
    }
  }

  for (const commitment of payload.commitments) {
    if (!peopleIds.has(commitment.personId)) {
      throw new Error(`承诺 ${commitment.id} 引用了不存在的人物`);
    }
  }

  for (const gap of payload.evidenceGaps) {
    if (gap.relatedEventIds.some((id) => !eventIds.has(id))) {
      throw new Error(`补证建议 ${gap.id} 引用了不存在的事件`);
    }
  }

  return AnalysisResultSchema.parse({
    ...payload,
    generatedAt: new Date().toISOString(),
    analysisMode,
  });
}
