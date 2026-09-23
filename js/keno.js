/**
 * Keno maths and ticket generation.
 *
 * A draw takes 20 of the 80 numbers. If you play k numbers, the count you
 * match is Hypergeometric(N=80, K=20, n=k):
 *
 *     P(match m) = C(20, m) * C(60, k - m) / C(80, k)
 *
 * Every k-number combination has exactly this distribution, so which numbers
 * you pick cannot change your odds. The only choice that moves them is k.
 */

import { sample } from './rng.js';

export const KENO = {
  min: 1,
  max: 80,
  drawn: 20,
  maxPick: 10,
  file: 'keno-recent.jsonl',
};

/**
 * Exact binomial coefficient.
 * Safe here: the largest value we need is C(80, 10) = 1.65e12, well inside
 * the 2^53 range where doubles hold integers exactly.
 */
export function comb(n, k) {
  if (k < 0 || k > n || n < 0) return 0;
  const kk = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < kk; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/** P(exactly m of your k numbers are drawn). */
export function hyperPmf(m, k) {
  // Restricted to k <= 10, Keno's actual limit, which is also the range where
  // comb() stays exact: C(80, 10) = 1.65e12 fits in a double, C(80, 20) = 3.5e18
  // does not.
  if (m < 0 || m > k || k < 1 || k > KENO.maxPick) return 0;
  const denom = comb(KENO.max, k);
  if (!denom) return 0;
  return (comb(KENO.drawn, m) * comb(KENO.max - KENO.drawn, k - m)) / denom;
}

/** Full distribution for a pick level: [{ m, p, atLeast }], m = 0..k. */
export function distribution(k) {
  const rows = [];
  for (let m = 0; m <= k; m++) rows.push({ m, p: hyperPmf(m, k) });
  let tail = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    tail += rows[i].p;
    rows[i].atLeast = Math.min(1, tail);
  }
  return rows;
}

/**
 * EXAMPLE prize multipliers, as a multiple of the ticket price.
 *
 * These are NOT Vietlott's prize table. Vietlott does not publish the table in
 * the draw data, so the app ships a conventional Keno-shaped placeholder purely
 * so the screen has something to compute, badges it as an example everywhere it
 * shows a money figure, and keeps every cell editable. Replace them with the
 * official amounts before believing any return or house-edge number.
 *
 * Every level is scaled to return about 60% of stake, which is the sort of
 * figure a real lottery Keno runs at. An earlier draft used textbook casino
 * multipliers and returned 93% at one level - plausible enough on screen to
 * be mistaken for a fact about Vietlott, which is exactly what a placeholder
 * must not do.
 *
 * Note the 0-match entry at k = 10: real paytables often pay for matching
 * nothing, which is why payable results are read off the prize table rather
 * than a "match at least N" rule.
 */
export const EXAMPLE_MULTIPLIERS = {
  1: { 1: 2 },
  2: { 2: 10 },
  3: { 3: 30, 2: 1 },
  4: { 4: 85, 3: 4, 2: 1 },
  5: { 5: 520, 4: 15, 3: 1 },
  6: { 6: 1400, 5: 45, 4: 5, 3: 1 },
  7: { 7: 7100, 6: 90, 5: 15, 4: 2, 3: 1 },
  8: { 8: 24000, 7: 480, 6: 60, 5: 10, 4: 1 },
  9: { 9: 53000, 8: 2700, 7: 160, 6: 20, 5: 4, 4: 1 },
  10: { 10: 173000, 9: 8600, 8: 520, 7: 70, 6: 9, 5: 2, 0: 3 },
};

export const DEFAULT_TICKET_PRICE = 10000;

/** The example table as actual amounts for a given ticket price. */
export function examplePrizes(ticketPrice = DEFAULT_TICKET_PRICE) {
  const out = {};
  for (let k = 1; k <= KENO.maxPick; k++) {
    out[k] = {};
    for (let m = 0; m <= k; m++) {
      out[k][m] = (EXAMPLE_MULTIPLIERS[k]?.[m] ?? 0) * ticketPrice;
    }
  }
  return out;
}

/** The match counts that pay, read straight off the prize table. */
export function payableCounts(prizes, k) {
  const table = prizes?.[k] || {};
  const out = [];
  for (let m = 0; m <= k; m++) if ((Number(table[m]) || 0) > 0) out.push(m);
  return out;
}

