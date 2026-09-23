/**
 * JavaScript ports of the prediction strategies in
 * vietvudanh/vietlott-data -> src/machine_learning/strategies/.
 *
 * Each strategy sees only draws strictly before the target date, the same
 * no-look-ahead rule the Python base class enforces.
 */

import { DAY_MS } from './store.js';
import { choice, randInt, sample, weightedChoice, weightedSample } from './rng.js';

/** Shared view over the draw history. */
export class Context {
  constructor({ draws, product, useBonus = false, rng = Math.random }) {
    this.product = product;
    this.min = product.min;
    this.max = product.max;
    this.pick = product.pick;
    this.useBonus = useBonus;
    this.rng = rng;
    this.draws = draws.slice().sort((a, b) => a.t - b.t);
    this.ts = this.draws.map((d) => d.t);
    this.allNumbers = [];
    for (let n = this.min; n <= this.max; n++) this.allNumbers.push(n);
  }

  numbersOf(draw) {
    return this.useBonus ? draw.result : draw.main;
  }

  /** Index of the first draw with t >= target (so [0, i) is "strictly before"). */
  indexBefore(targetT) {
    let lo = 0;
    let hi = this.ts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[mid] < targetT) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Draws in [targetT - lookbackDays, targetT). */
  window(targetT, lookbackDays) {
    const end = this.indexBefore(targetT);
    const start = targetT - lookbackDays * DAY_MS;
    let i = end;
    while (i > 0 && this.ts[i - 1] >= start) i--;
    return this.draws.slice(i, end);
  }

  before(targetT) {
    return this.draws.slice(0, this.indexBefore(targetT));
  }
}

class Strategy {
  constructor(ctx, params = {}) {
    this.ctx = ctx;
    this.params = { ...this.constructor.defaults(), ...params };
    this.cache = new Map();
  }

  static defaults() {
    const d = {};
    for (const p of this.paramSpec || []) d[p.key] = p.default;
    return d;
  }

  get rng() {
    return this.ctx.rng;
  }

  predict() {
    throw new Error('not implemented');
  }

  /** Fill a partial ticket with uniform random numbers. */
  fillRandom(predicted, count) {
    if (count <= 0) return predicted;
    const taken = new Set(predicted);
    const available = this.ctx.allNumbers.filter((n) => !taken.has(n));
    predicted.push(...sample(this.rng, available, Math.min(count, available.length)));
    return predicted;
  }
}

/* ------------------------------------------------------------------ *
 * 1. Random - random_strategy.py
 * ------------------------------------------------------------------ */
export class RandomStrategy extends Strategy {
  static key = 'random';
  static label = 'Random';
  static blurb =
    'Uniform random pick. The honest baseline: in a fair draw no strategy beats it.';
  static paramSpec = [];

  predict() {
    return sample(this.rng, this.ctx.allNumbers, this.ctx.pick).sort((a, b) => a - b);
  }
}

/* ------------------------------------------------------------------ *
 * 2. Frequency (hot / cold / balanced) - frequency.py
 * ------------------------------------------------------------------ */
export class FrequencyStrategy extends Strategy {
  static key = 'frequency';
  static label = 'Frequency (hot / cold)';
  static blurb =
    'Counts how often each number fell inside a lookback window, then samples weighted toward the frequent ("hot") or the rare ("cold") end.';
  static paramSpec = [
    { key: 'lookbackDays', label: 'Lookback (days)', type: 'number', default: 365, min: 7, max: 4000, step: 1 },
    {
      key: 'strategyType',
      label: 'Bias',
      type: 'select',
      default: 'hot',
      options: [
        { value: 'hot', label: 'Hot - favour frequent' },
        { value: 'cold', label: 'Cold - favour rare' },
        { value: 'balanced', label: 'Balanced - uniform' },
      ],
    },
    { key: 'selectionWeight', label: 'Share chosen by frequency', type: 'range', default: 0.8, min: 0, max: 1, step: 0.1 },
  ];

