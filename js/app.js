/**
 * App wiring: data loading, the four tabs, and the background crawler.
 */

import { PRODUCTS, DEFAULT_PRODUCT, STORAGE_PREFIX } from './config.js';
import {
  loadCached, saveCached, loadMeta, saveMeta, clearCache,
  mergeRows, toJsonl, dayTs, DAY_MS,
} from './store.js';
import { probeProxy, proxyKnownState, crawlLive, fetchGithub, fetchSeed } from './crawler.js';
import { STRATEGIES, STRATEGY_BY_KEY, Context } from './strategies.js';
import { makeRng } from './rng.js';
import { frequency, absence, topPairs, shapeSummary } from './stats.js';
import { runBacktest, expectedRandomMatches } from './backtest.js';
import {
  KENO, distribution, winProbability, generateAllLevels, generateTicket,
  scoreAgainstHistory, hyperPmf, evaluate, examplePrizes, payableCounts,
  DEFAULT_TICKET_PRICE,
} from './keno.js';
import { barChart } from './chart.js';

const $ = (id) => document.getElementById(id);

const state = {
  productKey: localStorage.getItem(`${STORAGE_PREFIX}product`) || DEFAULT_PRODUCT,
  draws: [],
  source: 'none',
  meta: {},
  autoTimer: null,
  nextRun: null,
  crawling: false,
};

const product = () => PRODUCTS[state.productKey];

/* ------------------------------------------------------------------ *
 * formatting
 * ------------------------------------------------------------------ */

const nf = new Intl.NumberFormat('en-US');
const fmtInt = (n) => nf.format(Math.round(n));

function fmtVnd(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B ₫`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M ₫`;
  // Below 100k, show the exact figure: expected values sit around a few
  // thousand dong and rounding them to "6k" hides the differences between
  // pick levels, which is the whole point of the column.
  if (abs >= 1e5) return `${fmtInt(n / 1e3)}k ₫`;
  return `${fmtInt(n)} ₫`;
}

/** "1 in N" odds: keep a decimal while N is small, round once it is large. */
function fmtOneIn(x) {
  if (!Number.isFinite(x)) return '—';
  if (x < 20) return x.toFixed(1);
  return fmtInt(x);
}

