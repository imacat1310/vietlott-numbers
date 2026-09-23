/**
 * Seedable RNG + sampling helpers.
 *
 * Every strategy draws from an injected `rng` so a run can be reproduced from
 * a seed - the upstream Python uses the global `random` module, which makes
 * backtests non-reproducible.
 */

/** mulberry32 - small, fast, good enough for sampling. */
export function makeRng(seed) {
  if (seed === null || seed === undefined || seed === '') {
    return Math.random;
  }
  let a = typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function choice(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Uniform sample of k distinct items (partial Fisher-Yates). */
export function sample(rng, arr, k) {
  const pool = arr.slice();
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

/** One item, probability proportional to weights (weights >= 0). */
export function weightedChoice(rng, items, weights) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (total <= 0) return choice(rng, items);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    const w = weights[i] > 0 ? weights[i] : 0;
    r -= w;
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/** k distinct items, sampled without replacement, proportional to weights. */
export function weightedSample(rng, items, weights, k) {
  const pool = items.slice();
  const w = weights.slice();
  const out = [];
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    let total = 0;
    for (const x of w) total += x > 0 ? x : 0;
    let idx;
    if (total <= 0) {
      idx = Math.floor(rng() * pool.length);
    } else {
      let r = rng() * total;
      idx = pool.length - 1;
      for (let j = 0; j < pool.length; j++) {
        r -= w[j] > 0 ? w[j] : 0;
        if (r <= 0) {
          idx = j;
          break;
        }
      }
    }
    out.push(pool[idx]);
    pool.splice(idx, 1);
    w.splice(idx, 1);
  }
  return out;
}
