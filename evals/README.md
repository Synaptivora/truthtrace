# Evaluation scaffold v1

32 wholly fictional cases cover support versus truth, counterevidence, OCR, truncation, permissions, recovery and budgets. Expectations are author-specified review candidates, **not independently human-reviewed gold**. Review each claim and rationale before using semantic scores as a release gate. Counterevidence fields currently identify relevant source text for review, not adjudicated retrieval relevance labels.

Run `node scripts/eval-fixtures.mjs`. This validates fixture identity/version/quote invariants and negative mutations only. It does not invoke production code, demonstrate actual authorization enforcement, measure recovery, or establish model quality. CI needs no dependencies or secrets.

Optional direct-provider baseline: explicitly set TT_EVAL_SEND=I_ACCEPT_SYNTHETIC_DATA_AND_COST, TT_EVAL_URL to an OpenAI-compatible HTTPS chat-completions endpoint, TT_EVAL_KEY, TT_EVAL_MODEL, TT_EVAL_OUTPUT to a local output path; optionally TT_EVAL_LIMIT (default 1, maximum 32). Run `node scripts/eval-model.mjs`. It sends only synthetic inputs, never the gold answers, and does not execute returned tools. Redirects are rejected; requests time out after 60 seconds; failures are sanitized and each completed attempt is checkpointed. No automatic retry. Keep output outside the repository; do not commit credentials or generated provider output.

Output records dataset/prompt/model versions, calls, latency and provider token usage when supplied. Cost is explicitly null because provider prices are unknown. There is no fabricated success score. This adapter bypasses TruthTrace and therefore is not an end-to-end Agent evaluation. Provider output remains untrusted. Only HTTPS OpenAI-compatible endpoints are supported here; production three-protocol support is untouched.

Next gate: independent human review and annotation provenance; production adapters returning stable citations, coverage and revision/fencing events; compare baseline/candidate with identical cases and settings. Citation identity/version/quote pass rate must be 100%; groundedness, counterevidence recall, false contradiction, coverage transparency, completion and recovery need reviewed labels and actual traces. Set semantic thresholds only after baseline measurement. Report unmeasured metrics as null, never zero or success.

No database migration. Rollback removes this independent scaffold/workflow. Existing production tests remain authoritative; no live model run has been performed.

## Production offline adapter (TT-07)

Run `npx tsx scripts/eval-production.mjs`. It executes production runAgent demo retrieval for 32 fictional records and production runTask with a scripted transport for valid/adversarial fact, timeline and deep modes. Outputs are actual returned citations and persisted tasks, not copied gold labels. The 73 checks measure identity/excerpt consistency, nonempty results, task completion and rejection of unknown artifact fields. Semantic groundedness, counterevidence recall, factual correctness, model quality, token and monetary costs remain NOT_MEASURED. Scripted model calls are explicitly separate from realModelCalls=0.

Use TT_EVAL_REPO to select a baseline checkout and TT_EVAL_OUTPUT for its JSON result; execute from this checkout to keep the adapter fixed. Compare using `node scripts/eval-compare.mjs baseline.json candidate.json comparison.json`. Reports require matching dataset/adapter versions and case sets. A failing baseline exits nonzero intentionally but still writes its report. No real-model evaluator is executed by CI; eval-model.mjs remains explicit opt-in and a direct-provider baseline, not a production quality claim.

Recorded comparison: baseline 6de389a63776ec108031f603bc49c1387a254d59 = 70/73 checks; candidate 8e67cd56bfc5d9c8448eaf651530af4e10001a6b = 73/73. Three gains are rejection of an unknown submitted artifact field in each investigation mode. These are deterministic security regressions only. Detailed synthetic outputs and comparison are included for review.

Gold audit: all labels are AI-authored pending independent human review. Removed indiscriminate counterevidence assignment for every case; unsupported evidence is not automatically counterevidence. SourceSupport labels and temporal/OCR interpretations still require adjudication before semantic scoring. Fixture coverage describes the provided excerpt, not historical dataset completeness. No human-approved quality threshold has been established.

No business files modified, no migration. Revert this evaluation commit to roll back.
