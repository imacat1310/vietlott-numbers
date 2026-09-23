# Vietlott Number Generator

A browser app that generates Vietlott numbers using the prediction strategies from
[vietvudanh/vietlott-data](https://github.com/vietvudanh/vietlott-data), and keeps
crawling vietlott.vn for new winning numbers.

**Live: https://imacat1310.github.io/vietlott-numbers/** — open it on an iPhone and
add it to your Home Screen, or run it locally for live crawling.

Plain HTML + ES modules. No build step, no npm install, no framework.

```
python3 server.py          # http://localhost:8099
```

`server.py` needs only the Python standard library. `node server.js` is an
equivalent drop-in if you'd rather use Node (>= 18).

You can also host this folder on any static server — GitHub Pages included — and
the app falls back to the GitHub data source described below. Live crawling is the
only feature that needs the local server. It installs to an iPhone Home Screen as a
standalone app; see [GUIDE.md](GUIDE.md).

See [GUIDE.md](GUIDE.md) for how to use it, including installing it on an iPhone.

## What it does

**Generate** — pick a strategy, tune its parameters, and get tickets for the next
draw. Each ticket is annotated with its sum, odd/even and low/high split, and how
many of its numbers are currently hot or overdue. A seed makes a run reproducible.

**Statistics** — number frequency, days (or draws) since each number last appeared,
the most common pairs, and the odd/low/sum shape of recent draws. Every chart can be
limited to a recent window and can include or exclude the bonus ball.

**Backtest** — replay a strategy over the last N draws, ticket by ticket, scoring
each against the real result and pricing the outcome with an editable prize table.
"Compare all strategies" runs all eight over the same draws with the same seed.

**Data & crawler** — crawl status, manual and automatic crawling, JSONL export, and
the stored draw history.

Products: Power 6/55, Power 6/45 (Mega), Power 5/35. Each tab deep-links by hash
(`#generate`, `#stats`, `#backtest`, `#data`).

## The strategies

All eight are ports of `src/machine_learning/strategies/` in the upstream repo. Each
one sees only draws strictly before the date it is predicting for, so backtests carry
no look-ahead bias.

| Strategy | Idea |
|---|---|
| Random | Uniform pick. The honest baseline. |
| Frequency (hot / cold) | Weights numbers by how often they fell in a lookback window, toward the frequent or the rare end. |
| Not repeat | Excludes every number drawn in the recent window. |
| Long absence | Picks from the N numbers that have gone longest without appearing. |
| Pattern (spacing + range) | Learns common gaps between sorted numbers and how draws spread across five value bands, then imitates that shape. |
| Pair co-occurrence | Counts which numbers fall together, then grows a ticket around what clusters with the numbers already picked. |
| Exponential decay | Frequency with no hard window: each past draw is weighted `exp(-ln2 · age / half-life)`. |
| Markov chain | Builds a transition table over consecutive draws and scores each number by how often it followed the latest draw. |

One deliberate difference from upstream: every strategy draws from an injected,
seedable RNG instead of Python's global `random`, so a generated set of tickets or a
whole backtest can be reproduced exactly from its seed.

### These are not predictions

Lottery draws are independent events. None of these strategies improves your odds —
any Power 6/55 ticket is 1 in 28,989,675 whichever way you choose it. The backtest
exists to show that: run "compare all strategies" over any long enough window and
every row lands within sampling noise of the random baseline, with an ROI near −50%
or worse, because Vietlott returns roughly half of stakes as prizes. The upstream
repo's own `strategy_comparison_report.txt` reaches the same conclusion.

Prize amounts are editable in the Backtest tab. The defaults for Power 6/55 come from
the repo's `base.py`; the repo ships no table for 6/45 or 5/35, so those defaults are
estimates and are labelled as such in the UI.

## Where the data comes from

Three sources, tried in order:

1. **Live crawl of vietlott.vn** (needs `server.py` running). The server POSTs to the
   same `ajaxpro` result endpoint the upstream Python crawler uses and hands the raw
   HTML fragment back to the page, which parses it with `DOMParser`. The proxy is
   necessary because vietlott.vn sends no CORS headers, so the browser cannot call it
   directly. Note that vietlott.vn blocks many non-Vietnam IPs
   ([upstream issue #13](https://github.com/vietvudanh/vietlott-data/issues/13)); if
   that happens here, the crawl falls through to the next source automatically.
2. **The upstream repo's JSONL** on `raw.githubusercontent.com`, which the maintainer
   re-crawls daily. CORS-enabled, so it works from any host with no proxy.
3. **The bundled snapshot** in `data/`, copied from the repo at clone time.

Results are merged by draw id — new rows are added, corrected rows replace the old
ones, and nothing is lost — then cached in `localStorage`, so the history survives
reloads and grows over time.

"Auto-crawl" re-runs the crawl on an interval while the tab is open. It only runs
while the page is open; for unattended collection, run the upstream repo's own
`vietlott-crawl` on a schedule.

## Deploying

The app is fully static, so any host works. This repo publishes to GitHub Pages
straight from the default branch — **Settings → Pages → Source: Deploy from a
branch → `main` / `/ (root)`**. Pushing to `main` redeploys it; `.nojekyll` keeps
Pages from running the files through Jekyll.

Paths are relative throughout, so it runs correctly from a project subpath such as
`https://<user>.github.io/<repo>/`. **Bump `VERSION` in `sw.js` whenever you
deploy** — the service worker serves cached assets first, so installed clients keep
the old code until the cache name changes.

### Optional: run the tests before each deploy

`ci/pages.yml.example` is a GitHub Actions workflow that runs the test suite and
then deploys, instead of publishing straight from the branch. Pushing a workflow
file needs the `workflow` OAuth scope:

```
gh auth refresh -s workflow
mkdir -p .github/workflows && cp ci/pages.yml.example .github/workflows/pages.yml
git add .github && git commit -m "Add Pages CI" && git push
```

Then switch **Settings → Pages → Source** to **GitHub Actions**.

## Layout

```
index.html              markup and controls
server.py               static server + vietlott.vn crawl proxy (stdlib only)
server.js               the same server for Node >= 18
manifest.webmanifest    PWA metadata
sw.js                   service worker (offline support)
css/styles.css          design tokens, light and dark, touch and safe-area rules
js/config.js            product definitions, endpoints, prize tables
js/store.js             JSONL parsing, merging, localStorage persistence
js/crawler.js           the three data sources + HTML result parsing
js/rng.js               seedable RNG and sampling helpers
js/strategies.js        the eight ported strategies
js/stats.js             frequency, absence, pairs
js/backtest.js          backtest harness and prize accounting
js/chart.js             SVG bar chart
js/app.js               tabs, rendering, crawl scheduling
data/*.jsonl            bundled snapshot (Power 6/55, 6/45, 5/35 and Keno)
tools/crawl_keno.py     Keno crawler (standalone, stdlib only)
ci/                     optional GitHub Actions workflow
icons/                  app and Home Screen icons
tests/run.mjs           test suite for the non-DOM modules
```

## Keno

`data/keno.jsonl` holds the Keno draw history — 85,707 draws from 2022-12-04 to
2026-09-23, one per line, in the upstream schema:

```json
{"date":"2026-09-23","id":"#0296762","result":[2,5,9,...],"big_small":"Chẵn (12)","odd_even":"Lớn (13)"}
```

Keno draws 20 numbers from 1–80 roughly every 10 minutes, about 119 times a day, so
the file is ~13 MB. Two quirks carried over from upstream for compatibility: the
`big_small` key actually holds the site's Chẵn/Lẻ (even/odd) figure and `odd_even`
holds Lớn/Nhỏ (big/small) — the names are swapped relative to their contents.

`tools/crawl_keno.py` crawls it. Standard library only, no arguments needed:

```
python3 tools/crawl_keno.py                    # top up with anything new
python3 tools/crawl_keno.py --pages 500        # crawl further back
python3 tools/crawl_keno.py --verify           # check the file, don't crawl
```

The endpoint returns 6 draws per page, newest first, so one day is about 16 pages.
It is slow and rate-limits bursts, so requests are paced (`--delay`, default 2s) and
retried with backoff. By default the crawl stops once it reaches draws already in
the file, which makes repeat runs cheap; `--full` keeps going. Progress is written
to the file every 20 pages, so an interrupted crawl keeps what it collected.

> Keno is **not** wired into the generator UI. The eight strategies and the whole
> backtest are built around picking `k` numbers from a pool, which does not map onto
> a game that draws 20 of 80 for you. The data is here for analysis; adding a Keno
> tab would mean new strategies and a different prize model.

## Tests

48 checks over the data layer, RNG, all eight strategies (on all three products),
statistics, and the backtest arithmetic — including that no strategy reads future
draws, that a seed reproduces its tickets exactly, and that no strategy shows an
implausible edge over the random baseline.

```
node tests/run.mjs
# or, with no Node on the machine:
/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs
```
