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
 * Default idea of "a win": match at least half your numbers, rounded up.
 *
 * This is a transparent placeholder, NOT Vietlott's prize table - the app
 * makes it editable precisely because the real thresholds decide the answer.
 */
export function defaultThreshold(k) {
  return Math.max(1, Math.ceil(k / 2));
}

export function defaultThresholds() {
  const t = {};
  for (let k = 1; k <= KENO.maxPick; k++) t[k] = defaultThreshold(k);
  return t;
}

/** P(matching at least `threshold` of k). */
export function winProbability(k, threshold) {
  const t = Math.max(0, Math.min(k, threshold));
  let p = 0;
  for (let m = t; m <= k; m++) p += hyperPmf(m, k);
  return Math.min(1, p);
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

/**
 * One ticket per pick level, each with its exact odds.
 * `thresholds` maps k -> the match count that counts as a win.
 */
export function generateAllLevels(rng, thresholds = defaultThresholds(), maxPick = KENO.maxPick) {
  const out = [];
  for (let k = 1; k <= maxPick; k++) {
    const threshold = thresholds[k] ?? defaultThreshold(k);
    const pWin = winProbability(k, threshold);
    out.push({
      k,
      threshold,
      numbers: generateTicket(k, rng),
      pWin,
      oneIn: pWin > 0 ? 1 / pWin : Infinity,
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
export function scoreAgainstHistory(numbers, draws, threshold) {
  const picks = new Set(numbers);
  const k = numbers.length;
  const counts = new Array(k + 1).fill(0);
  let wins = 0;
  for (const d of draws) {
    let m = 0;
    for (const n of d.result) if (picks.has(n)) m++;
    counts[m]++;
    if (m >= threshold) wins++;
  }
  const n = draws.length || 1;
  return {
    draws: draws.length,
    counts,
    wins,
    observedWinRate: wins / n,
    rows: counts.map((c, m) => ({
      m,
      observed: c,
      observedP: c / n,
      expectedP: hyperPmf(m, k),
      expected: hyperPmf(m, k) * n,
    })),
  };
}
