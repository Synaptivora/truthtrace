# TT-10 bounded replan validation

A strict server-side request_replan tool is exposed only at verification stage 6. The caller must identify existing affected claims and already-read text segments from the fixed task snapshot. It cannot inject new claims or widen evidence scope. A maximum of two loops is enforced in code; each loop returns to extraction (2), then verification (6), then report (7). Entity/timeline/conflict stages are not rerun. New claim IDs must be unique and every old/new claim must pass existing citation checks and receive verification before reporting.

Plan nodes retain task revision, loop round, dependencies, budgets, coverage segment targets and result references. Affected claims/derived findings are marked stale until the next complete verification. Replan requests and rounds are persisted in task state/events. Old tasks lazily derive template nodes; modes and old snapshots remain supported. Revisions reset the plan, not cumulative resource budgets.

executionOutcome distinguishes stop/wait_user/insufficient/completed while retaining existing state enums for UI compatibility. Hitting the replan cap yields paused+insufficient and a report explicitly states the result; a simple resume cannot turn it into completed or make another model call. A user can explicitly revise the task, still subject to lifetime budgets.

Validation: typecheck; 150 tests across 28 files passed before final cap-resume regression addition (same test case); targeted planner/stage/legacy investigator regressions passed. Synthetic deterministic model fixtures only. No assertion of real-model counterevidence recall or factual truth. UI still uses existing paused/waiting/completed labels; report carries explicit outcome and stale IDs.
