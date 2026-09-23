/** Descriptive statistics over the draw history, for the Statistics tab. */

import { DAY_MS } from './store.js';

export function numbersOf(draw, useBonus) {
  return useBonus ? draw.result : draw.main;
}

/** Per-number counts over `draws`, plus share of all balls drawn. */
export function frequency(draws, product, useBonus) {
  const counts = new Map();
  for (let n = product.min; n <= product.max; n++) counts.set(n, 0);
  let total = 0;
  for (const d of draws) {
    for (const n of numbersOf(d, useBonus)) {
      if (counts.has(n)) {
        counts.set(n, counts.get(n) + 1);
        total++;
      }
    }
  }
  return [...counts.entries()].map(([number, count]) => ({
    number,
    count,
    pct: total ? (count / total) * 100 : 0,
  }));
}

/** Days and draws since each number last appeared, measured from `asOfTs`. */
export function absence(draws, product, useBonus, asOfTs) {
  const lastTs = new Map();
  const lastIdx = new Map();
  draws.forEach((d, i) => {
    for (const n of numbersOf(d, useBonus)) {
      lastTs.set(n, d.t);
      lastIdx.set(n, i);
    }
  });
  const total = draws.length;
  const out = [];
  for (let n = product.min; n <= product.max; n++) {
    const seen = lastTs.has(n);
    out.push({
      number: n,
      days: seen ? Math.round((asOfTs - lastTs.get(n)) / DAY_MS) : null,
      drawsAgo: seen ? total - 1 - lastIdx.get(n) : null,
      lastDate: seen ? draws[lastIdx.get(n)].date : null,
    });
  }
  return out;
}

/** The most frequent co-occurring pairs. */
export function topPairs(draws, useBonus, limit = 12) {
  const counts = new Map();
  for (const d of draws) {
    const nums = numbersOf(d, useBonus).slice().sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        const k = `${nums[i]}-${nums[j]}`;
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([pair, count]) => {
      const [a, b] = pair.split('-').map(Number);
      return { a, b, count };
    });
}

/** Odd/even and low/high split of the most recent `n` draws. */
export function shapeSummary(draws, product, useBonus, n = 50) {
  const recent = draws.slice(-n);
  if (!recent.length) return null;
  const mid = (product.min + product.max) / 2;
  let odd = 0;
  let low = 0;
  let balls = 0;
  let sumTotal = 0;
  for (const d of recent) {
    const nums = numbersOf(d, useBonus);
    let drawSum = 0;
    for (const x of nums) {
      if (x % 2 === 1) odd++;
      if (x <= mid) low++;
      drawSum += x;
      balls++;
    }
    sumTotal += drawSum;
  }
  return {
    draws: recent.length,
    oddPct: (odd / balls) * 100,
    lowPct: (low / balls) * 100,
    avgSum: sumTotal / recent.length,
  };
}