  frequencies(targetT) {
    if (this.cache.has(targetT)) return this.cache.get(targetT);
    const counts = new Map(this.ctx.allNumbers.map((n) => [n, 0]));
    for (const d of this.ctx.window(targetT, this.params.lookbackDays)) {
      for (const n of this.ctx.numbersOf(d)) {
        if (counts.has(n)) counts.set(n, counts.get(n) + 1);
      }
    }
    this.cache.set(targetT, counts);
    return counts;
  }

  predict(targetT) {
    const { strategyType, selectionWeight } = this.params;
    const counts = this.frequencies(targetT);
    const nums = this.ctx.allNumbers;
    let maxFreq = 1;
    for (const v of counts.values()) maxFreq = Math.max(maxFreq, v);

    const weights = nums.map((n) => {
      const f = counts.get(n) || 0;
      if (strategyType === 'hot') return Math.max(1, f);
      if (strategyType === 'cold') return Math.max(1, maxFreq - f + 1);
      return 1;
    });

    const freqCount = Math.trunc(this.ctx.pick * selectionWeight);
    const predicted = freqCount > 0 ? weightedSample(this.rng, nums, weights, freqCount) : [];
    this.fillRandom(predicted, this.ctx.pick - freqCount);
    return predicted.sort((a, b) => a - b);
  }
}

/* ------------------------------------------------------------------ *
 * 3. Not-repeat - not_repeat.py
 * ------------------------------------------------------------------ */
export class NotRepeatStrategy extends Strategy {
  static key = 'not_repeat';
  static label = 'Not repeat';
  static blurb =
    'Avoids every number drawn in the recent window, on the assumption that numbers rarely repeat draw to draw.';
  static paramSpec = [
    { key: 'lookbackDays', label: 'Avoid window (days)', type: 'number', default: 30, min: 1, max: 365, step: 1 },
    { key: 'avoidWeight', label: 'Avoid strength', type: 'range', default: 0.8, min: 0, max: 1, step: 0.1 },
  ];

  recent(targetT) {
    if (this.cache.has(targetT)) return this.cache.get(targetT);
    const set = new Set();
    for (const d of this.ctx.window(targetT, this.params.lookbackDays)) {
      for (const n of this.ctx.numbersOf(d)) set.add(n);
    }
    this.cache.set(targetT, set);
    return set;
  }

  predict(targetT) {
    const recent = this.recent(targetT);
    const nonRecent = this.ctx.allNumbers.filter((n) => !recent.has(n));
    const pick = this.ctx.pick;

    if (nonRecent.length >= pick) {
      return sample(this.rng, nonRecent, pick).sort((a, b) => a - b);
    }

    const predicted = nonRecent.slice();
    const recentPool = [...recent];
    let needed = pick - predicted.length;
    while (needed > 0) {
      if (this.rng() > this.params.avoidWeight && recentPool.length) {
        const chosen = choice(this.rng, recentPool);
        recentPool.splice(recentPool.indexOf(chosen), 1);
        if (!predicted.includes(chosen)) predicted.push(chosen);
      } else {
        const taken = new Set(predicted);
        const available = this.ctx.allNumbers.filter((n) => !taken.has(n));
        if (!available.length) break;
        predicted.push(choice(this.rng, available));
      }
      needed = pick - predicted.length;
    }
    return predicted.sort((a, b) => a - b);
  }
}

/* ------------------------------------------------------------------ *
 * 4. Long absence - long_absence.py
 * ------------------------------------------------------------------ */
export class LongAbsenceStrategy extends Strategy {
  static key = 'long_absence';
  static label = 'Long absence';
  static blurb =
    'Ranks numbers by days since they last appeared and picks from the N most overdue.';
  static paramSpec = [
    { key: 'topN', label: 'Candidate pool size', type: 'number', default: 10, min: 6, max: 55, step: 1 },
  ];

