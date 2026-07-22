# V11 historical-prediction regeneration plan

Goal: rebuild the 2026 season's prediction HISTORY (the as-of scrubbers, /vs
replay, corps snapshot charts) with v11, so every date's forecast is the v11
model's leakage-safe as-of view — with the original history preserved in a
standalone SQLite backup.

Inventory (measured 2026-07-22): `model_event_prediction_runs` season 2026 =
**2,560 runs / 81 events / 38 forecast days (2026-05-26 → 2026-07-22) / 1,449
distinct (event, day) pairs**. Composition: final2 2,391, v10.5 133, v11 25,
other 11.

## Phase 0 — Backup (before anything writes)

1. `sqlite3` dump of the FULL `model_event_prediction_runs` table (all seasons,
   not just 2026) into a fresh standalone DB:
   `/root/corps-place/sdk/backups/prediction-runs-backup-2026-07-22.db`
   (schema + rows via `.dump model_event_prediction_runs | sqlite3 <backup>`)
2. Verify: row count equality, and a sha256 over
   `prediction_id|model_dir|predicted_at` sorted — recorded in the backup DB in
   a small `backup_meta` table (source, date, count, sha).
3. Second copy off the hot path (e.g. `/home/patrick/` and/or the mini-PC) —
   the box has run out of disk before. Size ≈ tens of MB (payload JSON), fine.
4. Also snapshot the CURRENT read-model file (`/data/corps-place/read-model.<active>.db`
   copy) so the served artifact itself has a restore point.

## Phase 1 — Scope rules (what gets regenerated)

- **Regenerate (v11):** (event, day) pairs where the event is World/Open Class
  AND day ≥ the first scored 2026 show date (2026-06-26). ~1,050–1,150 pairs.
- **Keep original (final2):**
  - All-age / SoundSport / International events — v10/v11 cannot score them;
    final2 history stays (mirrors today's serving fallback).
  - **Preseason forecast days (2026-05-26 … 06-25)** — v11 as-of these dates
    has ZERO in-season data (every corps cold-start, curve-anchored); final2
    was purpose-built for preseason projection and is the honest "what we knew
    then". DECISION POINT: keep final2 preseason (recommended) vs regenerate
    anyway for a uniform v11 story. Plan assumes KEEP.
- Old runs in the regenerated scope are DELETED from the live table after the
  backup verifies (leaving them would make the as-of scrubber's
  latest-per-day pick order-dependent between old and backdated-new rows).
  Runs outside scope are untouched. Going forward, dual-write (v11 primary +
  v10.5 shadow) continues unchanged.

## Phase 2 — Regeneration mechanics (leakage-safe per day)

Driver script `cp-v10-serving/scripts/v11-regen-history.sh`, one outer loop per
forecast DAY (chronological), mirroring what the nightly pipeline would have
done on that day:

1. **As-of state:** build the serving contract + temporal state with
   `--development-cutoff <day>T23:59` (prepareV10TrainingData --serving +
   prepareV10TemporalFeatures --inference-events <that day's events>), exactly
   like v10.5-serve's A1 but with a historical cutoff. One state per day,
   reused for all of that day's events.
2. **Events for the day:** the (event, day) pairs from Phase 1 — i.e. each
   event that had a run stamped that day in the original history (preserves
   the original cadence; no invented days).
3. **Recal per day:** fit the per-division offset from a resolved pool
   strictly before <day> (same shrink/taper config), i.e. re-run the
   apply_recal fit with the historical date — NOT today's pool.
4. **Serve + save:** cleanV10ServeFP with the v11 ensemble,
   `--model-dir clean-v11-fp-shadow`, `--recal-json <day's offsets>`, and a
   NEW `--predicted-at <day>T<HH:MM>Z` override so the saved run is stamped on
   its historical day (small script extension; stamp minutes after the
   original run's predicted_at to keep intra-day ordering deterministic).
5. **Resume-safe:** driver records completed (event, day) pairs in a progress
   table; safe to stop/restart (the box has crashed before).

Runtime estimate: ~33 s per event-instance (measured from the backtest
harnesses) × ~1,100 ≈ **10 h CPU** on this box. Run overnight under
nohup+flock with the disk guard (abort if <3 GB free), or chunk by week.
Alternative: run on the mini-PC against a DB copy and import the runs (avoids
loading the prod box; adds transfer steps).

## Phase 3 — Cutover + downstream rebuild

1. Delete in-scope old runs (Phase 1 rule) in one transaction; insert already
   happened per-day (new rows coexist harmlessly until the delete because the
   as-of pick is latest-per-day and the new rows are stamped later within
   each day — verify this invariant on 2-3 days before the delete).
2. Re-emit the read-model (rebuilds `rm_event_prediction_snapshots`, /vs
   replay tables, corps season snapshots) + CF purge.
3. Sanity: snapshot-date dedupe still collapses unchanged days; per-event
   scrubber shows a continuous v11 history from 06-26; preseason pills still
   show final2 (if KEEP decision stands).

## Phase 4 — Verification (before declaring done)

- Counts: regenerated pairs == plan scope; no event lost days.
- Spot-check 3 events across the season (early July, Southwestern, an OC
  show): as-of totals monotonic-ish, no wild discontinuities at the
  final2→v11 boundary (2026-06-26); the boundary jump size documented.
- Accuracy audit (free byproduct): join regenerated as-of predictions vs
  actuals per day — publishes a true season-long v11 hindcast MAE curve,
  comparable to final2's (goes in docs/V11_HISTORY_REGEN_RESULTS.md).
- Browser: /vs replay + a corps profile as-of scrubber + one event's
  history pills.

## Rollback

Restore = `DELETE FROM model_event_prediction_runs WHERE season='2026'` +
re-import from the backup DB + re-emit the read-model. The backup DB is the
single source of truth for the pre-regen state; keep it permanently.

## Open decisions (need user sign-off before execution)

1. Preseason days (05-26…06-25): keep final2 (recommended) or regenerate?
2. Delete-after-backup vs keep-both-tagged: plan says delete in-scope old runs
   (cleaner as-of semantics); keeping them is possible but makes every as-of
   surface prefer-flagged-aware (more code churn).
3. Where to run the ~10 h compute: prod box overnight (simplest) vs mini-PC
   (zero prod load, more moving parts).
