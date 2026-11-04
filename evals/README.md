# Evaluation scaffold v1

32 wholly fictional cases cover support versus truth, counterevidence, OCR, truncation, permissions, recovery and budgets. Expectations are author-specified review candidates, **not independently human-reviewed gold**. Review each claim and rationale before using semantic scores as a release gate. Counterevidence fields currently identify relevant source text for review, not adjudicated retrieval relevance labels.

Run `node scripts/eval-fixtures.mjs`. This validates fixture identity/version/quote invariants and negative mutations only. It does not invoke production code, demonstrate actual authorization enforcement, measure recovery, or establish model quality. CI needs no dependencies or secrets.

Optional direct-provider baseline: explicitly set TT_EVAL_SEND=I_ACCEPT_SYNTHETIC_DATA_AND_COST, TT_EVAL_URL to an OpenAI-compatible HTTPS chat-completions endpoint, TT_EVAL_KEY, TT_EVAL_MODEL, TT_EVAL_OUTPUT to a local output path; optionally TT_EVAL_LIMIT (default 1, maximum 32). Run `node scripts/eval-model.mjs`. It sends only synthetic inputs, never the gold answers, and does not execute returned tools. Redirects are rejected; requests time out after 60 seconds; failures are sanitized and each completed attempt is checkpointed. No automatic retry. Keep output outside the repository; do not commit credentials or generated provider output.

Output records dataset/prompt/model versions, calls, latency and provider token usage when supplied. Cost is explicitly null because provider prices are unknown. There is no fabricated success score. This adapter bypasses TruthTrace and therefore is not an end-to-end Agent evaluation. Provider output remains untrusted. Only HTTPS OpenAI-compatible endpoints are supported here; production three-protocol support is untouched.

Next gate: independent human review and annotation provenance; production adapters returning stable citations, coverage and revision/fencing events; compare baseline/candidate with identical cases and settings. Citation identity/version/quote pass rate must be 100%; groundedness, counterevidence recall, false contradiction, coverage transparency, completion and recovery need reviewed labels and actual traces. Set semantic thresholds only after baseline measurement. Report unmeasured metrics as null, never zero or success.

No database migration. Rollback removes this independent scaffold/workflow. Existing production tests remain authoritative; no live model run has been performed.
