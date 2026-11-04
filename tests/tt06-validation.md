# TT-06 validation and migration record

Implementation retains dual executors and existing SQLite schema. WAL/busy_timeout are preserved. Schema v2 adds authoritative lease epoch/revision/active counters, content-addressed task snapshots, and revision history. Old body snapshots migrate transactionally and idempotently. Claim epochs fence even a reused owner ID. Runtime heartbeats update only scalar SQL columns; step commits check expected step and run inside the owned transaction. Reports use the same lease check. Lifetime model/tool/active budgets (120/360/90 minutes) survive revise; existing per-revision limits remain (40/120/30 minutes).

Evidence versions are assigned by Store; a supplied version is ignored. Reverting v1->v2->v1 creates v3. Historical exact version lookup never falls back to latest. Case updates stale prior tasks and pause in-flight work; the panel explicitly warns that findings use old material. Internal source collection updates its current snapshot inside the existing owned transaction. Public case/evidence APIs remain compatible; summary query is opt-in and the panel now polls summaries then retrieves details on changes.

Validation: typecheck passed; 127 tests / 20 files passed; lint 0 errors, one pre-existing channel-import img warning. New tests cover same-owner lease takeover, stale results, lifetime budget retention, authoritative versions, scalar heartbeat body stability, backup/restore and repeated legacy migration. Existing 20 investigator tests passed.

Measured local synthetic workload (milliseconds; 30 heartbeat samples each):

| segments | task create+claim | heartbeat p50 | p95 | list | WAL growth bytes | RSS bytes |
|---|---:|---:|---:|---:|---:|---:|
|100|7.36|0.442|0.623|0.130|123600|83042304|
|1000|103.37|0.426|0.507|0.096|0|108449792|
|10000|1121.00|0.407|0.578|0.116|0|357310464|

Zero WAL file growth means allocated WAL space was reused, not zero writes. These are one-machine synthetic measurements, not production throughput claims. Full detail hydration and model context still consume memory; snapshot separation primarily fixes heartbeat/list amplification.

Backup API uses VACUUM INTO, file hashes and fresh destination restore with integrity_check. Operators must stop ingestion/deletion while backing up. DPAPI keys may require reconnecting models on another OS account. Backup does not promise multi-process object-deletion coordination. Restore rejects overwritten destinations, traversal, symlinks and altered files. No destructive automatic schema downgrade. Rollback uses pre-migration full backup plus old app, rather than mixing old app writes into a v2 database.

Pending integration: TT05 adds public EvidenceSchema.version; TT08 derived index is separately integrated after its API freezes. Browser/build regression must run on the combined integration tree. No live models, real channels or private material used.

## Restore hardening and TT-08 integration

Restore now requires a strict, nonempty, unique-path manifest containing cases.sqlite. Every entry resolves through realpath within the backup root; parent junction/symlink escapes are rejected. Before copying, read-only SQLite validation checks schema version, integrity, every historical evidence object/content hash, required originals and task snapshot hashes. Tests cover empty/missing/duplicate manifests, missing objects and a real parent directory junction escape.

Store indexes newly saved evidence transactionally and lazily rebuilds missing historical versions. Case search derives grants from server case state. Runtime search derives grants only from the immutable task snapshot and maps ranked hits back to its authorized original segments; latest evidence never replaces historical task content. Retrieval is bounded to 100 index hits per tool search and explicitly reports unreturned matches; no claim of exhaustive recall. Cases search supports page offsets. Query expansions are returned for audit. Full test run after integration: 135 tests / 25 files passed.
