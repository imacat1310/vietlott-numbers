/**
 * Test harness for the pure-logic modules (no DOM needed).
 *
 *   node tests/run.mjs
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc -m tests/run.mjs
 *
 * Checks every ported strategy produces well-formed tickets, that the
 * no-look-ahead rule holds, that the seeded RNG is reproducible, and that the
 * backtest arithmetic adds up.
 */

import { PRODUCTS } from '../js/config.js';
import { parseJsonl, decorate, mergeRows, dayTs, DAY_MS } from '../js/store.js';
import { STRATEGIES, STRATEGY_BY_KEY, Context } from '../js/strategies.js';
import { makeRng, sample, weightedSample, weightedChoice } from '../js/rng.js';
import { frequency, absence, topPairs } from '../js/stats.js';
import { runBacktest, expectedRandomMatches } from '../js/backtest.js';

/* ---- tiny test runner ---- */
let passed = 0;
const failures = [];
const out = typeof print === 'function' ? print : console.log;

function check(name, fn) {
  try {
    fn();
    passed++;
    out(`  ok   ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    out(`  FAIL ${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'expected equal'}: ${a} !== ${b}`);
}

/* ---- load fixture data ---- */

/** Reads a bundled data file under either the jsc shell or Node. */
const readData = await (async () => {
  if (typeof readFile === 'function') {
    // jsc shell: paths resolve against the working directory.
    return (name) => readFile(`data/${name}`);
  }
  const [{ readFileSync }, { fileURLToPath }] = await Promise.all([
    import('node:fs'),
    import('node:url'),
  ]);
  // Resolve against this file so the working directory does not matter.
  const dir = fileURLToPath(new URL('../data/', import.meta.url));
  return (name) => readFileSync(dir + name, 'utf8');
})();

function loadProduct(key) {
  return parseJsonl(readData(PRODUCTS[key].file)).map((r) => decorate(r, key));
}

out('\nloading fixtures…');
const data = {
  power_655: loadProduct('power_655'),
  power_645: loadProduct('power_645'),
  power_535: loadProduct('power_535'),
};
for (const [k, v] of Object.entries(data)) out(`  ${k}: ${v.length} draws`);

/* ---- data layer ---- */
out('\ndata layer');

check('jsonl parses into draws', () => {
  assert(data.power_655.length > 1000, 'too few 6/55 draws');
  const d = data.power_655[0];
  eq(d.date, '2017-08-01', 'first draw date');
  eq(d.main.length, 6, 'main ball count');
  eq(d.bonus, 35, 'bonus ball');
  eq(d.result.length, 7, 'result length');
});

check('5/35 splits 5 main + 1 bonus', () => {
  const d = data.power_535[data.power_535.length - 1];
  eq(d.main.length, 5, 'main count');
  assert(d.bonus !== null, 'bonus missing');
});

check('6/45 has no bonus ball', () => {
  const d = data.power_645[data.power_645.length - 1];
  eq(d.main.length, 6, 'main count');
  eq(d.bonus, null, 'unexpected bonus');
});

check('draws are chronologically sorted', () => {
  for (const [k, rows] of Object.entries(data)) {
    for (let i = 1; i < rows.length; i++) {
      assert(rows[i - 1].date <= rows[i].date, `${k} out of order at ${i}`);
    }
  }
});

check('merge is idempotent and additive', () => {
  const base = data.power_655.slice(0, 100);
  const same = mergeRows(base, base);
  eq(same.added, 0, 're-merge added rows');
  eq(same.merged.length, 100, 'length changed');
  const grown = mergeRows(base, data.power_655.slice(0, 120));
  eq(grown.added, 20, 'new rows not added');
  eq(grown.merged.length, 120, 'merged length');
});

check('dayTs round-trips a date', () => {
  eq(new Date(dayTs('2026-09-22')).toISOString().slice(0, 10), '2026-09-22');
});

/* ---- rng ---- */
out('\nrng');

check('seeded rng is reproducible', () => {
  const a = Array.from({ length: 8 }, makeRng(42));
  const b = Array.from({ length: 8 }, makeRng(42));
  eq(JSON.stringify(a), JSON.stringify(b), 'same seed diverged');
  const c = Array.from({ length: 8 }, makeRng(43));
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different seeds matched');
});

check('sample returns k distinct items', () => {
  const rng = makeRng(1);
  for (let i = 0; i < 200; i++) {
    const s = sample(rng, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
    eq(s.length, 4, 'wrong size');
    eq(new Set(s).size, 4, 'duplicates');
  }
});

check('weightedSample respects weights and distinctness', () => {
  const rng = makeRng(7);
  const items = [1, 2, 3, 4, 5];
  let ones = 0;
  for (let i = 0; i < 2000; i++) {
    const s = weightedSample(rng, items, [100, 1, 1, 1, 1], 2);
    eq(new Set(s).size, 2, 'duplicates');
    if (s.includes(1)) ones++;
  }
  assert(ones > 1500, `heavy weight under-sampled: ${ones}/2000`);
});

check('weightedChoice survives all-zero weights', () => {
  const rng = makeRng(3);
  const v = weightedChoice(rng, [1, 2, 3], [0, 0, 0]);
  assert([1, 2, 3].includes(v), 'returned something odd');
});

/* ---- strategies ---- */
out('\nstrategies');

for (const [productKey, rows] of Object.entries(data)) {
  const p = PRODUCTS[productKey];
  for (const Strat of STRATEGIES) {
    check(`${p.label} / ${Strat.label} produces valid tickets`, () => {
      const ctx = new Context({ draws: rows, product: p, rng: makeRng(`${productKey}:${Strat.key}`) });
      const strategy = new Strat(ctx);
      const targetT = rows[rows.length - 1].t + 2 * DAY_MS;
      for (let i = 0; i < 25; i++) {
        const t = strategy.predict(targetT);
        eq(t.length, p.pick, 'ticket size');
        eq(new Set(t).size, p.pick, 'duplicate numbers');
        for (const n of t) {
          assert(Number.isInteger(n), `non-integer ${n}`);
          assert(n >= p.min && n <= p.max, `${n} outside ${p.min}-${p.max}`);
        }
        for (let j = 1; j < t.length; j++) assert(t[j - 1] < t[j], 'not sorted ascending');
      }
    });
  }
}

check('strategies never read the target draw or later (no look-ahead)', () => {
  const p = PRODUCTS.power_655;
  const rows = data.power_655;
  const cutIdx = rows.length - 40;
  const targetT = rows[cutIdx].t;
  const truncated = rows.slice(0, cutIdx);

  for (const Strat of STRATEGIES) {
    const full = new Strat(
      new Context({ draws: rows, product: p, rng: makeRng('look') })
    ).predict(targetT);
    const cut = new Strat(
      new Context({ draws: truncated, product: p, rng: makeRng('look') })
    ).predict(targetT);
    eq(
      JSON.stringify(full),
      JSON.stringify(cut),
      `${Strat.label} changed when future draws were removed`
    );
  }
});

check('same seed reproduces the same tickets', () => {
  const p = PRODUCTS.power_655;
  const targetT = data.power_655[data.power_655.length - 1].t + 2 * DAY_MS;
  for (const Strat of STRATEGIES) {
    const run = () => {
      const ctx = new Context({ draws: data.power_655, product: p, rng: makeRng(99) });
      return new Strat(ctx).predict(targetT);
    };
    eq(JSON.stringify(run()), JSON.stringify(run()), `${Strat.label} not reproducible`);
  }
});

check('frequency strategy actually leans hot vs cold', () => {
  const p = PRODUCTS.power_655;
  const rows = data.power_655;
  const targetT = rows[rows.length - 1].t + 2 * DAY_MS;
  const Freq = STRATEGY_BY_KEY.frequency;

  const counts = new Map(
    frequency(rows.slice(-200), p, false).map((f) => [f.number, f.count])
  );
  const avgOf = (type) => {
    const ctx = new Context({ draws: rows, product: p, rng: makeRng(`f-${type}`) });
    const s = new Freq(ctx, { lookbackDays: 3650, strategyType: type, selectionWeight: 1 });
    let total = 0;
    let n = 0;
    for (let i = 0; i < 300; i++) {
      for (const num of s.predict(targetT)) {
        total += counts.get(num) || 0;
        n++;
      }
    }
    return total / n;
  };
  const hot = avgOf('hot');
  const cold = avgOf('cold');
  assert(hot > cold, `hot (${hot.toFixed(2)}) should out-frequency cold (${cold.toFixed(2)})`);
});

check('long absence picks genuinely overdue numbers', () => {
  const p = PRODUCTS.power_655;
  const rows = data.power_655;
  const targetT = rows[rows.length - 1].t + 2 * DAY_MS;
  const absMap = new Map(absence(rows, p, false, targetT).map((a) => [a.number, a.drawsAgo]));
  const ranked = [...absMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n);

  const ctx = new Context({ draws: rows, product: p, rng: makeRng('abs') });
  const s = new STRATEGY_BY_KEY.long_absence(ctx, { topN: 10 });
  for (let i = 0; i < 50; i++) {
    for (const n of s.predict(targetT)) {
      assert(ranked.includes(n), `${n} is not in the 10 most overdue`);
    }
  }
});

check('not-repeat avoids the recent window', () => {
  const p = PRODUCTS.power_655;
  const rows = data.power_655;
  const targetT = rows[rows.length - 1].t + 2 * DAY_MS;
  const recent = new Set();
  for (const d of rows.filter((d) => d.t >= targetT - 30 * DAY_MS && d.t < targetT)) {
    for (const n of d.main) recent.add(n);
  }
  assert(recent.size > 0, 'fixture has no recent draws');
  const ctx = new Context({ draws: rows, product: p, rng: makeRng('nr') });
  const s = new STRATEGY_BY_KEY.not_repeat(ctx, { lookbackDays: 30, avoidWeight: 0.8 });
  for (let i = 0; i < 50; i++) {
    for (const n of s.predict(targetT)) assert(!recent.has(n), `${n} was drawn recently`);
  }
});

/* ---- stats ---- */
out('\nstatistics');

check('frequency counts every ball exactly once', () => {
  const rows = data.power_655.slice(-300);
  const p = PRODUCTS.power_655;
  const main = frequency(rows, p, false).reduce((a, f) => a + f.count, 0);
  eq(main, rows.length * p.pick, 'main-ball total');
  const withBonus = frequency(rows, p, true).reduce((a, f) => a + f.count, 0);
  eq(withBonus, rows.length * (p.pick + 1), 'with-bonus total');
});

check('frequency percentages sum to 100', () => {
  const total = frequency(data.power_645.slice(-200), PRODUCTS.power_645, false)
    .reduce((a, f) => a + f.pct, 0);
  assert(Math.abs(total - 100) < 1e-6, `pct total was ${total}`);
});

check('absence matches the known last-seen date', () => {
  const rows = data.power_655;
  const p = PRODUCTS.power_655;
  const asOf = rows[rows.length - 1].t;
  const abs = absence(rows, p, false, asOf);
  for (const a of abs) {
    if (a.drawsAgo === 0) {
      assert(rows[rows.length - 1].main.includes(a.number), `${a.number} claims 0 draws ago`);
    }
    if (a.lastDate) {
      const last = rows.find((d) => d.date === a.lastDate);
      assert(last.main.includes(a.number), `${a.number} not in its lastDate draw`);
    }
  }
});

check('top pairs are real co-occurrences', () => {
  const rows = data.power_655.slice(-400);
  const pairs = topPairs(rows, false, 5);
  assert(pairs.length === 5, 'wrong pair count');
  for (const { a, b, count } of pairs) {
    const actual = rows.filter((d) => d.main.includes(a) && d.main.includes(b)).length;
    eq(actual, count, `pair ${a}-${b} count`);
  }
});

/* ---- backtest ---- */
out('\nbacktest');

check('backtest accounting is consistent', () => {
  const p = PRODUCTS.power_655;
  const r = runBacktest({
    draws: data.power_655,
    product: p,
    strategyKey: 'random',
    ticketsPerDraw: 2,
    fromDate: data.power_655[data.power_655.length - 30].date,
    seed: 5,
  });
  eq(r.drawsEvaluated, 30, 'draws evaluated');
  eq(r.tickets, 60, 'ticket count');
  eq(r.cost, 60 * p.ticketPrice, 'cost');
  const distTotal = r.distribution.reduce((a, [, c]) => a + c, 0);
  eq(distTotal, 60, 'distribution total');
  const weighted = r.distribution.reduce((a, [m, c]) => a + m * c, 0) / 60;
  assert(Math.abs(weighted - r.avgMatches) < 1e-9, 'avgMatches disagrees with distribution');
  eq(r.profit, r.gain - r.cost, 'profit');
  for (const [m] of r.distribution) assert(m >= 0 && m <= p.pick, `impossible match count ${m}`);
});

check('backtest is reproducible under a fixed seed', () => {
  const opts = {
    draws: data.power_535,
    product: PRODUCTS.power_535,
    strategyKey: 'pair_frequency',
    ticketsPerDraw: 1,
    fromDate: data.power_535[data.power_535.length - 25].date,
    seed: 'abc',
  };
  eq(runBacktest(opts).avgMatches, runBacktest(opts).avgMatches, 'avgMatches drifted');
});

check('every strategy lands near the random baseline (no fake edge)', () => {
  const p = PRODUCTS.power_655;
  const baseline = expectedRandomMatches(p);
  const from = data.power_655[data.power_655.length - 150].date;
  const scores = [];
  for (const S of STRATEGIES) {
    const r = runBacktest({
      draws: data.power_655,
      product: p,
      strategyKey: S.key,
      ticketsPerDraw: 4,
      fromDate: from,
      seed: 2026,
    });
    scores.push([S.label, r.avgMatches, r.roi]);
    assert(
      Math.abs(r.avgMatches - baseline) < 0.5,
      `${S.label} avg ${r.avgMatches.toFixed(3)} is implausibly far from baseline ${baseline.toFixed(3)}`
    );
  }
  out(`       baseline ${baseline.toFixed(3)} matches/ticket`);
  for (const [label, avg, roi] of scores.sort((a, b) => b[1] - a[1])) {
    out(`       ${label.padEnd(26)} ${avg.toFixed(3)}  ROI ${roi.toFixed(1)}%`);
  }
});

check('bonus-ball toggle changes what gets matched', () => {
  const p = PRODUCTS.power_655;
  const base = {
    draws: data.power_655,
    product: p,
    strategyKey: 'frequency',
    ticketsPerDraw: 3,
    fromDate: data.power_655[data.power_655.length - 120].date,
    seed: 11,
  };
  const withoutBonus = runBacktest({ ...base, useBonus: false });
  const withBonus = runBacktest({ ...base, useBonus: true });
  assert(withBonus.avgMatches >= withoutBonus.avgMatches, 'extra ball should not lower matches');
});

/* ---- chart scale ---- */
out('\nchart axis');

check('axis top tick always covers the tallest bar', () => {
  // Mirrors niceTicks in js/chart.js; a top tick below the max would render
  // bars at negative y, spilling out of the plot area.
  const niceTicks = (max, count = 4) => {
    if (!(max > 0)) return [0, 1];
    const raw = max / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
    const ticks = [];
    for (let v = 0; v < max - 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
    ticks.push(Number((Math.ceil(max / step) * step).toFixed(6)));
    return ticks;
  };
  const cases = [1, 4, 6, 7, 23, 50, 99, 100, 118, 140, 152, 180, 207, 829, 1401, 0.5, 2.5];
  for (const max of cases) {
    const t = niceTicks(max);
    const top = t[t.length - 1];
    assert(top >= max, `top tick ${top} below max ${max}`);
    assert(t[0] === 0, `axis does not start at zero for ${max}`);
    for (let i = 1; i < t.length; i++) assert(t[i] > t[i - 1], `non-monotonic ticks for ${max}`);
    assert(new Set(t).size === t.length, `duplicate tick for ${max}`);
  }
});

/* ---- summary ---- */
out(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) out(`  - ${f}`);
  if (typeof process !== 'undefined') process.exit(1);
  throw new Error(`${failures.length} test(s) failed`);
}
