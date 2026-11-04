# TT-01 implementation record

Baseline: 10202a6fc356abcee8e4d6b485bc58be45298875. This is a partial security implementation, not release approval.

Implemented: loopback-only CLI startup; required service token; exact loopback Host and optional Origin allowlist; authenticated sensitive GET/POST/download; bounded 25 MiB reads; malformed/negative/duplicate length and transfer encoding rejection; four concurrent POST slots; 30-second socket timeout; error envelopes without raw exception bodies; archive expansion, PDF page and image pixel prechecks.

Integration: Next must provide Authorization Bearer from TRUTHTRACE_INGESTION_TOKEN and Content-Length. Browser clients must proxy through Next; never expose the service token. Health remains unauthenticated with trusted Host. TRUTHTRACE_INGESTION_ORIGINS is an optional comma-separated exact allowlist, not authentication. Responses retain error plus code/message/traceId/retryable.

Validation: python -m py_compile services/ingestion/server.py passed; python -X utf8 services/ingestion/tests/security_boundary_test.py passed 7 tests. Tests cover health, protected reads, hostile Host/Origin, oversized and malformed lengths, valid synthetic chat, CORS and authenticated routing. Source inspection establishes pre-change unlimited read/default wildcard; a pre-change execution of these tests was not performed.

Unverified/blockers: CPU parsing hard timeout and process isolation; bounded HTTP accept/thread count; archive retention/cleanup and quota; dedicated 100 MiB archival path; symlink-based local storage tampering; complete channel HTTP regression with service-token updates; PDF/image dependency matrix. pypdf/Pillow are now required for PDF/image validation and absence fails closed. Existing anonymous HTTP tests require migration. Live source-list probing timed out after three seconds and encountered a GBK subprocess decode error; no live channel success is claimed. Real credentials, external models, and private materials were not used.

Rollback: revert this commit together with dependent Next service-auth integration. No persistent schema migration. Do not deploy rollback publicly because it restores known unsafe boundaries.
