/**
 * Data acquisition, in priority order:
 *
 *  1. Local proxy (`node server.js`) -> live POST to vietlott.vn, the same
 *     ajaxpro endpoint the upstream Python crawler uses. Browsers cannot call
 *     it directly: vietlott.vn sends no CORS headers, so the request must be
 *     relayed server-side.
 *  2. raw.githubusercontent.com -> the upstream repo's JSONL, refreshed daily
 *     by the maintainer's own crawler. CORS-enabled, works from any host.
 *  3. ./data/*.jsonl -> the snapshot bundled with this app.
 */

import { PRODUCTS, GITHUB_RAW } from './config.js';
import { parseJsonl, decorate } from './store.js';

let proxyState = null; // null = unknown, true/false once probed

export async function probeProxy({ force = false } = {}) {
  if (proxyState !== null && !force) return proxyState;
  try {
    const res = await fetch('./api/health', { cache: 'no-store' });
    const body = await res.json();
    proxyState = res.ok && body.ok === true;
  } catch {
    proxyState = false;
  }
  return proxyState;
}

export function proxyKnownState() {
  return proxyState;
}

/**
 * Parse the ajaxpro `HtmlContent` payload into draw rows.
 * Mirrors ProductPower655.process_result: skip the header row, read
 * date / id / number spans, dropping the "|" separator before the bonus ball.
 */
export function parseHtmlContent(html, product) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const rows = [];
  const trs = [...doc.querySelectorAll('table tr')];
  trs.forEach((tr, i) => {
    if (i === 0) return; // header
    const tds = tr.querySelectorAll('td');
    if (tds.length < 3) return;
    const dateText = tds[0].textContent.trim();
    const m = dateText.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return;
    const date = `${m[3]}-${m[2]}-${m[1]}`;
    const id = tds[1].textContent.trim();
    const result = [...tds[2].querySelectorAll('span')]
      .map((s) => s.textContent.trim())
      .filter((s) => s !== '|' && s !== '')
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (!result.length) return;
    rows.push(
      decorate(
        { date, id, result, process_time: new Date().toISOString() },
        product
      )
    );
  });
  return rows;
}

/** Crawl live pages [pageFrom, pageTo] through the local proxy. */
export async function crawlLive(product, pageFrom = 0, pageTo = 0, onProgress) {
  const out = [];
  for (let page = pageFrom; page <= pageTo; page++) {
    onProgress?.(`crawling page ${page}/${pageTo}`);
    const res = await fetch(
      `./api/crawl?product=${encodeURIComponent(product)}&page=${page}`,
      { cache: 'no-store' }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`proxy page ${page}: HTTP ${res.status} ${detail.slice(0, 160)}`);
    }
    const body = await res.json();
    if (!body.htmlContent) throw new Error(`proxy page ${page}: empty response`);
    const rows = parseHtmlContent(body.htmlContent, product);
    if (!rows.length) break; // past the last page
    out.push(...rows);
  }
  return out;
}

export async function fetchGithub(product) {
  const url = GITHUB_RAW + PRODUCTS[product].file;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GitHub raw: HTTP ${res.status}`);
  return parseJsonl(await res.text()).map((r) => decorate(r, product));
}

export async function fetchSeed(product) {
  const res = await fetch(`./data/${PRODUCTS[product].file}`, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`bundled snapshot: HTTP ${res.status}`);
  return parseJsonl(await res.text()).map((r) => decorate(r, product));
}