  sortedByAbsence(targetT) {
    if (this.cache.has(targetT)) return this.cache.get(targetT);
    const lastSeen = new Map();
    for (const d of this.ctx.before(targetT)) {
      for (const n of this.ctx.numbersOf(d)) lastSeen.set(n, d.t);
    }
    const daysAbsent = (n) =>
      lastSeen.has(n) ? (targetT - lastSeen.get(n)) / DAY_MS : Infinity;
    const sorted = this.ctx.allNumbers
      .slice()
      .sort((a, b) => daysAbsent(b) - daysAbsent(a));
    this.cache.set(targetT, sorted);
    return sorted;
  }

  predict(targetT) {
    const sorted = this.sortedByAbsence(targetT);
    const pool = sorted.slice(0, Math.max(this.params.topN, this.ctx.pick));
    const predicted = sample(this.rng, pool, this.ctx.pick);
    this.fillRandom(predicted, this.ctx.pick - predicted.length);
    return predicted.sort((a, b) => a - b);
  }
}

/* ------------------------------------------------------------------ *
 * 5. Pattern - pattern.py
 * ------------------------------------------------------------------ */
export class PatternStrategy extends Strategy {
  static key = 'pattern';
  static label = 'Pattern (spacing + range)';
  static blurb =
    'Learns the common gaps between sorted numbers and how draws spread across five value bands, then builds a ticket that imitates that shape.';
  static paramSpec = [
    { key: 'lookbackDays', label: 'Lookback (days)', type: 'number', default: 180, min: 14, max: 4000, step: 1 },
    { key: 'patternWeight', label: 'Share from pattern', type: 'range', default: 0.6, min: 0, max: 1, step: 0.1 },
  ];

  get bands() {
    if (!this._bands) {
      const { min, max } = this.ctx;
      const size = Math.floor((max - min + 1) / 5);
      this._bandSize = size;
      this._bands = Array.from({ length: 5 }, (_, i) => [
        min + i * size,
        i < 4 ? min + (i + 1) * size - 1 : max,
      ]);
    }
    return this._bands;
  }

  analyse(targetT) {
    if (this.cache.has(targetT)) return this.cache.get(targetT);
    this.bands; // ensure _bandSize
    const draws = this.ctx.window(targetT, this.params.lookbackDays);

    let analysis;
    if (!draws.length) {
      analysis = {
        spacings: Array.from({ length: 10 }, (_, i) => i + 1),
        bandCounts: [1, 1, 1, 1, 1],
      };
    } else {
      const spacingCounts = new Map();
      const bandCounts = [0, 0, 0, 0, 0];
      for (const d of draws) {
        const nums = this.ctx.numbersOf(d).slice().sort((a, b) => a - b);
        for (let i = 1; i < nums.length; i++) {
          const gap = nums[i] - nums[i - 1];
          spacingCounts.set(gap, (spacingCounts.get(gap) || 0) + 1);
        }
        for (const n of nums) {
          const b = Math.min(Math.floor((n - this.ctx.min) / this._bandSize), 4);
          if (b >= 0) bandCounts[b]++;
        }
      }
      analysis = {
        spacings: [...spacingCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([gap]) => gap),
        bandCounts,
      };
    }
    this.cache.set(targetT, analysis);
    return analysis;
  }

  patternNumbers(analysis) {
    const bands = this.bands;
    const total = analysis.bandCounts.reduce((a, b) => a + b, 0);
    const probs = analysis.bandCounts.map((c) => (total > 0 ? c / total : 0.2));
    const bandIdx = weightedChoice(this.rng, [0, 1, 2, 3, 4], probs);
    const [lo, hi] = bands[bandIdx];

    const predicted = [randInt(this.rng, lo, hi)];
    const common = analysis.spacings.slice(0, 5);
    const gaps = common.length ? common : [1, 2, 3, 4, 5];

    while (predicted.length < this.ctx.pick) {
      const last = predicted[predicted.length - 1];
      const gap = choice(this.rng, gaps);
      const candidates = [];
      if (last + gap <= this.ctx.max) candidates.push(last + gap);
      if (last - gap >= this.ctx.min) candidates.push(last - gap);
      const valid = candidates.filter((c) => !predicted.includes(c));
      if (valid.length) {
        predicted.push(choice(this.rng, valid));
      } else {
        const taken = new Set(predicted);
        const available = this.ctx.allNumbers.filter((n) => !taken.has(n));
        if (!available.length) break;
        predicted.push(choice(this.rng, available));
      }
    }
    return predicted.sort((a, b) => a - b);
  }

