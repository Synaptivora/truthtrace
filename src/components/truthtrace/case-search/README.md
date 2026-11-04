# Global case search

Mounted on the actual home page by onboarding.mjs. GET/POST /api/case-search use secureRoute; the current local single-user mode authorizes stored cases, while remote mode fails closed. Client query parameters only filter server-selected cases and cannot supply grants. Person IDs select candidate-associated evidence, not verified identities; date filters match explicit dates in text, excluding undated segments with a visible explanation.

Tags/archive are a separate tt_case_metadata projection in the existing database; Store schema/types are untouched. Archiving hides search results by default and does not delete original evidence. Backup/restore must include this table. Revert this component/API/home mount to roll back; retained metadata is harmless to older code.

Search currently builds an ephemeral lexical index per request and processes each server-authorized evidence version, avoiding silent scope truncation above 256 versions. This favors correctness over persistent-index reuse until Store's index interface lands. More than 10000 matches explicitly fails, asking the user to narrow filters; it never silently truncates totals. Results remain separate per case and show version/source and not-checked status.

Opening a result places IDs/version/range only in sessionStorage key truthtrace.pending-locator.v1, then opens the case. TT11 consumes this locator after verifying the case/version. No private quote is persisted in browser storage. Commitments view uses the shared commitmentProjection for real global lists, status filtering and known-date sorting; it makes no assumed dates or breach judgments.

Tests: case-search.test.ts covers metadata, filtering, case boundaries, invalid grants and route authentication. browser-smoke.mjs starts a loopback production build with temporary synthetic data, uses a real browser session, searches and opens the commitments tab. Run after `next build`: `node src/components/truthtrace/case-search/browser-smoke.mjs`. It does not contact channels or models.
