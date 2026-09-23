/**
 * Backtest harness - the JS equivalent of PredictModel.backtest / evaluate /
 * revenue in src/machine_learning/strategies/base.py.
 *
 * For every draw in the window the strategy generates `ticketsPerDraw` tickets
 * using only prior draws, each ticket is scored against the actual result, and
 * the match distribution is priced with the product's prize table.
 */

import { Context, STRATEGY_BY_KEY } from './strategies.js';
import { makeRng } from './rng.js';

export function runBacktest({
  draws,
  product,
  strategyKey,
  params = {},
  ticketsPerDraw = 1,
  fromDate = null,
  toDate = null,
  useBonus = false,
  seed = null,
  prizes = null,
  ticketPrice = null,
}) {
  const Strat = STRATEGY_BY_KEY[strategyKey];
  if (!Strat) throw new Error(`unknown strategy: ${strategyKey}`);

  const rng = makeRng(seed);
  const ctx = new Context({ draws, product, useBonus, rng });
  const strategy = new Strat(ctx, params);

  const priceTable = prizes || product.prizes;
  const price = ticketPrice ?? product.ticketPrice;

  const target = ctx.draws.filter(
    (d) => (!fromDate || d.date >= fromDate) && (!toDate || d.date <= toDate)
  );

  const distribution = new Map();
  let tickets = 0;
  let totalMatches = 0;
  let jackpots = 0;
  let gain = 0;
  const perDraw = [];

  const lowestTier = Math.min(...Object.keys(priceTable).map(Number));

  for (const d of target) {
    const actual = new Set(useBonus ? d.result : d.main);
    const row = { date: d.date, id: d.id, actual: [...actual], tickets: [] };
    for (let i = 0; i < ticketsPerDraw; i++) {
      const ticket = strategy.predict(d.t);
      let matches = 0;
      for (const n of ticket) if (actual.has(n)) matches++;
      distribution.set(matches, (distribution.get(matches) || 0) + 1);
      tickets++;
      totalMatches += matches;
      if (matches === product.pick) jackpots++;
      gain += Number(priceTable[matches] || 0);
      row.tickets.push({ ticket, matches });
    }
    perDraw.push(row);
  }

  const cost = tickets * price;
  const prizeWins = [...distribution.entries()]
    .filter(([m]) => m >= lowestTier)
    .reduce((a, [, c]) => a + c, 0);

  return {
    strategyKey,
    label: Strat.label,
    params: strategy.params,
    drawsEvaluated: target.length,
    tickets,
    avgMatches: tickets ? totalMatches / tickets : 0,
    distribution: [...distribution.entries()].sort((a, b) => a[0] - b[0]),
    jackpots,
    jackpotRate: tickets ? (jackpots / tickets) * 100 : 0,
    prizeWins,
    prizeRate: tickets ? (prizeWins / tickets) * 100 : 0,
    cost,
    gain,
    profit: gain - cost,
    roi: cost ? ((gain - cost) / cost) * 100 : 0,
    lowestTier,
    perDraw,
  };
}

/** Expected matches per ticket under uniform random play, as the fair baseline. */
export function expectedRandomMatches(product) {
  // Hypergeometric mean: pick * (pick / pool)
  const pool = product.max - product.min + 1;
  return (product.pick * product.pick) / pool;
}
