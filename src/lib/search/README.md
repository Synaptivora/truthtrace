# Isolated search library (TT-08)

Not connected to the UI, runner, runtime, API or Store yet. No user-facing search completion is claimed.

Integration surface:

- `segmentEvidence({caseId,evidenceId,version,content,kind,source?,anchors?})` returns stable hashed IDs and original UTF-16 half-open offsets. Default splits by source lines; caller-supplied validated anchors carry real message IDs or PDF page numbers. No page, message, OCR or image coordinates are inferred. Images yield no text segments. Overlong anchors split without breaking surrogate pairs. Blank-line gaps remain in the original; they are not represented as searchable segments.
- `new EvidenceIndex(databaseSync)` adds only `tt_search_segments`/`tt_search_fts` and a scope index. Uses FTS5 trigram, failing visibly if unavailable. Store owner supplies a connection and migration/backup policy; do not call during concurrent writes from another owner. Atomic `replaceVersion(scope,segments)` replaces a derived index for one version and retains other versions. Rebuild from original/versioned segments; this index is never the source of truth.
- `search(query,{authorizedVersions,source?,topK?,offset?,expand?})`: pass **server-derived authorization**, never trust a client-supplied list. Filters case/evidence/version in SQL; empty grants return no data. Limit 256 version grants, topK 1–100. Results include total/nextOffset and counts of authorized/returned/unreturned segments. These counts describe retrieval only, not read coverage or factual verification. FTS syntax is quoted as literal input. Long queries use exact phrase matching; 1–2 codepoint queries use substring lookup. No embedding dependencies.
- `counterevidenceQueries(topic)` returns auditable proposed searches only; caller must execute and log them. Suggestions are not a completeness guarantee or semantic adjudication. Optional expand:true adds a small auditable lexical-variant dictionary; returned queries records the actual alternatives. These include potentially non-equivalent terms (e.g. 定金/订金) to improve retrieval, never to assert legal or semantic equivalence. nearby(segmentId,options,radius=1) returns up to 11 neighbours from the same authorized case/evidence/version/source; it does not mark them read.

TT-05 adapter: preserve IDs, versions and offsets in provenance; whole-file fallback when an original anchor is absent. Search hits do not mark evidence read. TT-06 adapter: derive index only after committed evidence revisions, use authorized current/historical scopes explicitly, remove/rebuild indexes on deletion/restore. No migration has been applied to production Store.

Verification: `node node_modules/vitest/vitest.mjs run tests/evidence-search.test.ts`; `node --import tsx src/lib/search/benchmark.ts`. The unspaced Chinese fixture demonstrates unicode61 misses the substring `未到账` while trigram finds it. This is a tokenizer check, not a broad recall or semantic-quality claim. Benchmark uses synthetic messages at 100/1000/10000 segments and reports actual local time/RSS, no disk/WAL claim. No real models or private data.

Measured locally (Node 24, memory database): 100/1000/10000 segments built in 1.97/18.53/90.79 ms; query p50 0.46/5.03/162.62 ms and p95 0.80/5.45/166.41 ms, RSS ~71/74/108 MB. This exposes a 10k-segment latency cost, not a performance target achieved. Disk/WAL results follow below.

## Follow-up validation

Eight authored synthetic lexical-gold cases contain 13 relevant segments: exact retrieval Recall@5 = 8/13; expanded Recall@5 and Recall@10 = 13/13. These deliberately test the dictionary, dates, amounts and a negative statement; independent human review and broader semantic recall are still pending. No LLM judges or model calls.

Disk WAL benchmark (temporary synthetic SQLite file, autocheckpoint disabled during measurement):

|Segments|Build ms|Query p50 ms|Query p95 ms|WAL bytes|
|---|---:|---:|---:|---:|
|100|1.82|0.46|0.82|152472|
|1000|13.52|5.14|7.71|815792|
|10000|172.62|178.16|263.26|7271832|

RSS at 10k disk rows was about 109 MB. Not a concurrent-worker stress test. Files are closed and the dedicated temporary benchmark directory removed afterward. Scope requests above 256 grants throw an explicit batching error, never silently omit evidence; the service must partition trusted grants and expose aggregate pagination/coverage or return the error. Version removal can use replaceVersion(scope,[]); full rebuild belongs to Store's migration/restore lifecycle.
