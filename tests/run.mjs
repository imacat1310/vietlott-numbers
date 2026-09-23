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
import {
  comb, hyperPmf, distribution, winProbability, meanMatches,
  generateTicket, generateAllLevels, scoreAgainstHistory,
  evaluate, examplePrizes, payableCounts, DEFAULT_TICKET_PRICE,
} from '../js/keno.js';

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
const fmt = (n) => n.toLocaleString('en-US');

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

/* ---- keno ---- */
out('\nkeno maths');

check('hypergeometric pmf matches the reference values', () => {
  // Computed independently in tools/analyze_keno.py (Python, math.comb).
  const refNone = {
    1: 0.75, 2: 0.56013, 3: 0.4165, 4: 0.30832, 5: 0.22718,
    6: 0.1666, 7: 0.12157, 8: 0.08827, 9: 0.06375, 10: 0.04579,
  };
  const refAll = {
    1: 2.5e-1, 2: 6.013e-2, 3: 1.388e-2, 4: 3.063e-3, 5: 6.449e-4,
    6: 1.29e-4, 7: 2.44e-5, 8: 4.346e-6, 9: 7.243e-7, 10: 1.122e-7,
  };
  for (let k = 1; k <= 10; k++) {
    const none = hyperPmf(0, k);
    const all = hyperPmf(k, k);
    assert(Math.abs(none - refNone[k]) < 5e-5, `k=${k} P(0) ${none} vs ${refNone[k]}`);
    assert(Math.abs(all / refAll[k] - 1) < 2e-3, `k=${k} P(all) ${all} vs ${refAll[k]}`);
  }
});

check('every pick level is a proper distribution', () => {
  for (let k = 1; k <= 10; k++) {
    const rows = distribution(k);
    eq(rows.length, k + 1, `k=${k} row count`);
    const total = rows.reduce((a, r) => a + r.p, 0);
    assert(Math.abs(total - 1) < 1e-9, `k=${k} sums to ${total}`);
    for (const r of rows) assert(r.p >= 0 && r.p <= 1, `k=${k} m=${r.m} p=${r.p}`);
    assert(Math.abs(rows[0].atLeast - 1) < 1e-9, `k=${k} P(at least 0) = ${rows[0].atLeast}`);
    for (let i = 1; i < rows.length; i++) {
      assert(rows[i].atLeast <= rows[i - 1].atLeast + 1e-12, `k=${k} tail not monotonic`);
    }
    const mean = rows.reduce((a, r) => a + r.m * r.p, 0);
    assert(Math.abs(mean - meanMatches(k)) < 1e-9, `k=${k} mean ${mean} vs ${meanMatches(k)}`);
  }
});

check('comb is exact across the range keno actually uses', () => {
  // hyperPmf only ever needs C(80, k), C(60, k) and C(20, m) for k, m <= 10,
  // all of which are below 2^53 and therefore exact in a double.
  eq(comb(80, 10), 1646492110120, 'C(80,10)');
  eq(comb(60, 10), 75394027566, 'C(60,10)');
  eq(comb(20, 10), 184756, 'C(20,10)');
  eq(comb(5, 0), 1, 'C(5,0)');
  eq(comb(5, 6), 0, 'C(5,6)');
  for (let k = 0; k <= 10; k++) {
    for (const n of [20, 60, 80]) {
      const c = comb(n, k);
      assert(Number.isSafeInteger(c), `C(${n},${k}) = ${c} is not an exact integer`);
    }
  }
  // Outside that range the guard returns 0 rather than a silently wrong value.
  eq(hyperPmf(0, 20), 0, 'k=20 rejected');
  eq(hyperPmf(0, 0), 0, 'k=0 rejected');
});

check('payable results come straight off the prize table', () => {
  const prizes = { 4: { 4: 500, 3: 100, 2: 0, 1: 0, 0: 0 }, 5: { 0: 50, 5: 9000 } };
  eq(JSON.stringify(payableCounts(prizes, 4)), '[3,4]', 'k=4 payable');
  // A 0-match bonus is a real paytable feature that an "at least N" rule cannot express.
  eq(JSON.stringify(payableCounts(prizes, 5)), '[0,5]', 'k=5 payable incl. zero-match');
  eq(JSON.stringify(payableCounts({}, 3)), '[]', 'no table means nothing pays');

  let expected = hyperPmf(3, 4) + hyperPmf(4, 4);
  assert(Math.abs(winProbability(4, prizes) - expected) < 1e-12, 'k=4 win probability');
  expected = hyperPmf(0, 5) + hyperPmf(5, 5);
  assert(Math.abs(winProbability(5, prizes) - expected) < 1e-12, 'k=5 win probability');
  eq(winProbability(3, {}), 0, 'nothing payable means no win');
});

check('expected value is the probability-weighted payout', () => {
  const price = 10000;
  const prizes = examplePrizes(price);
  for (let k = 1; k <= 10; k++) {
    const ev = evaluate(k, prizes, price);
    let manual = 0;
    for (let m = 0; m <= k; m++) manual += hyperPmf(m, k) * (prizes[k][m] || 0);
    assert(Math.abs(ev.ev - manual) < 1e-6, `k=${k} EV ${ev.ev} vs ${manual}`);
    assert(Math.abs(ev.ret - manual / price) < 1e-12, `k=${k} return`);
    assert(Math.abs(ev.edge - (1 - ev.ret)) < 1e-12, `k=${k} edge`);
    assert(ev.sd > 0, `k=${k} sd should be positive`);
    assert(ev.pWin > 0 && ev.pWin <= 1, `k=${k} pWin ${ev.pWin}`);
    // Every example level keeps the house ahead, as any real paytable does.
    assert(ev.ret < 1, `k=${k} example table returns ${ev.ret}, should be under 1`);
  }
});

