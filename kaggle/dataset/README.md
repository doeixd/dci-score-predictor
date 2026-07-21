# DCI Drum Corps Scores (2013-2026, cleaned)

Cleaned competition scores from **Drum Corps International (DCI)** for **World Class**
and **Open Class**, seasons **2013-2026**. Wide per-performance totals plus the eight
adjudication caption scores, with companion event, corps, per-caption, and
judge-assignment tables.

The **cleaning is the story.** DCI recap scores are posted publicly after each show,
but the raw feed is messy: caption names drift ("Visual Analysis" vs "Visual -
Analysis"), non-competitive showcases and exhibitions are mixed in, some rows carry
total-in-a-caption leakage or zeros, and caption sub-scores don't always reconcile to
the printed total. Every file here is derived from a curated domain view
(`clean_reference_curve_entries`) that:

- normalizes corps and caption names to canonical forms,
- restricts to the two model divisions (World Class, Open Class),
- drops showcases/exhibitions via an exclusion-pattern list,
- keeps only rows where the 8 caption scores reconcile to the printed total
  (|sum - total| <= 0.05) and every score is in a sane per-caption range,
- and computes a within-division rank from the total.

If you want the raw scrape, go to the DCI recaps directly. This dataset is the
model-ready, reconciled version.

## Files

| File | Rows | Grain |
|---|---|---|
| `scores.csv` | 7,535 | one corps performance at one show (wide: total + 8 captions) |
| `events.csv` | 896 | one scored show |
| `corps.csv` | 56 | one corps (with alias list + seasons active) |
| `subcaptions.csv` | 60,280 | one (performance, caption) with judged caption rank |
| `judges.csv` | 7,671 | one (show, caption, judge) assignment |

Join keys: `scores.event_slug = events.slug`, `scores.corps_key = corps.corps_key`,
`subcaptions`/`judges` join on `event_slug` (+ `corps_key` for subcaptions).

## Column dictionary

### scores.csv (primary table)
| Column | Type | Meaning |
|---|---|---|
| `season` | int | Competition year (YYYY) |
| `event_slug` | str | Event id; joins to `events.slug` |
| `event_name` | str | Human-readable show name |
| `date` | datetime | Show date, ISO 8601 (UTC) |
| `location` | str | Show city/state, if known |
| `division` | str | `World Class` or `Open Class` |
| `corps_key` | str | Stable corps id; joins to `corps.corps_key` |
| `corps_name` | str | Canonical corps name |
| `rank` | int | Placement within division at this show |
| `total` | float | Total recap score (0-100) |
| `GE1`,`GE2` | float | General Effect captions (0-20 each) |
| `VP`,`VA`,`CG` | float | Visual captions (0-20 each) |
| `MB`,`MA`,`MP` | float | Music captions (0-20 each) |
| `percent_through` | float | % of the season elapsed at show date (0-100) - a season-progress proxy |

Caption codes: **GE1** General Effect 1, **GE2** General Effect 2, **VP** Visual
Proficiency, **VA** Visual Analysis, **CG** Color Guard, **MB** Music Brass,
**MA** Music Analysis, **MP** Music Percussion.

### events.csv
`slug` (pk), `name`, `date` (ISO 8601), `location`, `season`, `percent_through`,
`n_performances` (count of cleaned corps at this show).

### corps.csv
`corps_key` (pk), `corps_name` (canonical), `division`, `seasons_active`
(semicolon-separated years), `n_performances`, `aliases` (semicolon-separated
alternate names).

### subcaptions.csv
`season`, `event_slug`, `corps_key`, `corps_name`, `caption_key`, `caption_name`,
`category` (`GE`/`Visual`/`Music`), `score` (0-20), `rank` (within-division caption
placement). This is the tidy/long form of the 8 caption columns in `scores.csv`.

### judges.csv
`season`, `event_slug`, `caption_key`, `judge_id`, `judge_number` (panel position).

## Privacy stance (judges)

`judge_id` is a **public slug** of the form `first-initial-surname-disambiguator`
(e.g. `k-miller-1`) derived from the judge names DCI already prints on every public
recap sheet. We publish **only** that slug and the caption they sat - **no** first/last
names as separate fields, no biographies, photos, contact details, or Elo/rating
metadata that exist in the upstream database. If you need human-readable names they are
on the public recaps; we intentionally do not re-key personal data here.

## Caveats & known limitations

- **2020 and 2021 are absent** - DCI's live tour was cancelled (2020) / drastically
  reduced (2021) due to COVID-19. There is simply no comparable competitive data.
- **2026 is a partial, in-progress season** as of this release (early-season shows
  only). Row counts for 2026 will grow.
- **Division coverage:** only World Class and Open Class (the two "model divisions").
  All-Age / SoundSport / international-only events are excluded.
- **56 corps** only - the reconciliation filter (full, balanced 8-caption sheet that
  sums to the total) keeps corps that consistently receive complete recap sheets.
  Fringe / one-off entries that never post full sheets are dropped by design.
- **`rank` is computed** within (show, division) from `total`, not scraped; ties break
  by `corps_key`.
- **No content/achievement sub-boxes.** DCI sheets historically split some captions
  into content vs achievement; the cleaned pipeline preserves the 8-caption grain only.
- **`percent_through`** is a season-elapsed proxy, not a physical show-order guarantee.

## Update cadence

Annual (after each DCI season concludes), with mid-season refreshes during the summer
tour while the current season fills in. Versioned on Kaggle; see the version notes.

## Provenance & the model

- **Source:** publicly posted DCI competition recaps.
- **Cleaning pipeline + prediction model (open source):**
  https://github.com/doeixd/dci-score-predictor
- **Model card (v10.5 identity-agnostic ensemble):**
  https://github.com/doeixd/dci-score-predictor/blob/master/docs/MODEL_CARD.md
- **Measured accuracy:**
  https://github.com/doeixd/dci-score-predictor/blob/master/docs/TIER_ACCURACY.md

The companion **starter notebook** (`dci-scores-eda`) shows how to load these files,
plot season overviews and score-progression curves, and run a naive last-total
baseline - then points at the SDK for real predictions.

## License

**CC-BY-SA-4.0.** The underlying scores are factual results DCI posts publicly;
the *curation and reconciliation* is the added value, so we license the compiled
dataset under Creative Commons Attribution-ShareAlike 4.0 - attribute the source and
keep derivatives of the cleaned data equally open. (Kaggle's dataset license list has
no MIT option; the companion **code** is MIT, licensed separately in the SDK repo.)

## Disclaimer

This is an **independent, unofficial** dataset. It is **not affiliated with, endorsed
by, or sponsored by Drum Corps International (DCI)** or any drum corps. All corps names
and marks belong to their respective owners. Provided as-is for research and
educational use.