function fmtRelative(ts) {
  if (!ts) return 'never';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const pad2 = (n) => String(n).padStart(2, '0');

function ballsHtml(nums, { bonusIndex = null, small = false } = {}) {
  const cls = small ? 'ball sm' : 'ball';
  return nums
    .map((n, i) => {
      if (bonusIndex !== null && i === bonusIndex) {
        return `<span class="ball-sep">|</span><span class="${cls} bonus" title="bonus ball">${pad2(n)}</span>`;
      }
      return `<span class="${cls}">${pad2(n)}</span>`;
    })
    .join('');
}

function drawBalls(d, small = true) {
  const p = product();
  const bonusIndex = p.hasBonus && d.result.length > p.pick ? p.pick : null;
  return `<div class="ball-row">${ballsHtml(d.result, { bonusIndex, small })}</div>`;
}

function log(msg) {
  const box = $('crawl-log');
  const now = new Date().toLocaleTimeString();
  box.textContent = `${now}  ${msg}\n${box.textContent}`.split('\n').slice(0, 200).join('\n');
}

/* ------------------------------------------------------------------ *
 * data loading
 * ------------------------------------------------------------------ */

function setStatus(kind, text) {
  $('data-status-text').textContent = text;
  $('data-status').querySelector('.led').className = `led ${kind}`;
}

function applyDraws(rows, source, { persist = true } = {}) {
  state.draws = rows;
  state.source = source;
  if (persist) saveCached(state.productKey, rows);
  const latest = rows.length ? rows[rows.length - 1].date : '—';
  setStatus(
    source === 'live' ? 'live' : source === 'github' ? 'live' : 'warn',
    `${fmtInt(rows.length)} draws · latest ${latest}`
  );
  renderAll();
}

async function loadInitial() {
  setStatus('', 'loading…');
  const cached = loadCached(state.productKey);
  state.meta = loadMeta(state.productKey);

  if (cached && cached.length) {
    applyDraws(cached, 'cache', { persist: false });
    log(`loaded ${cached.length} draws from local cache`);
  } else {
    try {
      const seed = await fetchSeed(state.productKey);
      applyDraws(seed, 'seed');
      log(`loaded ${seed.length} draws from the bundled snapshot`);
    } catch (e) {
      log(`bundled snapshot unavailable (${e.message}) — trying GitHub`);
      try {
        const gh = await fetchGithub(state.productKey);
        applyDraws(gh, 'github');
      } catch (e2) {
        setStatus('off', 'no data');
        log(`could not load any data: ${e2.message}`);
        return;
      }
    }
  }

  await probeProxy();
  renderSourceNote();
  refreshInBackground();
}

/** Pull whatever is newest, without blocking the UI. */
async function refreshInBackground() {
  const lastSync = state.meta.lastSync || 0;
  if (Date.now() - lastSync < 5 * 60 * 1000 && state.draws.length) return;
  await crawl({ quiet: true });
}

/* ------------------------------------------------------------------ *
 * crawling
 * ------------------------------------------------------------------ */

async function crawl({ pages = null, quiet = false, preferGithub = false } = {}) {
  if (state.crawling) return;
  state.crawling = true;
  $('crawl-now').disabled = true;
  $('crawl-backfill').disabled = true;

  const pageCount = pages ?? Math.max(1, Number($('crawl-pages').value) || 1);

  try {
    const hasProxy = await probeProxy();
    let rows = null;
    let source = null;

    if (hasProxy && !preferGithub) {
      try {
        if (!quiet) log(`crawling vietlott.vn: ${pageCount} page(s) of ${product().label}…`);
        rows = await crawlLive(state.productKey, 0, pageCount - 1, (m) => !quiet && log(m));
        source = 'live';
      } catch (e) {
        log(`live crawl failed (${e.message}) — falling back to GitHub`);
      }
    }

    if (!rows) {
      if (!quiet) log('fetching the upstream repo snapshot…');
      rows = await fetchGithub(state.productKey);
      source = 'github';
    }

    const { merged, added, updated } = mergeRows(state.draws, rows);
    state.meta = {
      ...state.meta,
      lastSync: Date.now(),
      lastSource: source,
      lastAdded: added,
    };
    saveMeta(state.productKey, state.meta);
    applyDraws(merged, source);
    log(
      `${source === 'live' ? 'live crawl' : 'GitHub sync'}: ${added} new, ${updated} corrected, ${merged.length} total`
    );
  } catch (e) {
    log(`crawl failed: ${e.message}`);
    setStatus('off', 'crawl failed');
  } finally {
    state.crawling = false;
    $('crawl-now').disabled = false;
    $('crawl-backfill').disabled = false;
    renderDataTab();
  }
}

function scheduleAuto() {
  clearInterval(state.autoTimer);
  state.autoTimer = null;
  state.nextRun = null;

  if (!$('crawl-auto').checked) {
    localStorage.setItem(`${STORAGE_PREFIX}auto`, '0');
    $('crawl-next').textContent = 'auto-crawl off';
    return;
  }
  const mins = Math.max(1, Number($('crawl-interval').value) || 30);
  localStorage.setItem(`${STORAGE_PREFIX}auto`, '1');
  localStorage.setItem(`${STORAGE_PREFIX}interval`, String(mins));

  state.nextRun = Date.now() + mins * 60000;
  state.autoTimer = setInterval(() => {
    state.nextRun = Date.now() + mins * 60000;
    crawl({ quiet: false });
  }, mins * 60000);

  $('crawl-next').textContent = `next run in ${mins}m`;
  log(`auto-crawl on, every ${mins} minute(s)`);
}

setInterval(() => {
  if (state.nextRun) {
    const left = Math.max(0, Math.round((state.nextRun - Date.now()) / 60000));
    $('crawl-next').textContent = `next run in ~${left}m`;
  }
}, 30000);

/* ------------------------------------------------------------------ *
 * generate tab
 * ------------------------------------------------------------------ */

function renderParamInputs(container, Strat, prefix) {
  container.innerHTML = '';
  for (const spec of Strat.paramSpec || []) {
    const id = `${prefix}-${spec.key}`;
    const label = document.createElement('label');
    label.className = 'field';
    if (spec.type === 'select') {
      label.innerHTML = `<span>${spec.label}</span>
        <select id="${id}" data-param="${spec.key}">
          ${spec.options.map((o) => `<option value="${o.value}"${o.value === String(spec.default) ? ' selected' : ''}>${o.label}</option>`).join('')}
        </select>`;
    } else if (spec.type === 'range') {
      label.innerHTML = `<span>${spec.label}</span>
        <span class="range-row">
          <input type="range" id="${id}" data-param="${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.default}">
          <output for="${id}">${spec.default}</output>
        </span>`;
    } else {
      label.innerHTML = `<span>${spec.label}</span>
        <input type="number" id="${id}" data-param="${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${spec.default}">`;
    }
    container.append(label);
  }
  container.querySelectorAll('input[type="range"]').forEach((r) => {
    r.addEventListener('input', () => {
      r.parentElement.querySelector('output').textContent = r.value;
    });
  });
}

function readParams(container) {
  const out = {};
  container.querySelectorAll('[data-param]').forEach((node) => {
    const key = node.dataset.param;
    out[key] = node.type === 'number' || node.type === 'range' ? Number(node.value) : node.value;
  });
  return out;
}

function generate() {
  const Strat = STRATEGY_BY_KEY[$('gen-strategy').value];
  const count = Math.max(1, Math.min(50, Number($('gen-count').value) || 1));
  const useBonus = $('gen-bonus').checked;
  const seed = $('gen-seed').value.trim() || null;

  if (!state.draws.length) {
    $('gen-output').innerHTML = '<p class="muted">No draw history loaded yet.</p>';
    return;
  }

  const rng = makeRng(seed);
  const ctx = new Context({ draws: state.draws, product: product(), useBonus, rng });
  const strategy = new Strat(ctx, readParams($('gen-params')));

  // Predict for the next draw: one interval past the latest one we know about.
  const latest = state.draws[state.draws.length - 1];
  const targetT = latest.t + 2 * DAY_MS;

  const freq = frequency(state.draws, product(), useBonus);
  const byNumber = new Map(freq.map((f) => [f.number, f]));
  const hotCut = [...freq].sort((a, b) => b.count - a.count)[Math.floor(freq.length / 3)]?.count ?? 0;
  const abs = new Map(
    absence(state.draws, product(), useBonus, targetT).map((a) => [a.number, a])
  );

  const tickets = [];
  for (let i = 0; i < count; i++) tickets.push(strategy.predict(targetT));

  const mid = (product().min + product().max) / 2;
  $('gen-output').innerHTML = tickets
    .map((t, i) => {
      const sum = t.reduce((a, b) => a + b, 0);
      const odd = t.filter((n) => n % 2 === 1).length;
      const low = t.filter((n) => n <= mid).length;
      const hot = t.filter((n) => (byNumber.get(n)?.count ?? 0) >= hotCut).length;
      const overdue = t.filter((n) => (abs.get(n)?.drawsAgo ?? 0) >= 20).length;
      return `<div class="ticket">
        <span class="idx">#${i + 1}</span>
        <span class="ball-row">${ballsHtml(t)}</span>
        <span class="tags">
          <span class="tag">sum ${sum}</span>
          <span class="tag">${odd} odd / ${t.length - odd} even</span>
          <span class="tag">${low} low / ${t.length - low} high</span>
          ${hot ? `<span class="tag good">${hot} hot</span>` : ''}
          ${overdue ? `<span class="tag warn">${overdue} overdue</span>` : ''}
        </span>
      </div>`;
    })
    .join('');

  const nextDate = new Date(targetT).toISOString().slice(0, 10);
  $('gen-context').textContent =
    `${product().label} · ${Strat.label} · for a draw after ${latest.date}` +
    (seed ? ` · seed ${seed}` : '');

  const note = $('gen-note');
  note.hidden = false;
  note.innerHTML =
    `<strong>These are not predictions.</strong> ${Strat.label} shapes the pick from ${fmtInt(state.draws.length)} past draws, ` +
    `but each ${product().label} draw is independent: every combination stays at 1 in ${fmtInt(combinations(product().max - product().min + 1, product().pick))}. ` +
    `Target draw estimated on or after ${nextDate}.`;

  state.lastTickets = tickets;
}

function combinations(n, k) {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

function renderRecentInGenerate() {
  const recent = state.draws.slice(-6).reverse();
  $('gen-recent').innerHTML = recent.length
    ? recent
        .map(
          (d) => `<div class="ticket">
            <span class="idx">${d.date.slice(5)}</span>
            ${drawBalls(d)}
            <span class="tags"><span class="tag mono">#${d.id}</span></span>
          </div>`
        )
        .join('')
    : '<p class="muted">No draws loaded.</p>';
}

/* ------------------------------------------------------------------ *
 * statistics tab
 * ------------------------------------------------------------------ */

function statsDraws() {
  if (!$('stats-window').checked) return state.draws;
  const n = Math.max(10, Number($('stats-window-n').value) || 100);
  return state.draws.slice(-n);
}

function renderStats() {
  const p = product();
  const useBonus = $('stats-bonus').checked;
  const draws = statsDraws();

  if (!draws.length) {
    $('stats-tiles').innerHTML = '<p class="muted">No data.</p>';
    return;
  }

  const latest = state.draws[state.draws.length - 1];
  const shape = shapeSummary(draws, p, useBonus, 50);
  const asOf = latest.t;

  $('stats-tiles').innerHTML = [
    tile('Draws stored', fmtInt(state.draws.length), `${state.draws[0].date} → ${latest.date}`),
    tile('Latest draw', latest.date, `#${latest.id}`, true),
    tile('Odd share (last 50)', `${shape.oddPct.toFixed(1)}%`, 'balanced ≈ 50%'),
    tile('Low half (last 50)', `${shape.lowPct.toFixed(1)}%`, `numbers ≤ ${Math.floor((p.min + p.max) / 2)}`),
    tile('Avg draw sum', shape.avgSum.toFixed(1), `expected ≈ ${(((p.min + p.max) / 2) * (useBonus && p.hasBonus ? p.pick + 1 : p.pick)).toFixed(0)}`),
  ].join('');

  const metric = $('stats-metric').value;
  const chartBox = $('stats-chart');

  if (metric === 'freq') {
    const freq = frequency(draws, p, useBonus);
    const avg = freq.reduce((a, f) => a + f.count, 0) / freq.length;
    barChart(
      chartBox,
      freq.map((f) => ({
        label: f.number,
        value: f.count,
        dim: f.count < avg,
        tip: `<b>${pad2(f.number)}</b> drawn ${f.count}× &middot; ${f.pct.toFixed(2)}% of balls`,
      })),
      { height: 220, valueFormat: (v) => fmtInt(v), ariaLabel: 'times each number was drawn' }
    );
    $('stats-chart-title').textContent = 'Number frequency';
    $('stats-chart-sub').textContent =
      `${fmtInt(draws.length)} draws · average ${avg.toFixed(1)} per number · dim bars are below average`;
  } else {
    const abs = absence(draws, p, useBonus, asOf);
    const key = metric === 'days' ? 'days' : 'drawsAgo';
    const unit = metric === 'days' ? 'days' : 'draws';
    const max = Math.max(...abs.map((a) => a[key] ?? 0));
    barChart(
      chartBox,
      abs.map((a) => ({
        label: a.number,
        value: a[key] ?? max,
        dim: (a[key] ?? 0) < max / 3,
        tip: a.lastDate
          ? `<b>${pad2(a.number)}</b> last drawn ${a.lastDate} &middot; ${a[key]} ${unit} ago`
          : `<b>${pad2(a.number)}</b> never drawn in this window`,
      })),
      { height: 220, valueFormat: (v) => fmtInt(v), ariaLabel: `${unit} since each number was drawn` }
    );
    $('stats-chart-title').textContent = `${metric === 'days' ? 'Days' : 'Draws'} since last appearance`;
    $('stats-chart-sub').textContent = `measured at ${latest.date} · taller means more overdue`;
  }

  const recent = state.draws.slice(-15).reverse();
  $('stats-recent').innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Date</th><th>Draw</th><th>Result</th></tr></thead>
    <tbody>${recent
      .map(
        (d) => `<tr><td>${d.date}</td><td class="mono">${d.id}</td><td>${drawBalls(d)}</td></tr>`
      )
      .join('')}</tbody></table></div>`;

  const pairs = topPairs(draws, useBonus, 12);
  const maxPair = pairs[0]?.count || 1;
  $('stats-pairs').innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Pair</th><th class="num">Together</th><th class="num">Share of draws</th></tr></thead>
    <tbody>${pairs
      .map(
        (p2) => `<tr>
          <td><span class="ball-row">${ballsHtml([p2.a, p2.b], { small: true })}</span></td>
          <td class="num${p2.count === maxPair ? ' best' : ''}">${p2.count}×</td>
          <td class="num">${((p2.count / draws.length) * 100).toFixed(1)}%</td>
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

function tile(k, v, s, mono = false) {
  return `<div class="tile"><div class="k">${k}</div><div class="v${mono ? ' mono' : ''}">${v}</div><div class="s">${s || ''}</div></div>`;
}

/* ------------------------------------------------------------------ *
 * backtest tab
 * ------------------------------------------------------------------ */

function renderPrizeInputs() {
  const p = product();
  const tiers = Object.keys(p.prizes).map(Number).sort((a, b) => b - a);
  $('bt-prizes').innerHTML =
    `<label class="field"><span>Ticket price</span>
      <input type="number" id="bt-price" value="${p.ticketPrice}" min="0" step="1000"></label>` +
    tiers
      .map(
        (t) => `<label class="field"><span>${t} matching numbers</span>
          <input type="number" class="bt-prize" data-tier="${t}" value="${p.prizes[t]}" min="0" step="1000"></label>`
      )
      .join('') +
    (p.prizesAreRepoDefault
      ? '<p class="note">Values from the repo\'s <span class="mono">base.py</span> prize table for Power 6/55.</p>'
      : '<p class="note warn">The repo only ships a prize table for Power 6/55. These are <strong>estimates</strong> — edit them to match the current rules before reading any ROI figure.</p>');
}

function readPrizes() {
  const prizes = {};
  document.querySelectorAll('.bt-prize').forEach((i) => {
    prizes[Number(i.dataset.tier)] = Number(i.value) || 0;
  });
  return prizes;
}

async function runBacktestUI() {
  const key = $('bt-strategy').value;
  const n = Math.max(5, Number($('bt-n').value) || 52);
  const tickets = Math.max(1, Number($('bt-tickets').value) || 1);
  const useBonus = $('bt-bonus').checked;
  const seed = $('bt-seed').value.trim() || null;
  const prizes = readPrizes();
  const ticketPrice = Number($('bt-price').value) || product().ticketPrice;

  if (state.draws.length < n + 10) {
    $('bt-result').innerHTML = `<p class="muted">Need more history: only ${state.draws.length} draws stored.</p>`;
    return;
  }

  const fromDate = state.draws[Math.max(0, state.draws.length - n)].date;
  const keys = key === '__all__' ? STRATEGIES.map((S) => S.key) : [key];

  $('bt-run').disabled = true;
  $('bt-progress').innerHTML = '<span class="spinner"></span> running…';
  await new Promise((r) => setTimeout(r, 20)); // let the spinner paint

  const results = [];
  for (const k of keys) {
    const params = key === '__all__' ? {} : readParams($('bt-params-host'));
    results.push(
      runBacktest({
        draws: state.draws,
        product: product(),
        strategyKey: k,
        params,
        ticketsPerDraw: tickets,
        fromDate,
        useBonus,
        seed,
        prizes,
        ticketPrice,
      })
    );
    $('bt-progress').innerHTML = `<span class="spinner"></span> ${results.length}/${keys.length} done…`;
    await new Promise((r) => setTimeout(r, 0));
  }

  $('bt-run').disabled = false;
  $('bt-progress').textContent = '';
  $('bt-sub').textContent = `${fromDate} → ${state.draws[state.draws.length - 1].date} · ${tickets} ticket(s) per draw`;
  renderBacktestResults(results, keys.length > 1);
}

function renderBacktestResults(results, isComparison) {
  const p = product();
  const baseline = expectedRandomMatches(p);
  const box = $('bt-result');

  if (isComparison) {
    const sorted = [...results].sort((a, b) => b.avgMatches - a.avgMatches);
    const best = sorted[0];
    box.innerHTML =
      `<div class="tiles">
        ${tile('Best avg matches', best.avgMatches.toFixed(3), best.label)}
        ${tile('Random baseline', baseline.toFixed(3), 'expected per ticket')}
        ${tile('Tickets each', fmtInt(best.tickets), `over ${fmtInt(best.drawsEvaluated)} draws`)}
        ${tile('Spend each', fmtVnd(best.cost), 'per strategy')}
      </div>
      <div class="table-wrap" style="margin-top:14px"><table class="data">
        <thead><tr>
          <th>Strategy</th><th class="num">Avg matches</th><th class="num">vs random</th>
          <th class="num">≥${best.lowestTier} hits</th><th class="num">Jackpots</th>
          <th class="num">Returned</th><th class="num">ROI</th>
        </tr></thead>
        <tbody>${sorted
          .map(
            (r) => `<tr>
              <td>${r.label}</td>
              <td class="num${r === best ? ' best' : ''}">${r.avgMatches.toFixed(3)}</td>
              <td class="num">${((r.avgMatches / baseline - 1) * 100).toFixed(1)}%</td>
              <td class="num">${r.prizeWins}</td>
              <td class="num">${r.jackpots}</td>
              <td class="num">${fmtVnd(r.gain)}</td>
              <td class="num">${r.roi.toFixed(1)}%</td>
            </tr>`
          )
          .join('')}</tbody></table></div>
      <p class="note warn"><strong>Read this as noise, not skill.</strong> The spread between strategies here is
      sampling variation: with ${fmtInt(best.tickets)} tickets each, differences of a few hundredths of a match
      are what you would get from shuffling the same coin. Every row loses money, which is the only durable result.</p>`;
    return;
  }

  const r = results[0];
  const distMax = Math.max(...r.distribution.map(([, c]) => c));
  box.innerHTML =
    `<div class="tiles">
      ${tile('Avg matches', r.avgMatches.toFixed(3), `random baseline ${baseline.toFixed(3)}`)}
      ${tile('Tickets', fmtInt(r.tickets), `over ${fmtInt(r.drawsEvaluated)} draws`)}
      ${tile(`Prize hits (≥${r.lowestTier})`, `${r.prizeWins}`, `${r.prizeRate.toFixed(2)}% of tickets`)}
      ${tile('Jackpots', `${r.jackpots}`, `${r.pick || p.pick}/${p.pick} matches`)}
      ${tile('Spent', fmtVnd(r.cost), `${fmtInt(r.tickets)} × ${fmtInt(r.cost / (r.tickets || 1))} ₫`)}
      ${`<div class="tile"><div class="k">Net result</div><div class="v ${r.profit >= 0 ? 'pos' : 'neg'}">${fmtVnd(r.profit)}</div><div class="s">ROI ${r.roi.toFixed(1)}%</div></div>`}
    </div>
    <h3 style="margin:18px 0 8px">Match distribution</h3>
    <div id="bt-dist"></div>
    <p class="note warn"><strong>Expect a loss.</strong> ${r.label} matched ${r.avgMatches.toFixed(3)} numbers per ticket
    against a random-play expectation of ${baseline.toFixed(3)} — the gap is sampling noise, not edge.
    Vietlott returns roughly half of stakes as prizes, so any long enough backtest lands near −50% ROI or worse.</p>`;

  barChart(
    $('bt-dist'),
    r.distribution.map(([matches, count]) => ({
      label: matches,
      value: count,
      dim: matches < r.lowestTier,
      tip: `<b>${matches} match${matches === 1 ? '' : 'es'}</b> &middot; ${fmtInt(count)} tickets (${((count / r.tickets) * 100).toFixed(1)}%)${matches >= r.lowestTier ? ' — wins a prize' : ''}`,
    })),
    {
      height: 180,
      valueFormat: (v) => fmtInt(v),
      ariaLabel: 'how many tickets hit each number of matches',
    }
  );
  void distMax;
}

/* ------------------------------------------------------------------ *
 * keno tab
 * ------------------------------------------------------------------ */

const keno = {
  prizes: examplePrizes(DEFAULT_TICKET_PRICE),
  price: DEFAULT_TICKET_PRICE,
  draws: null,
  loading: null,
  levels: null,
  edited: false,
};

function loadKenoPrizes() {
  try {
    const raw = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}keno.prizes`));
    if (raw && raw.prizes) {
      keno.prizes = raw.prizes;
      keno.price = Number(raw.price) || DEFAULT_TICKET_PRICE;
      keno.edited = !!raw.edited;
      $('keno-price').value = keno.price;
    }
  } catch {
    /* keep the defaults */
  }
}

function saveKenoPrizes() {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}keno.prizes`,
      JSON.stringify({ prizes: keno.prizes, price: keno.price, edited: keno.edited })
    );
  } catch {
    /* non-fatal */
  }
}

/** The trimmed history is ~0.8 MB, so fetch it only when the tab is opened. */
async function kenoHistory() {
  if (keno.draws) return keno.draws;
  if (keno.loading) return keno.loading;
  keno.loading = (async () => {
    const res = await fetch(`./data/${KENO.file}`, { cache: 'force-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = [];
    for (const line of (await res.text()).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const r = JSON.parse(t);
        if (Array.isArray(r.result) && r.result.length === KENO.drawn) rows.push(r);
      } catch {
        /* skip */
      }
    }
    keno.draws = rows;
    return rows;
  })();
  // Do not leave a rejected promise cached, or every later attempt reuses the
  // same failure and the panel never recovers without a reload.
  keno.loading.catch(() => {
    keno.loading = null;
  });
  return keno.loading;
}

function kenoK() {
  return Math.max(1, Math.min(KENO.maxPick, Number($('keno-k').value) || 1));
}

/**
 * The headline. Once prizes are in play "best" splits in two: the level that
 * wins most often and the level that gives back the most are usually different,
 * and saying which is which is the whole point of the table above.
 */
function renderKenoVerdict(mostOften, bestValue) {
  if (!mostOften || !bestValue) {
    return `<p class="note warn">No level has any prize set. Fill in the prize table
      to get win chances and returns.</p>`;
  }
  const example = keno.edited
    ? ''
    : ` <strong>These use the example prize amounts, not Vietlott's</strong> — edit the
       prize table to get real figures.`;

  const same = mostOften.k === bestValue.k;
  const lead = same
    ? `<strong>Play ${mostOften.k}</strong> — it both wins most often
       (${(mostOften.pWin * 100).toFixed(2)}%, 1 in ${fmtOneIn(mostOften.oneIn)}) and
       returns the most (${(bestValue.ret * 100).toFixed(1)}% of stake).`
    : `<strong>Wins most often: play ${mostOften.k}</strong>
       (${(mostOften.pWin * 100).toFixed(2)}%, 1 in ${fmtOneIn(mostOften.oneIn)}), but it
       returns ${(mostOften.ret * 100).toFixed(1)}%.
       <strong>Best return: play ${bestValue.k}</strong>
       at ${(bestValue.ret * 100).toFixed(1)}%, winning only
       ${(bestValue.pWin * 100).toFixed(2)}% of the time.
       Frequent small wins and the best long-run value are different levels.`;

  const edge = 1 - bestValue.ret;
  return `<p class="note">${lead}${example}</p>
    <p class="note warn"><strong>Every level still loses.</strong> The best return here
    keeps ${(bestValue.ret * 100).toFixed(1)}% of your stake, so the house takes
    ${(edge * 100).toFixed(1)}% of everything staked at that level. Picking the best
    level slows the loss; it does not turn it into a gain. The swing column is the
    standard deviation of a single ticket — where it dwarfs the ticket price, results
    are dominated by rare large prizes, so a short run tells you nothing.</p>`;
}

/** Prize inputs for the selected level, highest match count first. */
function renderKenoPrizeInputs() {
  const k = kenoK();
  $('keno-prize-k').textContent = `for ${k} number${k === 1 ? '' : 's'}`;
  const table = keno.prizes[k] || {};
  const rows = [];
  for (let m = k; m >= 0; m--) {
    const p = hyperPmf(m, k);
    rows.push(`<label class="field prize-row">
      <span>${m} of ${k} <span class="hint">${(p * 100).toFixed(p < 0.01 ? 4 : 2)}%</span></span>
      <input type="number" class="keno-prize" data-m="${m}" min="0" step="1000"
             value="${Number(table[m]) || 0}">
    </label>`);
  }
  $('keno-prizes').innerHTML = rows.join('');
  $('keno-prizes').querySelectorAll('.keno-prize').forEach((input) => {
    input.addEventListener('change', () => {
      const kk = kenoK();
      keno.prizes[kk] = keno.prizes[kk] || {};
      keno.prizes[kk][Number(input.dataset.m)] = Math.max(0, Number(input.value) || 0);
      keno.edited = true;
      saveKenoPrizes();
      renderKeno();
    });
  });
}

function renderKeno() {
  const k = kenoK();
  keno.price = Math.max(0, Number($('keno-price').value) || 0);
  const seed = $('keno-seed').value.trim() || null;
  const rng = makeRng(seed);

  const levels = generateAllLevels(rng, keno.prizes, keno.price);
  keno.levels = levels;
  saveKenoPrizes();

  const playable = levels.filter((lv) => lv.hasPrizes);
  const mostOften = playable.reduce((a, b) => (b.pWin > a.pWin ? b : a), playable[0]);
  const bestValue = playable.reduce((a, b) => (b.ret > a.ret ? b : a), playable[0]);

  $('keno-levels').innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr>
      <th>Play</th><th>Numbers</th><th class="num">Pays on</th>
      <th class="num">P(win)</th><th class="num">1 in</th>
      <th class="num">Top prize</th><th class="num">EV/ticket</th>
      <th class="num">Return</th><th class="num">Swing</th>
    </tr></thead>
    <tbody>${levels
      .map((lv) => {
        const pays = lv.payable.length
          ? lv.payable.slice().sort((a, b) => a - b).join(', ')
          : '—';
        return `<tr${lv.k === k ? ' style="background:var(--surface-2)"' : ''}>
          <td class="mono">${lv.k}</td>
          <td><span class="ball-row">${ballsHtml(lv.numbers, { small: true })}</span></td>
          <td class="num">${pays}</td>
          <td class="num${lv === mostOften ? ' best' : ''}">${(lv.pWin * 100).toFixed(2)}%</td>
          <td class="num">${fmtOneIn(lv.oneIn)}</td>
          <td class="num">${lv.topPrize ? fmtVnd(lv.topPrize) : '—'}</td>
          <td class="num">${fmtVnd(lv.ev)}</td>
          <td class="num${lv === bestValue ? ' best' : ''}">${(lv.ret * 100).toFixed(1)}%</td>
          <td class="num">${fmtVnd(lv.sd)}</td>
        </tr>`;
      })
      .join('')}</tbody></table></div>
    ${renderKenoVerdict(mostOften, bestValue)}`;

  const rows = distribution(k);
  const pays = new Set(payableCounts(keno.prizes, k));
  const table = keno.prizes[k] || {};
  $('keno-dist-title').textContent = `Chance of each result when you play ${k}`;
  $('keno-dist-sub').textContent =
    `mean ${(k * KENO.drawn / KENO.max).toFixed(2)} matches · shaded bars count as a win`;
  const ev = evaluate(k, keno.prizes, keno.price);
  $('keno-dist-sub').textContent =
    `mean ${(k * KENO.drawn / KENO.max).toFixed(2)} matches · shaded bars pay · ` +
    `EV ${fmtVnd(ev.ev)} per ${fmtVnd(keno.price)} ticket`;

  barChart(
    $('keno-dist-chart'),
    rows.map((r) => ({
      label: r.m,
      value: r.p * 100,
      dim: !pays.has(r.m),
      tip: `<b>${r.m} of ${k}</b> &middot; ${(r.p * 100).toFixed(3)}%` +
        (r.p > 0 ? ` (1 in ${fmtOneIn(1 / r.p)})` : '') +
        (pays.has(r.m) ? ` &middot; pays ${fmtVnd(Number(table[r.m]) || 0)}` : ''),
    })),
    { height: 180, valueFormat: (v) => `${v.toFixed(0)}%`, ariaLabel: 'chance of each match count' }
  );

  $('keno-dist-table').innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr>
      <th>Matches</th><th class="num">Chance</th><th class="num">1 in</th>
      <th class="num">At least</th><th class="num">Pays</th><th class="num">Adds to EV</th>
    </tr></thead>
    <tbody>${rows
      .map((r) => {
        const prize = Number(table[r.m]) || 0;
        const paying = pays.has(r.m);
        return `<tr>
          <td class="mono">${r.m} of ${k}${paying ? ' ✓' : ''}</td>
          <td class="num">${(r.p * 100).toFixed(r.p < 0.001 ? 5 : 3)}%</td>
          <td class="num">${r.p > 0 ? fmtOneIn(1 / r.p) : '—'}</td>
          <td class="num">${(r.atLeast * 100).toFixed(r.atLeast < 0.001 ? 5 : 3)}%</td>
          <td class="num">${paying ? fmtVnd(prize) : '—'}</td>
          <td class="num">${paying ? fmtVnd(r.p * prize) : '—'}</td>
        </tr>`;
      })
      .join('')}
      <tr><td class="mono"><strong>Total</strong></td><td class="num"></td><td class="num"></td>
        <td class="num"></td><td class="num"></td>
        <td class="num best">${fmtVnd(ev.ev)}</td></tr>
    </tbody></table></div>
    <p class="muted" style="font-size:12px;margin-top:8px">
      The last column is each result's chance multiplied by what it pays. They add up
      to the expected value of one ticket: ${fmtVnd(ev.ev)} against a
      ${fmtVnd(keno.price)} stake, or ${(ev.ret * 100).toFixed(1)}% back.
    </p>`;

  renderKenoPrizeInputs();
  renderKenoHistory(levels.find((lv) => lv.k === k));
}

async function renderKenoHistory(level) {
  const box = $('keno-history');
  box.innerHTML = '<p class="muted"><span class="spinner"></span> loading recent draws…</p>';
  let draws;
  try {
    draws = await kenoHistory();
  } catch (e) {
    box.innerHTML = `<p class="muted">Could not load the Keno history (${e.message}).</p>`;
    return;
  }

  const s = scoreAgainstHistory(level.numbers, draws, keno.prizes, keno.price);
  const exp = winProbability(level.k, keno.prizes);
  const se = Math.sqrt((exp * (1 - exp)) / s.draws);
  const z = se > 0 ? (s.observedWinRate - exp) / se : 0;
  const pays = new Set(level.payable);

  $('keno-history-sub').textContent =
    `${fmtInt(s.draws)} draws · ${draws[0].date} → ${draws[draws.length - 1].date}`;

  box.innerHTML = `<div class="tiles">
      ${tile('Would have staked', fmtVnd(s.spent), `${fmtInt(s.draws)} tickets`)}
      ${tile('Would have won', fmtVnd(s.won), `${s.wins} winning draws`)}
      ${`<div class="tile"><div class="k">Net</div><div class="v ${s.profit >= 0 ? 'pos' : 'neg'}">${fmtVnd(s.profit)}</div><div class="s">returned ${(s.actualReturn * 100).toFixed(1)}% vs ${(level.ret * 100).toFixed(1)}% expected</div></div>`}
      ${tile('Win rate', `${(s.observedWinRate * 100).toFixed(2)}%`, `exact odds say ${(exp * 100).toFixed(2)}% (${z >= 0 ? '+' : ''}${z.toFixed(2)}σ)`)}
    </div>
    <div class="table-wrap" style="margin-top:12px"><table class="data">
      <thead><tr>
        <th>Matches</th><th class="num">Happened</th><th class="num">Expected</th>
        <th class="num">Observed</th><th class="num">Exact</th><th class="num">Paid out</th>
      </tr></thead>
      <tbody>${s.rows
        .map(
          (r) => `<tr>
            <td class="mono">${r.m}${pays.has(r.m) ? ' ✓' : ''}</td>
            <td class="num">${fmtInt(r.observed)}</td>
            <td class="num">${r.expected.toFixed(1)}</td>
            <td class="num">${(r.observedP * 100).toFixed(2)}%</td>
            <td class="num">${(r.expectedP * 100).toFixed(2)}%</td>
            <td class="num">${r.paid > 0 ? fmtVnd(r.paid) : '—'}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>
    <p class="note">Your ${level.k} numbers played against every one of these draws at
    ${fmtVnd(keno.price)} a ticket. The observed column tracking the exact column is the
    point: the maths above is not a model of Keno, it is Keno.
    ${s.profit >= 0
      ? 'This particular run came out ahead — over 5,000 draws that is luck, not an edge, and the swing column above says how much luck is available.'
      : 'Nothing about which numbers you chose would have changed it.'}</p>`;
}

/* ------------------------------------------------------------------ *
 * data tab
 * ------------------------------------------------------------------ */

function renderSourceNote() {
  const live = proxyKnownState();
  $('crawl-source-note').innerHTML = live
    ? `<strong>Live crawling is on.</strong> The local proxy is relaying requests to vietlott.vn's
       result endpoint — the same one the upstream Python crawler uses.`
    : `<strong>No local proxy.</strong> The browser cannot call vietlott.vn directly (it sends no CORS headers),
       so this app syncs from the upstream repo's JSONL, which its maintainer re-crawls daily.
       Start <span class="mono">python3 server.py</span> and reload to crawl vietlott.vn live.`;
}

function renderDataTab() {
  const p = product();
  const rows = state.draws;
  $('data-tiles').innerHTML = [
    tile('Draws stored', fmtInt(rows.length), p.label),
    tile('Latest draw', rows.length ? rows[rows.length - 1].date : '—', rows.length ? `#${rows[rows.length - 1].id}` : '', true),
    tile('Last sync', fmtRelative(state.meta.lastSync), state.meta.lastSource ? `via ${state.meta.lastSource}` : ''),
    tile('Source', proxyKnownState() ? 'vietlott.vn (live)' : 'GitHub / snapshot', proxyKnownState() ? 'through local proxy' : 'no proxy running'),
  ].join('');

  $('data-range').textContent = rows.length ? `${rows[0].date} → ${rows[rows.length - 1].date}` : '';
  const recent = rows.slice(-25).reverse();
  $('data-table').innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>Date</th><th>Draw</th><th>Result</th><th>Crawled</th></tr></thead>
    <tbody>${recent
      .map(
        (d) => `<tr><td>${d.date}</td><td class="mono">${d.id}</td><td>${drawBalls(d)}</td>
          <td class="muted">${(d.process_time || '').slice(0, 16).replace('T', ' ')}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
}

function exportJsonl() {
  const blob = new Blob([toJsonl(state.draws)], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = product().file;
  a.click();
  URL.revokeObjectURL(a.href);
  log(`exported ${state.draws.length} draws to ${product().file}`);
}

/* ------------------------------------------------------------------ *
 * render + wiring
 * ------------------------------------------------------------------ */

function renderAll() {
  renderRecentInGenerate();
  renderStats();
  renderDataTab();
}

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];

  function show(tab, { push = true } = {}) {
    tabs.forEach((o) => {
      o.setAttribute('aria-selected', String(o === tab));
      $(o.getAttribute('aria-controls')).classList.toggle('active', o === tab);
    });
    // The product selector drives every tab except Keno, which is its own game.
    const kenoTab = tab.id === 'tab-keno';
    $('product').style.display = kenoTab ? 'none' : '';
    $('data-status').style.display = kenoTab ? 'none' : '';
    if (tab.id === 'tab-stats') renderStats();
    if (tab.id === 'tab-keno' && !keno.levels) renderKeno();
    const name = tab.id.replace('tab-', '');
    if (push && location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  }

  tabs.forEach((t) => t.addEventListener('click', () => show(t)));

  const fromHash = () => {
    const wanted = $(`tab-${location.hash.slice(1)}`);
    if (wanted && tabs.includes(wanted)) show(wanted, { push: false });
  };
  window.addEventListener('hashchange', fromHash);
  fromHash();
}

function initTheme() {
  const saved = localStorage.getItem(`${STORAGE_PREFIX}theme`);
  if (saved) document.documentElement.dataset.theme = saved;
  $('theme-toggle').addEventListener('click', () => {
    const current =
      document.documentElement.dataset.theme ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(`${STORAGE_PREFIX}theme`, next);
    renderStats();
  });
}

function initProducts() {
  $('product').innerHTML = Object.values(PRODUCTS)
    .map((p) => `<option value="${p.key}"${p.key === state.productKey ? ' selected' : ''}>${p.label}</option>`)
    .join('');
  $('product').addEventListener('change', async (e) => {
    state.productKey = e.target.value;
    localStorage.setItem(`${STORAGE_PREFIX}product`, state.productKey);
    renderPrizeInputs();
    $('gen-output').innerHTML = '<p class="muted">Pick a strategy and hit generate.</p>';
    $('gen-note').hidden = true;
    await loadInitial();
  });
}

function initStrategySelects() {
  const options = STRATEGIES.map((S) => `<option value="${S.key}">${S.label}</option>`).join('');
  $('gen-strategy').innerHTML = options;
  $('bt-strategy').innerHTML = `<option value="__all__">Compare all strategies</option>${options}`;

  // Hidden host so single-strategy backtests can reuse a strategy's own params.
  const host = document.createElement('div');
  host.id = 'bt-params-host';
  host.hidden = true;
  $('panel-backtest').append(host);

  const syncGen = () => {
    const S = STRATEGY_BY_KEY[$('gen-strategy').value];
    $('gen-blurb').textContent = S.blurb;
    renderParamInputs($('gen-params'), S, 'gp');
  };
  $('gen-strategy').addEventListener('change', syncGen);
  syncGen();

  const syncBt = () => {
    const key = $('bt-strategy').value;
    if (key === '__all__') {
      host.innerHTML = '';
      return;
    }
    renderParamInputs(host, STRATEGY_BY_KEY[key], 'bp');
    host.hidden = false;
    host.style.marginTop = '12px';
  };
  $('bt-strategy').addEventListener('change', syncBt);
  syncBt();
}

function initEvents() {
  $('gen-run').addEventListener('click', generate);
  $('gen-copy').addEventListener('click', async () => {
    if (!state.lastTickets?.length) return;
    const text = state.lastTickets.map((t) => t.map(pad2).join(' ')).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      $('gen-copy').textContent = 'Copied';
      setTimeout(() => ($('gen-copy').textContent = 'Copy'), 1400);
    } catch {
      $('gen-copy').textContent = 'Copy failed';
      setTimeout(() => ($('gen-copy').textContent = 'Copy'), 1400);
    }
  });

  ['stats-metric', 'stats-bonus', 'stats-window', 'stats-window-n'].forEach((id) =>
    $(id).addEventListener('change', renderStats)
  );
  $('stats-window').addEventListener('change', () => {
    $('stats-window-n').disabled = !$('stats-window').checked;
  });

  $('bt-run').addEventListener('click', runBacktestUI);

  $('keno-k').addEventListener('input', () => {
    $('keno-k').parentElement.querySelector('output').textContent = $('keno-k').value;
  });
  $('keno-k').addEventListener('change', renderKeno);
  $('keno-price').addEventListener('change', renderKeno);
  $('keno-run').addEventListener('click', renderKeno);
  $('keno-prize-reset').addEventListener('click', () => {
    keno.prizes = examplePrizes(keno.price || DEFAULT_TICKET_PRICE);
    keno.edited = false;
    saveKenoPrizes();
    renderKeno();
  });
  $('keno-prize-clear').addEventListener('click', () => {
    const k = kenoK();
    keno.prizes[k] = {};
    keno.edited = true;
    saveKenoPrizes();
    renderKeno();
  });
  $('keno-copy').addEventListener('click', async () => {
    if (!keno.levels) return;
    const text = keno.levels
      .map((lv) => `${String(lv.k).padStart(2)}: ${lv.numbers.map(pad2).join(' ')}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      $('keno-copy').textContent = 'Copied';
    } catch {
      $('keno-copy').textContent = 'Copy failed';
    }
    setTimeout(() => ($('keno-copy').textContent = 'Copy'), 1400);
  });

  $('crawl-now').addEventListener('click', () => crawl({}));
  $('crawl-backfill').addEventListener('click', () => {
    log('deep backfill: walking up to 40 result pages…');
    crawl({ pages: 40 });
  });
  $('crawl-github').addEventListener('click', () => crawl({ preferGithub: true }));
  $('crawl-auto').addEventListener('change', scheduleAuto);
  $('crawl-interval').addEventListener('change', scheduleAuto);
  $('data-export').addEventListener('click', exportJsonl);
  $('data-clear').addEventListener('click', async () => {
    if (!confirm('Clear the locally cached draw history for all products?')) return;
    clearCache();
    log('local cache cleared — reloading from the bundled snapshot');
    await loadInitial();
  });
}

async function main() {
  initTheme();
  initTabs();
  initProducts();
  initStrategySelects();
  loadKenoPrizes();
  renderKenoPrizeInputs();
  renderPrizeInputs();
  initEvents();

  if (localStorage.getItem(`${STORAGE_PREFIX}auto`) === '1') {
    $('crawl-auto').checked = true;
    $('crawl-interval').value = localStorage.getItem(`${STORAGE_PREFIX}interval`) || '30';
  }

  await loadInitial();
  scheduleAuto();
}

main();
