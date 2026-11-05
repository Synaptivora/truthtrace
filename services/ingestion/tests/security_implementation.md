# TT-01 implementation record

Baseline: 10202a6fc356abcee8e4d6b485bc58be45298875. This is a partial security implementation, not release approval.

Implemented: loopback-only CLI startup; required service token; exact loopback Host and optional Origin allowlist; authenticated sensitive GET/POST/download; bounded 25 MiB reads; malformed/negative/duplicate length and transfer encoding rejection; four concurrent POST slots; 30-second socket timeout; error envelopes without raw exception bodies; archive expansion, PDF page and image pixel prechecks.

Integration: Next must provide Authorization Bearer from TRUTHTRACE_INGESTION_TOKEN and Content-Length. Browser clients must proxy through Next; never expose the service token. Health remains unauthenticated with trusted Host. TRUTHTRACE_INGESTION_ORIGINS is an optional comma-separated exact allowlist, not authentication. Responses retain error plus code/message/traceId/retryable.

Validation: python -m py_compile services/ingestion/server.py passed; python -X utf8 services/ingestion/tests/security_boundary_test.py passed 7 tests. Tests cover health, protected reads, hostile Host/Origin, oversized and malformed lengths, valid synthetic chat, CORS and authenticated routing. Source inspection establishes pre-change unlimited read/default wildcard; a pre-change execution of these tests was not performed.

Unverified/blockers: CPU parsing hard timeout and process isolation; bounded HTTP accept/thread count; archive retention/cleanup and quota; dedicated 100 MiB archival path; symlink-based local storage tampering; complete channel HTTP regression with service-token updates; PDF/image dependency matrix. pypdf/Pillow are now required for PDF/image validation and absence fails closed. Existing anonymous HTTP tests require migration. Live source-list probing timed out after three seconds and encountered a GBK subprocess decode error; no live channel success is claimed. Real credentials, external models, and private materials were not used.

Rollback: revert this commit together with dependent Next service-auth integration. No persistent schema migration. Do not deploy rollback publicly because it restores known unsafe boundaries.

## Follow-up completion

Added bounded connection handling (16 threads), isolated /parse interpreter processes with a 30-second subprocess timeout (Python kills and waits on timeout), archive exclusive cross-process lock, 250 MiB archive quota and seven-day cleanup limited to managed archive filenames. Stale lock after a killed writer fails closed and requires inspection/removal; it cannot bypass quota. Upload download rejects symlinks.


Validation: `python services/ingestion/tests/run_all.py`: 14 passed, 0 failed (38 seconds); `python -X utf8 services/ingestion/tests/security_boundary_test.py`: 8 passed. These are deterministic/local-fixture tests, not live channel or model evaluation.

Remaining boundaries: /source operations retain in-process session state and are not hard-killed on CPU deadline; /parse_chat media work likewise still runs in-process. No OS memory sandbox or process-tree containment is claimed. Dedicated 100 MiB archive-only ingress remains unimplemented; requests above 25 MiB fail closed. Complete runtime isolation of stateful channel operations requires an explicit worker/session protocol and is deferred for architectural review rather than silently breaking channel continuity.

## Chat media and authority hardening
External parse_chat rejects media_dir and absolute/traversal media paths; relative attachment references become explicit missing-media placeholders without any filesystem probing. Byte-backed media remains supported. Trusted internal callers may supply a managed root, with canonical containment, link rejection and stat plus bounded reads. Chat parsing now runs in a 30-second subprocess and shares archive/page/pixel validation after MIME sniffing. Host must exactly match the listener port; duplicate Host is rejected. Downloads share the four-request semaphore. Body ingestion and download writes have absolute 30-second deadlines (stateful source operations still require separate worker/session isolation and are not claimed to have a CPU kill deadline).
Validation: 13 focused security tests passed; 14 Python regression suites passed. Multiplatform HTTP fixtures now upload explicit media bytes rather than authorize filesystem roots. Path tests use temporary synthetic files only. Link rejection is unit-tested via a mocked is_symlink result, not claimed as a Windows junction integration test. No live channel/model evaluation.

