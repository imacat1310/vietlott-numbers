# How to use the Vietlott Number Generator

This app picks lottery numbers for you using eight different strategies, shows you
what the past draws actually look like, and lets you test any strategy against real
history before you trust it.

**Read this first:** none of these strategies improves your odds. A Power 6/55 ticket
is 1 in 28,989,675 however you choose it. The app is built to *show* you that — see
[Reading the results honestly](#reading-the-results-honestly) at the end.

---

## Contents

- [Getting started](#getting-started)
- [Put it on your iPhone](#put-it-on-your-iphone)
- [Generate — picking numbers](#generate--picking-numbers)
- [Statistics — what the history looks like](#statistics--what-the-history-looks-like)
- [Backtest — does a strategy actually work?](#backtest--does-a-strategy-actually-work)
- [Keno — how many numbers to play](#keno--how-many-numbers-to-play)
- [Data & crawler — keeping results up to date](#data--crawler--keeping-results-up-to-date)
- [The eight strategies](#the-eight-strategies)
- [Reading the results honestly](#reading-the-results-honestly)
- [Troubleshooting](#troubleshooting)

---

## Getting started

There are three ways to run it. They differ only in where fresh draw results come
from.

| How you run it | Live crawl of vietlott.vn | Best for |
|---|---|---|
| Open [https://imacat1310.github.io/vietlott-numbers/](https://imacat1310.github.io/vietlott-numbers/) | No — syncs from GitHub instead | Phone, tablet, anywhere |
| `python3 server.py` on your computer | **Yes** | Getting results the moment they are published |
| Any other static web server | No — syncs from GitHub instead | Sharing on a network |

To run it on your own computer:

```
python3 server.py
```

Then open **http://localhost:8099**. Nothing to install — it uses only what ships
with Python. If you would rather use Node (version 18 or newer), `node server.js`
does the same thing.

Whichever way you run it, the app opens with about nine years of real draw history
already loaded, so everything works straight away.

---

## Put it on your iPhone

The app installs to your Home Screen and runs full screen, with no browser bars.

1. Open **[https://imacat1310.github.io/vietlott-numbers/](https://imacat1310.github.io/vietlott-numbers/)** in **Safari**.
   It must be Safari — Chrome on iOS cannot install web apps.
2. Tap the **Share** button (the square with an arrow, at the bottom of the screen).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**.

You now have a Vietlott icon alongside your other apps. It remembers your draw
history, so after the first launch it opens instantly and keeps working without a
signal — handy in a lift or on the underground. It refreshes whenever you next have
a connection.

**Two things work differently on a phone:**

- **No live crawling.** A phone cannot run the little relay server that talks to
  vietlott.vn, so the app syncs from the project's data repository instead. That is
  re-crawled daily, so results normally appear within a day of the draw. The Data tab
  tells you which source is in use.
- **Auto-crawl only runs while the app is open.** iOS suspends apps in the
  background. Results refresh when you open it, which is all you need.

If you want the same history on both your phone and your computer, use the **Export
JSONL** button — see [Data & crawler](#data--crawler--keeping-results-up-to-date).

---

## Generate — picking numbers

This is the tab you will use most.

1. Choose the game at the top right: **Power 6/55**, **Power 6/45** or **Power 5/35**.
2. Pick a **Method** — see [The eight strategies](#the-eight-strategies). The
   description under the dropdown tells you what each one does.
3. Adjust the settings that appear. Every strategy has its own; all of them have
   sensible defaults, so you can ignore this at first.
4. Set **Tickets to generate** — how many separate lines you want.
5. Press **Generate numbers**.

Each ticket appears as a row of balls with a few labels beside it:

| Label | Meaning |
|---|---|
| `sum 142` | The six numbers added together. Most real draws land near the middle of the range. |
| `3 odd / 3 even` | How the ticket splits between odd and even numbers. |
| `4 low / 2 high` | How it splits between the bottom and top half of the range. |
| `2 hot` | How many of its numbers are among the most frequently drawn third. |
| `3 overdue` | How many have not appeared in at least 20 draws. |

**Copy** puts all the tickets on your clipboard, one line per ticket, ready to paste
into a message or note.

### Seeds

Leave **Seed** blank and you get different numbers every time you press the button.

Type anything into it — `2026`, your name, a date — and the same seed with the same
settings always produces the same tickets. That is useful when you want to write a
set of numbers down and be able to reproduce them later, or when you are comparing
two strategies and want a fair test.

### Count the bonus ball

Power 6/55 and Power 5/35 draw an extra bonus ball. Leave this off (the default) and
the statistics behind every strategy look at the main numbers only, which is what you
are actually buying a ticket for. Turn it on to include the bonus ball in the counts.

---

## Statistics — what the history looks like

Five summary tiles across the top: how many draws are stored, the latest one, and
the odd/low/sum shape of recent draws — each shown next to what you would *expect*
from a fair draw, so you can see how close reality sits.

The chart below switches between three views:

- **Times drawn** — how often each number has come up. Bars below the average are
  drawn in a lighter shade.
- **Days since last drawn** — how long each number has been missing, in days.
- **Draws since last drawn** — the same thing, counted in draws rather than days.
  Usually the more useful of the two.

Hover or tap any bar for the exact figure.

Two controls sit under the chart:

- **Limit to the last N draws** — narrow the statistics to a recent window instead of
  all history. Useful for spotting a recent run, though bear in mind a small window is
  mostly noise.
- **Include bonus ball** — as described above.

At the bottom: the last 15 results in full, and the pairs of numbers that most often
turn up together.

> A fair lottery produces a roughly flat frequency chart. If yours looks flat, that is
> the machine working correctly, not a missing pattern.

---

## Backtest — does a strategy actually work?

This replays a strategy against draws that have already happened. For every draw in
the window, it generates tickets using *only* the draws that came before, scores them
against what actually came out, and adds up what you would have won and spent.

1. Choose a **Strategy**, or leave it on **Compare all strategies**.
2. Set **Evaluate the last N draws** — how far back to test. Larger is more reliable;
   52 draws is about six months of Power 6/55.
3. Set **Tickets per draw** — how many lines you would have bought each time.
4. Leave the **Seed** fixed so you can re-run and get the same answer.
5. Open **Prize table** if you want to change the payouts (see the warning below).
6. Press **Run backtest**.

### What you get

For a single strategy: average numbers matched per ticket, how many tickets won
anything, jackpots, total spent, net result and ROI, plus a chart of how often each
match count came up.

For **Compare all strategies**: one row per strategy, ranked by average matches, each
shown against the random baseline.

### Reading it

The number that matters is **average matches versus the random baseline**. The
baseline is what pure chance produces — 0.655 numbers per ticket for Power 6/55.

A strategy scoring above that has not found anything. Run it again with a different
seed and a different strategy will be on top. That reshuffling *is* the result: the
differences are noise, and the app says so under every backtest.

> **About the prize table.** The Power 6/55 amounts come from the source project. The
> project publishes no table for 6/45 or 5/35, so those figures are estimates and are
> labelled as such. Edit them to match the current official prizes before you read any
> money figure for those two games as real.

---

## Keno — how many numbers to play

Keno is a different game, so it gets its own tab and none of the eight strategies.

A Keno draw takes 20 of the 80 numbers. You choose how many numbers to play, from 1
to 10, and you win according to how many of yours come up. The important thing:
**for any given number of picks, every combination has exactly the same odds.** Ten
numbers off a birthday and ten numbers picked at random are indistinguishable. The
one decision that genuinely changes your chances is *how many* numbers you play.

So that is what the tab is built around.

1. Set **Numbers played** — the *k* you are considering, 1 to 10.
2. Set **A win means matching at least** — the point where you start getting paid.
3. Press **Generate**.

You get a ticket for *every* level from 1 to 10 at once, each with its exact odds,
and the level with the best chance of a win is called out underneath. Change the
thresholds and the best level changes with them.

Below that, for the level you selected: the chance of every possible result, from
matching none to matching all of them, as a chart and a table — including the "at
least this many" column, which is usually the number you actually care about.

### Set the thresholds to the real ones

The app starts with a placeholder: a win means matching at least half your numbers,
rounded up. **That is not Vietlott's prize table** — the prize rules are not in the
draw data, so the app cannot know them. Until you set the real thresholds for each
level, the comparison between levels is answering a made-up question. Once you do,
it answers the real one exactly.

### Checked against real draws

The bottom panel scores your ticket against the last 5,000 real Keno draws and shows
how often it would actually have won, next to what the maths predicted. These two
columns track each other closely. That is the honest demonstration: the odds shown
are not a model of Keno that might be wrong, they are simply what the game is.

## Data & crawler — keeping results up to date

Four tiles show how many draws are stored, the most recent one, when the app last
checked for new results, and which source it used.

### Where results come from

The app tries three sources in order and tells you which one it used:

1. **vietlott.vn, live** — only when you are running `server.py` on your computer.
   This is the official results page, read directly.
2. **The project data repository on GitHub** — re-crawled daily by its maintainer.
   This is what your phone uses. CORS-friendly, so it works from anywhere.
3. **The bundled snapshot** — the history shipped with the app, used on first run and
   whenever you are offline.

New results are merged in by draw number, so nothing is ever lost or duplicated, and
corrections replace the old figures. Your history is stored on the device and grows
over time.

### The buttons

| Button | What it does |
|---|---|
| **Crawl now** | Fetches the most recent pages of results once. |
| **Deep backfill** | Walks back up to 40 pages — use it to rebuild a long history after clearing the cache. |
| **Sync from GitHub** | Skips the live site and pulls the daily snapshot. Good if the live site is unreachable. |
| **Export JSONL** | Downloads your full stored history as a file, one draw per line. |
| **Clear local cache** | Wipes the stored history for all games and reloads the bundled snapshot. |

**Auto-crawl** re-checks on a timer while the app is open — 30 minutes by default. It
stops when you close the tab. For unattended collection, run the source project's own
crawler on a schedule instead.

The **Activity** panel logs every fetch, so you can see what happened and when.

---

## The eight strategies

All eight come from the [vietvudanh/vietlott-data](https://github.com/vietvudanh/vietlott-data)
project. Each one only ever looks at draws from *before* the date it is predicting
for, so a backtest cannot cheat by peeking at the answer.

### Random
A plain uniform pick — the honest baseline. Nothing to configure. Every other
strategy should be judged against this one.

### Frequency (hot / cold)
Counts how often each number came up in a lookback window, then leans toward the
frequent end (**hot**) or the rare end (**cold**).

| Setting | What it does |
|---|---|
| Lookback (days) | How much history to count. Longer is steadier, shorter reacts to recent runs. |
| Bias | Hot, cold, or balanced (no lean). |
| Share chosen by frequency | How much of the ticket follows the counts; the rest is random. |

### Not repeat
Excludes every number drawn in the recent window, on the idea that numbers rarely
repeat. Set the **avoid window** in days; **avoid strength** decides how strictly the
rule holds when too few numbers are left.

### Long absence
Picks from the numbers that have gone longest without appearing. **Candidate pool
size** sets how many of the most overdue numbers to choose among — smaller means a
more aggressive bet on the same few numbers.

### Pattern (spacing + range)
Looks at the typical gaps between the sorted numbers of a draw, and how draws spread
across five bands of the number range, then builds a ticket with a similar shape. Set
the **lookback** and how much of the ticket follows the pattern.

### Pair co-occurrence
Counts which numbers tend to appear together in the same draw, then builds a ticket
outward from the numbers that cluster with what it has already picked. One setting:
the **lookback** window.

### Exponential decay
Frequency with no hard cut-off: every past draw counts, weighted by age, halving every
**half-life**. Choose **hot** (favour what has been coming up lately) or **cold**
(favour what has not). A shorter half-life means a stronger recent bias.

### Markov chain
Builds a table of which numbers have historically followed which, then scores
candidates by how often they came after the numbers in the most recent draw.
**Smoothing** keeps every number in play no matter what the table says.

---

## Reading the results honestly

Lottery draws are independent events. The balls have no memory: a number that has not
appeared for 60 draws is exactly as likely to come up as one drawn last week, and a
"hot" number is not due to continue. Nothing in this app changes that.

What the strategies actually do is change the *shape* of your ticket — more spread
out, more clustered, more weighted to one end of the range. That affects how likely
you are to *share* a jackpot with other players who picked similarly, not how likely
you are to win one.

The backtest is the honest part of the app. Run **Compare all strategies** over a
decent window and you will see every strategy sitting within noise of random, with an
ROI somewhere around −90%. That is not a bug in the strategies. Vietlott returns
roughly half of stakes as prizes, so sustained play loses money by design, and the
source project's own comparison report reaches exactly the same conclusion.

Use it to pick numbers you enjoy, and spend accordingly.

---

## Troubleshooting

**"No local proxy" in the Data tab.**
Expected on a phone, or on any web address that is not your own computer. The app is
syncing from GitHub instead and everything else works, and the single `api/health`
404 in the browser console is just the app checking whether a relay is there. For
live crawling, run `python3 server.py` and open http://localhost:8099.

**Live crawl fails and it falls back to GitHub.**
vietlott.vn blocks a lot of non-Vietnam network addresses, and it sometimes drops
connections when asked for several pages quickly. The app retries, then falls back
automatically — you still get the data. Check the Activity log for the reason.

**The latest draw is missing.**
Results are published after the draw, and the GitHub source is re-crawled once a day,
so give it up to a day. Press **Crawl now** to check immediately.

**Numbers came out different with the same seed.**
The seed only fixes the randomness. Change the game, the strategy, any of its
settings, or the amount of history stored, and the result changes too.

**The Keno tab says a different level is best than I expected.**
It is answering the question using whatever thresholds are set, and the default is a
placeholder, not Vietlott's prize table. Set the real thresholds first.

**The backtest takes a while.**
"Compare all strategies" over a long window runs eight strategies across hundreds of
draws. A few seconds is normal; reduce the number of draws or tickets per draw to
speed it up.

**I cleared the cache and lost my history.**
Press **Deep backfill** (on your computer) or **Sync from GitHub** (anywhere) to
rebuild it. Nothing is lost permanently — it all comes back from the source.

**Home Screen app won't update after a new version is published.**
Close it fully — swipe up from the app switcher — and reopen. If it is still stale,
open the address in Safari once and it will refresh.