  predict(targetT) {
    const analysis = this.analyse(targetT);
    const patternCount = Math.trunc(this.ctx.pick * this.params.patternWeight);
    const predicted =
      patternCount > 0 ? this.patternNumbers(analysis).slice(0, patternCount) : [];
    this.fillRandom(predicted, this.ctx.pick - predicted.length);
    return predicted.slice(0, this.ctx.pick).sort((a, b) => a - b);
  }
}

/* ------------------------------------------------------------------ *
 * 6. Pair co-occurrence - pair_frequency.py
 * ------------------------------------------------------------------ */
export class PairFrequencyStrategy extends Strategy {
  static key = 'pair_frequency';
  static label = 'Pair co-occurrence';
  static blurb =
    'Counts which numbers fall together in the same draw, then grows a ticket greedily around the numbers that cluster with what is already picked.';
  static paramSpec = [
    { key: 'lookbackDays', label: 'Lookback (days)', type: 'number', default: 365, min: 30, max: 4000, step: 1 },
  ];

  matrices(targetT) {
    if (this.cache.has(targetT)) return this.cache.get(targetT);
    const individual = new Map();
    const pairs = new Map(); // "a:b" -> count
    for (const d of this.ctx.window(targetT, this.params.lookbackDays)) {
      const nums = this.ctx.numbersOf(d).filter((n) => n >= this.ctx.min && n <= this.ctx.max);
      for (const n of nums) individual.set(n, (individual.get(n) || 0) + 1);
      for (let i = 0; i < nums.length; i++) {
        for (let j = i + 1; j < nums.length; j++) {
          const a = nums[i];
          const b = nums[j];
          const k1 = `${a}:${b}`;
          const k2 = `${b}:${a}`;
          pairs.set(k1, (pairs.get(k1) || 0) + 1);
          pairs.set(k2, (pairs.get(k2) || 0) + 1);
        }
      }
    }
    const out = { individual, pairs };
    this.cache.set(targetT, out);
    return out;
  }

  predict(targetT) {
    const { individual, pairs } = this.matrices(targetT);
    const nums = this.ctx.allNumbers;

    // Laplace smoothing keeps every number eligible.
    const first = weightedChoice(this.rng, nums, nums.map((n) => (individual.get(n) || 0) + 1));
    const predicted = [first];
    const remaining = nums.filter((n) => n !== first);

    while (predicted.length < this.ctx.pick && remaining.length) {
      const scores = remaining.map((n) => {
        let s = 0;
        for (const p of predicted) s += pairs.get(`${p}:${n}`) || 0;
        return s / predicted.length + 0.1;
      });
      const chosen = weightedChoice(this.rng, remaining, scores);
      predicted.push(chosen);
      remaining.splice(remaining.indexOf(chosen), 1);
    }
    return predicted.sort((a, b) => a - b);
  }
}

/* ------------------------------------------------------------------ *
 * 7. Exponential decay - exponential_decay.py
 * ------------------------------------------------------------------ */
export class ExponentialDecayStrategy extends Strategy {
  static key = 'exponential_decay';
  static label = 'Exponential decay';
  static blurb =
    'Like frequency, but every past draw is weighted by exp(-ln2 * age / half-life) - no hard window edge, recent draws simply count more.';
  static paramSpec = [
    { key: 'halfLifeDays', label: 'Half-life (days)', type: 'number', default: 90, min: 7, max: 2000, step: 1 },
    {
      key: 'hot',
      label: 'Direction',
      type: 'select',
      default: 'true',
      options: [
        { value: 'true', label: 'Hot - momentum' },
        { value: 'false', label: 'Cold - contrarian' },
      ],
    },
    { key: 'selectionWeight', label: 'Share chosen by score', type: 'range', default: 0.8, min: 0, max: 1, step: 0.1 },
  ];

