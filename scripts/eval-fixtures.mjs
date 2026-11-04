import assert from 'node:assert/strict';
import { cases, datasetVersion } from '../evals/cases.mjs';
export function validCitation(c, ref) {
  return c.evidence.some(e => e.caseId === ref.caseId && e.evidenceId === ref.evidenceId && e.version === ref.version && e.segmentId === ref.segmentId && typeof ref.quote === 'string' && ref.quote.length > 0 && e.text.includes(ref.quote));
}
assert.ok(cases.length >= 30 && cases.length <= 50);
assert.equal(new Set(cases.map(c => c.id)).size, cases.length);
for (const c of cases) {
  assert.equal(c.fictional, true);
  assert.ok(validCitation(c,c.gold.citation), c.id);
  for (const patch of [{caseId:'foreign'}, {version:99}, {quote:'fabricated'}, {segmentId:'unknown'}, {quote:''}]) assert.equal(validCitation(c,{...c.gold.citation,...patch}),false);
  assert.ok(['supported','unsupported','ambiguous','unchecked'].includes(c.gold.sourceSupport));
  assert.ok(['not_checked','corroborated','contradicted','unresolved'].includes(c.gold.factualVerification));
}
console.log(JSON.stringify({kind:'fixture-integrity-only',datasetVersion,cases:cases.length,systemQuality:'NOT_MEASURED',humanGoldReview:'PENDING'}));
