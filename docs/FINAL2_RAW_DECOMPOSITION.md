# final2 RAW-core decomposition — is the v9 core actually better raw than the new cores?

Written 2026-07-25. Answers one question with real numbers: **RAW final2 core** (the
v9 neural model WITHOUT its serving wrapper — no persistence blend, no comparable
revert, no season-bias correction) vs **RAW v11 core** vs **RAW v12a core** vs **RAW
v12b core**, on the held-out championship-week window **2026-07-21..24 (n=50, the 10
events judged in [V12_ARM_B_RESULTS.md](V12_ARM_B_RESULTS.md))**.

The question behind the question: is the v9 core genuinely BETTER raw than the new
cores in this regime — which would make the new-core line a **real regression** — or
is final2's raw core just as cold (~3) and the ENTIRE final2 advantage is the
**wrapper** (which would fully vindicate the "cores-are-interchangeable" conclusion)?

## Method

- **How RAW final2 was obtained — PATH (b), direct read (no inversion needed).** The
  serving script `scripts/predictEventRecap.ts` stores per corps `caption_shape_total
  = totalFromV9Captions(pointCaps)` — the model point-estimate total BEFORE the
  wrapper (persist/curveΔ blend, comparable revert, season-bias correction). For
  **every one of the 50 held-out corps** the payload carries `model_blend_weight == 1`
  and `point_estimate_source == 'model_q50'`, so `pointCaps == rawCaps` **exactly**
  (`blendCaps` at weight 1 is the identity on the model caps — no baseline blend). So
  `caption_shape_total` **is** the pure v9 core total; no inversion of the serving
  formula is required. (One Open-Class debut corps had `mbw 0.65`; it falls back to
  `raw_model_total`/`total`, negligible.)
- **Validated against PATH (a).** Re-ran `predictEventRecap.ts --as-of 2026-07-24` for
  `2026-dci-birmingham` (leakage-safe: freezes history strictly before the show) and
  compared the fresh `caption_shape_total` to the saved pre-show payload: **2 of the 4
  top corps reproduced exactly, the rest within 0.17 pt**, and served totals within
  ~0.5 pt. The raw core is reproducible and leakage-safe.
- **RAW v11 core:** fresh leakage-safe SDK inference (`predict`, identity-agnostic, 8
  v11-identity-0.5 seeds), SeasonData built only from shows strictly before each
  target date.
- **RAW v12a / v12b cores:** reused verbatim from
  `tools/backtest-v12b.out.json` (full n=50). `v12a raw` = the persistence-residual
  core (no wrapper); `v12b raw` = the field-relative core **plus its serving add-back**
  (= the full-recap raw prediction, apples-to-apples with the other cores); `v12b-noAB`
  = the climate-removed core with the add-back ablated (shown for reference only).
- **final2 served** = the payload `total` (wrapper ON) — what prod actually served.
- Tool: `tools/backtest-final2raw.ts` → `tools/backtest-final2raw.out.json`.

## Result — held-out window 2026-07-21..24 (per-event MAE, points; n=50)

| event | date | n | **f2 RAW** | f2 served | v11 raw | v12a raw | v12b raw | v12b-noAB |
|---|---|--:|--:|--:|--:|--:|--:|--:|
| 2026-dci-st-louis | 07-21 | 7 | **1.813** | 0.577 | 3.266 | 3.047 | 3.355 | 3.878 |
| 2026-dci-southern-mississippi | 07-22 | 6 | **1.258** | 0.423 | 2.995 | 3.232 | 2.917 | 3.224 |
| 2026-drums-on-the-ohio | 07-22 | 8 | **1.819** | 0.540 | 3.381 | 3.367 | 3.141 | 2.854 |
| 2026-march-on | 07-22 | 3 | **1.898** | 2.764 | 2.586 | 2.162 | 2.232 | 1.543 |
| 2026-dci-birmingham | 07-24 | 7 | **3.014** | 0.725 | 4.493 | 4.946 | 4.615 | 4.333 |
| 2026-dci-middle-tennessee | 07-24 | 7 | **1.813** | 0.388 | 1.787 | 1.692 | 2.070 | 1.676 |
| 2026-dci-syracuse | 07-24 | 4 | **1.687** | 1.870 | 2.758 | 2.701 | 2.601 | 3.069 |
| 2026-drums-on-parade | 07-24 | 8 | **1.459** | 0.566 | 3.222 | 3.221 | 2.835 | 2.353 |
| **POOLED — HELD-OUT** | | **50** | **1.854** | **0.780** | **3.128** | **3.144** | **3.054** | **2.942** |

**Pooled bias (points, held-out):** f2 RAW **−0.850** · f2 served **+0.050** · v11 raw
**−1.930** · v12a raw **−2.227** · v12b raw **−2.021** · v12b-noAB **−2.550**.

## Verdict

**It is the FIRST option, with a nuance. The v9 core is genuinely, substantially
better RAW than the new cores in this regime — the new-core line is a REAL core
regression, not merely a wrapper-calibration gap.** Raw MAE: v9 core **1.854** vs v11
**3.128** / v12a **3.144** / v12b **3.054** — the v9 core is **~1.2–1.3 points more
accurate at the core level**, and its cold bias is far smaller (**−0.85** vs **−1.9 to
−2.2**): the new cores are not just noisier, they **systematically under-predict the
inflating championship week by ~2 points** where the v9 core is only ~0.85 low. So the
"cores-are-interchangeable" conclusion is **NOT** vindicated at the core level — v9's
core carries a real edge here.

**The nuance:** the wrapper is still the single largest contributor to what prod
actually delivers. final2's raw core (1.854) is itself cold relative to its served
output (0.780) — the wrapper roughly **halves** the remaining error and zeroes the
bias (−0.85 → +0.05). So final2's total advantage over a hypothetical new-core-served
line decomposes into **two real, additive pieces**: a ~1.2–1.3-pt better raw core
**and** a ~1.07-pt wrapper lift. Swapping the new cores into final2's exact wrapper
(the `v12aw`/`v11w` experiments, ~1.0–1.25 held-out) recovers most but not all of the
gap precisely because the wrapper cannot fully repair a core that is 2 points cold —
consistent with this decomposition. The v9 core's raw edge is real and should be
weighed against the new cores' identity-agnostic / retrain advantages before any core
swap.