  scores(targetT) {
    if (this.cache.has(targetT)) return this.cache.get(targetT);
    const lambda = Math.LN2 / this.params.halfLifeDays;
    const scores = new Map(this.ctx.allNumbers.map((n) => [n, 0]));
    for (const d of this.ctx.before(targetT)) {
      const w = Math.exp((-lambda * (targetT - d.t)) / DAY_MS);
      for (const n of this.ctx.numbersOf(d)) {
        if (scores.has(n)) scores.set(n, scores.get(n) + w);
      }
    }
    this.cache.set(targetT, scores);
    return scores;
  }

  predict(targetT) {
    const hot = String(this.params.hot) === 'true';
    const scores = this.scores(targetT);
    const nums = this.ctx.allNumbers;
    let maxScore = 0;
    for (const v of scores.values()) maxScore = Math.max(maxScore, v);

    const weights = nums.map((n) => {
      const s = scores.get(n) || 0;
      return hot
        ? Math.max(1, Math.round(s * 10))
        : Math.max(1, Math.round((maxScore - s + 0.1) * 10));
    });

    const scoreCount = Math.trunc(this.ctx.pick * this.params.selectionWeight);
    const predicted = scoreCount > 0 ? weightedSample(this.rng, nums, weights, scoreCount) : [];
    this.fillRandom(predicted, this.ctx.pick - scoreCount);
    return predicted.sort((a, b) => a - b);
  }
}

/* ------------------------------------------------------------------ *
 * 8. Markov chain - markov_chain.py
 * ------------------------------------------------------------------ */
export class MarkovChainStrategy extends Strategy {
  static key = 'markov_chain';
  static label = 'Markov chain';
  static blurb =
    'Builds a transition table over consecutive draws, then scores each number by how often it followed the numbers in the latest draw.';
  static paramSpec = [
    { key: 'lookbackDays', label: 'Lookback (days)', type: 'number', default: 365, min: 30, max: 4000, step: 1 },
    { key: 'smoothing', label: 'Laplace smoothing', type: 'range', default: 0.5, min: 0.1, max: 5, step: 0.1 },
  ];

  model(targetT) {
    if (this.cache.has(targetT)) return this.cache.get(targetT);
    const idx = this.ctx.indexBefore(targetT);
    if (idx === 0) {
      const empty = { prev: null, matrix: new Map() };
      this.cache.set(targetT, empty);
      return empty;
    }
    const prev = this.ctx.numbersOf(this.ctx.draws[idx - 1]);
    const window = this.ctx.window(targetT, this.params.lookbackDays);
    const matrix = new Map(); // "a:b" -> count
    for (let i = 0; i < window.length - 1; i++) {
      const from = this.ctx.numbersOf(window[i]);
      const to = this.ctx.numbersOf(window[i + 1]);
      for (const a of from) {
        if (a < this.ctx.min || a > this.ctx.max) continue;
        for (const b of to) {
          if (b < this.ctx.min || b > this.ctx.max) continue;
          const k = `${a}:${b}`;
          matrix.set(k, (matrix.get(k) || 0) + 1);
        }
      }
    }
    const out = { prev, matrix };
    this.cache.set(targetT, out);
    return out;
  }

  predict(targetT) {
    const { prev, matrix } = this.model(targetT);
    const nums = this.ctx.allNumbers;
    if (!prev || !matrix.size) {
      return sample(this.rng, nums, this.ctx.pick).sort((a, b) => a - b);
    }
    const weights = nums.map((n) => {
      let s = 0;
      for (const p of prev) s += matrix.get(`${p}:${n}`) || 0;
      return s + this.params.smoothing;
    });
    return weightedSample(this.rng, nums, weights, this.ctx.pick).sort((a, b) => a - b);
  }
}

export const STRATEGIES = [
  RandomStrategy,
  FrequencyStrategy,
  NotRepeatStrategy,
  LongAbsenceStrategy,
  PatternStrategy,
  PairFrequencyStrategy,
  ExponentialDecayStrategy,
  MarkovChainStrategy,
];

export const STRATEGY_BY_KEY = Object.fromEntries(STRATEGIES.map((S) => [S.key, S]));
