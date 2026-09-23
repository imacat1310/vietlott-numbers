/**
 * Draw storage: parse JSONL, merge sources by draw id, persist to localStorage.
 *
 * A draw record is kept in the upstream shape
 *   { date, id, result, process_time }
 * and decorated with { main, bonus, t } for the strategies.
 */

import { PRODUCTS, STORAGE_PREFIX } from './config.js';

export function parseJsonl(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      if (o && o.date && o.result) rows.push(o);
    } catch {
      /* skip malformed line */
    }
  }
  return rows;
}

/** Midnight-UTC timestamp for a YYYY-MM-DD string. */
export function dayTs(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export const DAY_MS = 86400000;

export function decorate(row, product) {
  const p = PRODUCTS[product];
  const result = row.result.map(Number);
  return {
    date: row.date,
    id: String(row.id ?? ''),
    result,
    main: result.slice(0, p.pick),
    bonus: p.hasBonus && result.length > p.pick ? result[p.pick] : null,
    t: dayTs(row.date),
    process_time: row.process_time || null,
  };
}

/**
 * Merge new rows into existing ones. Identity is the draw id when present,
 * otherwise the date. Newly crawled rows win so corrections propagate.
 */
export function mergeRows(existing, incoming) {
  const byKey = new Map();
  for (const r of existing) byKey.set(r.id || r.date, r);
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    const key = r.id || r.date;
    const prev = byKey.get(key);
    if (!prev) {
      added++;
      byKey.set(key, r);
    } else if (JSON.stringify(prev.result) !== JSON.stringify(r.result)) {
      updated++;
      byKey.set(key, r);
    }
  }
  const merged = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { merged, added, updated };
}

const keyFor = (product) => `${STORAGE_PREFIX}draws.${product}`;
const metaKey = (product) => `${STORAGE_PREFIX}meta.${product}`;

export function loadCached(product) {
  try {
    const raw = localStorage.getItem(keyFor(product));
    if (!raw) return null;
    const rows = JSON.parse(raw);
    return Array.isArray(rows) ? rows.map((r) => decorate(r, product)) : null;
  } catch {
    return null;
  }
}

export function saveCached(product, rows) {
  try {
    const slim = rows.map(({ date, id, result, process_time }) => ({
      date,
      id,
      result,
      process_time,
    }));
    localStorage.setItem(keyFor(product), JSON.stringify(slim));
    return true;
  } catch {
    // Quota exceeded: the app still works, it just re-fetches next load.
    return false;
  }
}

export function loadMeta(product) {
  try {
    return JSON.parse(localStorage.getItem(metaKey(product))) || {};
  } catch {
    return {};
  }
}

export function saveMeta(product, meta) {
  try {
    localStorage.setItem(metaKey(product), JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

export function clearCache() {
  for (const p of Object.keys(PRODUCTS)) {
    localStorage.removeItem(keyFor(p));
    localStorage.removeItem(metaKey(p));
  }
}

export function toJsonl(rows) {
  return rows
    .map((r) =>
      JSON.stringify({
        date: r.date,
        id: r.id,
        result: r.result,
        process_time: r.process_time,
      })
    )
    .join('\n');
}