/** P(landing on any match count that pays). */
export function winProbability(k, prizes) {
  let p = 0;
  for (const m of payableCounts(prizes, k)) p += hyperPmf(m, k);
  return Math.min(1, p);
}

/**
 * Expected value of one k-number ticket under a prize table.
 *
 * Returns the amounts as well as the ratios, because the interesting question
 * once prizes are in play is no longer "which level wins most often" but
 * "which level gives back the most", and the two rarely agree.
 */
export function evaluate(k, prizes, ticketPrice = DEFAULT_TICKET_PRICE) {
  const table = prizes?.[k] || {};
  const prizeAt = (m) => Number(table[m]) || 0;

  let ev = 0;
  let pWin = 0;
  for (let m = 0; m <= k; m++) {
    const pm = hyperPmf(m, k);
    ev += pm * prizeAt(m);
    if (prizeAt(m) > 0) pWin += pm;
  }

  let variance = 0;
  for (let m = 0; m <= k; m++) {
    variance += hyperPmf(m, k) * (prizeAt(m) - ev) ** 2;
  }

  const price = Number(ticketPrice) || 0;
  const ret = price > 0 ? ev / price : 0;
  const top = payableCounts(prizes, k).reduce((a, m) => Math.max(a, prizeAt(m)), 0);

  return {
    k,
    ev,
    profit: ev - price,
    ret,
    edge: 1 - ret,
    sd: Math.sqrt(variance),
    pWin: Math.min(1, pWin),
    payable: payableCounts(prizes, k),
    topPrize: top,
    hasPrizes: top > 0,
  };
}

/** Mean matches for a k-number ticket: k * 20/80. */
export function meanMatches(k) {
  return (k * KENO.drawn) / KENO.max;
}

/** A uniformly random k-number ticket, sorted. */
export function generateTicket(k, rng) {
  const pool = [];
  for (let n = KENO.min; n <= KENO.max; n++) pool.push(n);
  return sample(rng, pool, k).sort((a, b) => a - b);
}

/** One ticket per pick level, each with its exact odds and its value. */
export function generateAllLevels(rng, prizes, ticketPrice = DEFAULT_TICKET_PRICE, maxPick = KENO.maxPick) {
  const out = [];
  for (let k = 1; k <= maxPick; k++) {
    const ev = evaluate(k, prizes, ticketPrice);
    out.push({
      ...ev,
      numbers: generateTicket(k, rng),
      oneIn: ev.pWin > 0 ? 1 / ev.pWin : Infinity,
      pAll: hyperPmf(k, k),
      pNone: hyperPmf(0, k),
      mean: meanMatches(k),
      distribution: distribution(k),
    });
  }
  return out;
}

/**
 * Score a ticket against real draws.
 * Returns the observed match-count distribution alongside the exact one, so
 * the theory can be checked rather than taken on trust.
 */
export function scoreAgainstHistory(numbers, draws, prizes, ticketPrice = DEFAULT_TICKET_PRICE) {
  const picks = new Set(numbers);
  const k = numbers.length;
  const table = prizes?.[k] || {};
  const prizeAt = (m) => Number(table[m]) || 0;
  const pays = new Set(payableCounts(prizes, k));

  const counts = new Array(k + 1).fill(0);
  let wins = 0;
  let won = 0;
  for (const d of draws) {
    let m = 0;
    for (const n of d.result) if (picks.has(n)) m++;
    counts[m]++;
    if (pays.has(m)) {
      wins++;
      won += prizeAt(m);
    }
  }

  const n = draws.length || 1;
  const price = Number(ticketPrice) || 0;
  const spent = draws.length * price;
  return {
    draws: draws.length,
    counts,
    wins,
    won,
    spent,
    profit: won - spent,
    actualReturn: spent > 0 ? won / spent : 0,
    observedWinRate: wins / n,
    rows: counts.map((c, m) => ({
      m,
      observed: c,
      observedP: c / n,
      expectedP: hyperPmf(m, k),
      expected: hyperPmf(m, k) * n,
      prize: prizeAt(m),
      paid: pays.has(m) ? c * prizeAt(m) : 0,
    })),
  };
}
