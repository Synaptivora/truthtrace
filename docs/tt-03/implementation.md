# TT-03 transport security implementation

Baseline: 10202a6fc356abcee8e4d6b485bc58be45298875. No database migration.

DNS answers are checked before credentials are transmitted. Native HTTP(S) uses a pinned lookup, original TLS hostname verification, family selection, and no pooled agent or redirects. Public HTTPS is the default; private HTTP(S) requires exact comma-separated origins in TRUTHTRACE_MODEL_PRIVATE_ORIGINS (e.g. http://127.0.0.1:11434). No wildcard. DNS names explicitly authorized here trust their operator and resolved private addresses. Conservative special IPv4/IPv6 rejection may deny uncommon public endpoints; use a reviewed explicit origin exception. Only one validated address is attempted; no transparent retries.

60-second total timeout covers DNS and response. Responses stop at 8 MiB. Native system proxy environment variables are not used. HTTP errors keep safe status hints; network, cancellation and malformed responses use safe error codes, trace IDs and retryability. Usage is provider-reported, never estimated or billed as verified cost. Text/tool capability only becomes observed from returned content/calls; vision remains unknown. No claim of probe-based capability certification.

Server/saved connections remain atomic URL+key configurations; client input never falls back to a stored key. Resolved configurations are frozen against mutation. Existing encrypted connection files remain readable. No connection-ID schema migration is introduced; authenticated configuration management is TT-02's responsibility.

Validation: all original agent and reliability cases retained, adapted from global fetch mocks to native HTTP transport mocks; local HTTP integration verifies explicit origin authorization and no redirect following. Full unit suite and typecheck pass; targeted ESLint passes. No successful real-model quality evaluation. During initial full-suite execution two legacy fetch-mocked reliability tests unintentionally reached their configured external endpoint with fixture credentials and received HTTP 401; mocks are now adapted and subsequent suite passes offline apart from localhost tests.

Limitations: no multi-IP failover, proxy support or live-provider performance validation. Full TLS DNS-rebinding integration and deployment security review remain release gates. Revert TT-03 commits to roll back; no data changes.