check('a paytable that pays back the stake exactly is break-even', () => {
  // Contrived check on the arithmetic: pay 1/P(m) * price on one outcome and
  // the return must come to exactly 100%.
  const k = 4;
  const price = 1000;
  const p3 = hyperPmf(3, k);
  const prizes = { [k]: { 3: price / p3 } };
  const ev = evaluate(k, prizes, price);
  assert(Math.abs(ev.ret - 1) < 1e-9, `return ${ev.ret} should be 1`);
  assert(Math.abs(ev.edge) < 1e-9, `edge ${ev.edge} should be 0`);
  assert(Math.abs(ev.profit) < 1e-6, `profit ${ev.profit} should be 0`);
});

check('an empty prize table yields no value and no win', () => {
  const ev = evaluate(6, {}, 10000);
  eq(ev.ev, 0, 'EV');
  eq(ev.pWin, 0, 'pWin');
  eq(ev.hasPrizes, false, 'hasPrizes');
  eq(ev.topPrize, 0, 'topPrize');
});

check('generated tickets are valid and selection-neutral', () => {
  const rng = makeRng('keno');
  for (let k = 1; k <= 10; k++) {
    for (let i = 0; i < 40; i++) {
      const t = generateTicket(k, rng);
      eq(t.length, k, `k=${k} size`);
      eq(new Set(t).size, k, `k=${k} duplicates`);
      for (const n of t) assert(n >= 1 && n <= 80, `k=${k} ${n} outside 1-80`);
      for (let j = 1; j < t.length; j++) assert(t[j - 1] < t[j], `k=${k} not sorted`);
    }
  }
});

check('all-levels generation reports the right odds and value per level', () => {
  const price = DEFAULT_TICKET_PRICE;
  const prizes = examplePrizes(price);
  const levels = generateAllLevels(makeRng(7), prizes, price);
  eq(levels.length, 10, 'level count');
  for (const lv of levels) {
    eq(lv.numbers.length, lv.k, `k=${lv.k} ticket size`);
    assert(Math.abs(lv.pWin - winProbability(lv.k, prizes)) < 1e-12, `k=${lv.k} pWin`);
    assert(Math.abs(lv.pAll - hyperPmf(lv.k, lv.k)) < 1e-15, `k=${lv.k} pAll`);
    assert(Math.abs(lv.oneIn - 1 / lv.pWin) < 1e-6, `k=${lv.k} oneIn`);
    const ev = evaluate(lv.k, prizes, price);
    assert(Math.abs(lv.ev - ev.ev) < 1e-9, `k=${lv.k} EV`);
    assert(Math.abs(lv.ret - ev.ret) < 1e-12, `k=${lv.k} return`);
  }
  // The point of the tab: winning most often and returning most are different levels.
  const mostOften = levels.reduce((a, b) => (b.pWin > a.pWin ? b : a));
  const bestValue = levels.reduce((a, b) => (b.ret > a.ret ? b : a));
  out(`       example table: most wins k=${mostOften.k} (${(mostOften.pWin * 100).toFixed(2)}%), ` +
      `best return k=${bestValue.k} (${(bestValue.ret * 100).toFixed(1)}%)`);
});

check('theory matches the real Keno history', () => {
  // The strongest available check: score fixed tickets against tens of
  // thousands of actual draws and compare to the exact distribution.
  const draws = parseJsonl(readData('keno.jsonl'))
    .filter((r) => r.result.length === 20);
  assert(draws.length > 50000, `only ${draws.length} keno draws`);

  const rng = makeRng('history');
  const prizes = examplePrizes(DEFAULT_TICKET_PRICE);
  for (const k of [2, 5, 10]) {
    // Average the observed rate over several independent tickets.
    let totalObs = 0;
    let totalExp = 0;
    const tickets = 5;
    for (let i = 0; i < tickets; i++) {
      const ticket = generateTicket(k, rng);
      const s = scoreAgainstHistory(ticket, draws, prizes, DEFAULT_TICKET_PRICE);
      totalObs += s.observedWinRate;
      totalExp += winProbability(k, prizes);
    }
    const obs = totalObs / tickets;
    const exp = totalExp / tickets;
    // Standard error of the mean over tickets * draws.
    const se = Math.sqrt((exp * (1 - exp)) / (draws.length * tickets));
    const z = (obs - exp) / se;
    out(`       k=${k}: observed win rate ${(obs * 100).toFixed(3)}% vs exact ${(exp * 100).toFixed(3)}%  (z = ${z.toFixed(2)})`);
    assert(Math.abs(z) < 4, `k=${k} observed ${obs} vs expected ${exp} (z = ${z.toFixed(2)})`);
  }
});

check('money over real draws tracks the expected return', () => {
  const draws = parseJsonl(readData('keno.jsonl')).filter((r) => r.result.length === 20);
  const price = DEFAULT_TICKET_PRICE;
  const prizes = examplePrizes(price);
  const rng = makeRng('money');
  for (const k of [4, 8]) {
    const ticket = generateTicket(k, rng);
    const s = scoreAgainstHistory(ticket, draws, prizes, price);
    eq(s.spent, draws.length * price, `k=${k} spend`);
    eq(s.profit, s.won - s.spent, `k=${k} profit`);
    // The paid-out column must add up to the total won.
    const summed = s.rows.reduce((a, r) => a + r.paid, 0);
    assert(Math.abs(summed - s.won) < 1e-6, `k=${k} payout rows ${summed} vs ${s.won}`);
    const expectedReturn = evaluate(k, prizes, price).ret;
    out(`       k=${k}: returned ${(s.actualReturn * 100).toFixed(1)}% over ` +
        `${fmt(draws.length)} draws, expected ${(expectedReturn * 100).toFixed(1)}%`);
  }
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
