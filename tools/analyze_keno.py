#!/usr/bin/env python3
"""
Test the Keno draw history for structure a prediction strategy could exploit.

    python3 tools/analyze_keno.py [--data data/keno.jsonl] [--recent N]

Every test compares the observed data against what a fair draw of 20 numbers
from 1-80 would produce, and prints a verdict. Standard library only, except
that numpy is used for the pair matrix when available.

Reference distributions
-----------------------
Per draw, 20 of 80 balls are taken without replacement, so:
  * each number appears with p = 20/80 = 0.25
  * the count of evens (or of low numbers) is Hypergeometric(80, 40, 20),
    mean 10, sd 1.949
  * the overlap between two independent draws is Hypergeometric(80, 20, 20),
    mean 5, sd 1.688
  * the sum of the 20 numbers has mean 810, sd 90.0
  * the expected count of adjacent pairs (i, i+1) is 4.75
"""

import argparse
import json
import math
import random
from collections import Counter
from pathlib import Path

N_BALLS = 80
DRAWN = 20
P_HIT = DRAWN / N_BALLS

try:
    import numpy as np
except ImportError:  # pragma: no cover - numpy is optional
    np = None


# ----------------------------------------------------------------- helpers

def hyper_pmf(k, N, K, n):
    """P(X = k) for X ~ Hypergeometric(N population, K successes, n draws)."""
    if k < max(0, n - (N - K)) or k > min(K, n):
        return 0.0
    return math.comb(K, k) * math.comb(N - K, n - k) / math.comb(N, n)


def hyper_stats(N, K, n):
    mean = n * K / N
    var = n * (K / N) * (1 - K / N) * (N - n) / (N - 1)
    return mean, math.sqrt(var)


def chi_square_p(chi2, df):
    """Upper-tail p-value, via the regularised incomplete gamma Q(df/2, x/2)."""
    return _gamma_q(df / 2.0, chi2 / 2.0)


def _gamma_q(s, x):
    if x < 0 or s <= 0:
        return float("nan")
    if x == 0:
        return 1.0
    if x < s + 1.0:
        # series for P(s, x), then Q = 1 - P
        term = 1.0 / s
        total = term
        n = 1
        while n < 10000:
            term *= x / (s + n)
            total += term
            if abs(term) < abs(total) * 1e-14:
                break
            n += 1
        return 1.0 - total * math.exp(-x + s * math.log(x) - math.lgamma(s))
    # continued fraction for Q(s, x)
    tiny = 1e-300
    b = x + 1.0 - s
    c = 1.0 / tiny
    d = 1.0 / b
    h = d
    for i in range(1, 10000):
        an = -i * (i - s)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-14:
            break
    return h * math.exp(-x + s * math.log(x) - math.lgamma(s))


def norm_sf(x):
    """P(Z > x) for a standard normal."""
    return 0.5 * math.erfc(x / math.sqrt(2))


def family_p(max_abs_z, m):
    """Chance that the most extreme of m standard normals is this extreme."""
    per = 2 * norm_sf(abs(max_abs_z))
    return 1.0 - (1.0 - per) ** m


def uniformity_test(counts, n, buckets=N_BALLS, p_hit=P_HIT):
    """
    Sum of squared z-scores for per-number appearance counts.

    The textbook sum((O-E)^2/E) is WRONG here: within a draw the 80 indicators
    are not independent (exactly 20 are set), so each count has variance
    n*p*(1-p), not n*p, and the naive statistic is deflated by a factor (1-p).
    Standardising by the true variance gives

        T = sum z_i^2,   z_i = (O_i - n*p) / sqrt(n*p*(1-p))

    whose covariance matrix has eigenvalue 0 once (the total is fixed) and
    B/(B-1) with multiplicity B-1, so T*(B-1)/B ~ chi2_{B-1}.

    Returns (T, p_value, z_scores).
    """
    exp = n * p_hit
    sd = math.sqrt(n * p_hit * (1 - p_hit))
    z = {i: (counts[i] - exp) / sd for i in range(1, buckets + 1)}
    T = sum(v * v for v in z.values())
    p = chi_square_p(T * (buckets - 1) / buckets, buckets - 1)
    return T, p, z


def verdict(p):
    if p != p:  # nan
        return "?"
    if p < 0.001:
        return "SIGNIFICANT (p < 0.001)"
    if p < 0.01:
        return "significant (p < 0.01)"
    if p < 0.05:
        return "marginal (p < 0.05)"
    return "consistent with chance"


def z_verdict(z):
    a = abs(z)
    if a > 3.3:
        return "SIGNIFICANT"
    if a > 2.6:
        return "significant"
    if a > 2.0:
        return "marginal"
    return "consistent with chance"


def head(title):
    print(f"\n{title}\n{'-' * len(title)}")


# ----------------------------------------------------------------- loading

def load(path, recent=None):
    draws = []
    with Path(path).open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if len(row.get("result", [])) == DRAWN:
                draws.append(row)
    draws.sort(key=lambda r: (r["date"], r["id"]))
    if recent:
        draws = draws[-recent:]
    return draws


# ------------------------------------------------------------------- tests

def test_coverage(draws):
    head("0. What the data actually covers")
    import datetime as _dt
    days = sorted({d["date"] for d in draws})
    per_year = Counter(d["date"][:4] for d in draws)
    days_year = {}
    for d in draws:
        days_year.setdefault(d["date"][:4], set()).add(d["date"])
    for year in sorted(per_year):
        print(f"  {year}: {per_year[year]:>6} draws on {len(days_year[year]):>3} days")

    first, last = _dt.date.fromisoformat(days[0]), _dt.date.fromisoformat(days[-1])
    span = (last - first).days + 1
    print(f"  span {days[0]} -> {days[-1]} = {span} calendar days, "
          f"{len(days)} with data ({len(days) / span:.0%} coverage)")

    parsed = [_dt.date.fromisoformat(x) for x in days]
    gaps = [((parsed[i + 1] - parsed[i]).days - 1, days[i], days[i + 1])
            for i in range(len(parsed) - 1) if (parsed[i + 1] - parsed[i]).days > 1]
    gaps.sort(reverse=True)
    if gaps:
        print(f"  {len(gaps)} gaps in the record; largest:")
        for g, a, b in gaps[:3]:
            print(f"    {g} days missing between {a} and {b}")
        print("  Anything indexed by calendar time is unreliable across those gaps;")
        print("  prefer counting in draws rather than in days.")


def test_uniformity(draws):
    head("1. Is every number equally likely?")
    counts = Counter()
    for d in draws:
        counts.update(d["result"])
    n = len(draws)
    expected = n * DRAWN / N_BALLS
    sd = math.sqrt(n * P_HIT * (1 - P_HIT))
    T, p, z = uniformity_test(counts, n)
    ranked = sorted(counts.items(), key=lambda kv: -kv[1])
    print(f"  draws {n}, expected {expected:.1f} appearances per number (sd {sd:.1f})")
    print(f"  sum of squared z = {T:.1f} (expected {N_BALLS:.0f})  ->  p = {p:.4f}   {verdict(p)}")
    top = ", ".join(f"{k} ({v}, {z[k]:+.1f}sd)" for k, v in ranked[:5])
    bot = ", ".join(f"{k} ({v}, {z[k]:+.1f}sd)" for k, v in ranked[-5:])
    print(f"  most drawn  : {top}")
    print(f"  least drawn : {bot}")
    worst = max(abs(v) for v in z.values())
    fp = family_p(worst, N_BALLS)
    print(f"  biggest deviation {worst:.2f}sd — across {N_BALLS} numbers the chance of "
          f"seeing one at least that extreme is {fp:.2f}   {verdict(fp)}")
    return counts


def test_drift(draws):
    head("2. Does any number's rate drift over time?")
    by_year = {}
    for d in draws:
        by_year.setdefault(d["date"][:4], []).append(d)
    for year, rows in sorted(by_year.items()):
        if len(rows) < 500:
            print(f"  {year}: {len(rows)} draws — too few, skipped")
            continue
        counts = Counter()
        for d in rows:
            counts.update(d["result"])
        T, p, _ = uniformity_test(counts, len(rows))
        print(f"  {year}: {len(rows):>6} draws  sum z^2 = {T:6.1f} (expect {N_BALLS})  "
              f"p = {p:.4f}   {verdict(p)}")


def test_persistence(draws):
    head("3. Do hot numbers stay hot? (the premise of every frequency strategy)")
    half = len(draws) // 2
    c1, c2 = Counter(), Counter()
    for d in draws[:half]:
        c1.update(d["result"])
    for d in draws[half:]:
        c2.update(d["result"])
    xs = [c1[i] for i in range(1, N_BALLS + 1)]
    ys = [c2[i] for i in range(1, N_BALLS + 1)]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    den = math.sqrt(sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys))
    r = num / den if den else float("nan")
    # Under independence r ~ N(0, 1/sqrt(n-1))
    z = r * math.sqrt(len(xs) - 1)
    print(f"  first half {half} draws vs second half {len(draws) - half}")
    print(f"  correlation of per-number counts r = {r:+.4f}  (z = {z:+.2f})   {z_verdict(z)}")
    print("  a frequency strategy only works if this is clearly positive")

    # Does being hot in the first half predict being in the top half later?
    top_first = {k for k, _ in sorted(c1.items(), key=lambda kv: -kv[1])[:20]}
    top_second = {k for k, _ in sorted(c2.items(), key=lambda kv: -kv[1])[:20]}
    overlap = len(top_first & top_second)
    mean, sd = hyper_stats(N_BALLS, 20, 20)
    z2 = (overlap - mean) / sd
    print(f"  top-20 hottest numbers shared between halves: {overlap} "
          f"(chance gives {mean:.1f} +/- {sd:.1f}, z = {z2:+.2f})   {z_verdict(z2)}")


def test_autocorrelation(draws):
    head("4. Does one draw predict the next?")
    hits = repeats = 0
    overlaps = Counter()
    for a, b in zip(draws, draws[1:]):
        sa, sb = set(a["result"]), set(b["result"])
        ov = len(sa & sb)
        overlaps[ov] += 1
        repeats += ov
        hits += DRAWN
    n_pairs = len(draws) - 1
    mean, sd = hyper_stats(N_BALLS, DRAWN, DRAWN)
    obs_mean = repeats / n_pairs
    z = (obs_mean - mean) / (sd / math.sqrt(n_pairs))
    print(f"  consecutive-draw pairs: {n_pairs}")
    print(f"  mean overlap {obs_mean:.4f} vs {mean:.4f} expected  (z = {z:+.2f})   {z_verdict(z)}")
    p_repeat = repeats / hits
    print(f"  P(number repeats in the next draw) = {p_repeat:.4f}, base rate {P_HIT:.4f}")
    print("  a 'not repeat' strategy needs this clearly BELOW the base rate")

    chi2 = 0.0
    used = 0
    for k in range(0, DRAWN + 1):
        exp = n_pairs * hyper_pmf(k, N_BALLS, DRAWN, DRAWN)
        if exp >= 5:
            chi2 += (overlaps[k] - exp) ** 2 / exp
            used += 1
    p = chi_square_p(chi2, used - 1)
    print(f"  overlap distribution chi-square {chi2:.1f} on {used - 1} df  ->  p = {p:.4f}   {verdict(p)}")


def test_gaps(draws):
    head("5. Are overdue numbers really due?")
    last_seen = {}
    gap_hit = Counter()
    gap_total = Counter()
    for i, d in enumerate(draws):
        present = set(d["result"])
        for num in range(1, N_BALLS + 1):
            if num in last_seen:
                gap = i - last_seen[num]
                bucket = min(gap, 15)
                gap_total[bucket] += 1
                if num in present:
                    gap_hit[bucket] += 1
        for num in present:
            last_seen[num] = i

    print("  gap = draws since the number last appeared")
    print("  gap   chances      hits      rate     vs 0.2500")
    for bucket in range(1, 16):
        tot = gap_total[bucket]
        if tot < 500:
            continue
        rate = gap_hit[bucket] / tot
        se = math.sqrt(P_HIT * (1 - P_HIT) / tot)
        z = (rate - P_HIT) / se
        label = f"{bucket:>3}" if bucket < 15 else "15+"
        print(f"  {label}   {tot:>9}  {gap_hit[bucket]:>8}   {rate:.4f}   z = {z:+5.2f}  {z_verdict(z)}")
    print("  a 'long absence' strategy needs the rate to RISE with the gap")


def test_shape(draws):
    head("6. Do draws have a predictable shape? (odd/even, low/high, sum, runs)")
    even_counts, low_counts, sums, runs = Counter(), Counter(), [], []
    for d in draws:
        nums = d["result"]
        even_counts[sum(1 for x in nums if x % 2 == 0)] += 1
        low_counts[sum(1 for x in nums if x <= 40)] += 1
        sums.append(sum(nums))
        runs.append(sum(1 for a, b in zip(nums, nums[1:]) if b - a == 1))

    n = len(draws)
    for name, counts in (("evens per draw", even_counts), ("low (1-40) per draw", low_counts)):
        mean, sd = hyper_stats(N_BALLS, 40, DRAWN)
        obs = sum(k * v for k, v in counts.items()) / n
        z = (obs - mean) / (sd / math.sqrt(n))
        chi2 = 0.0
        used = 0
        for k in range(0, DRAWN + 1):
            exp = n * hyper_pmf(k, N_BALLS, 40, DRAWN)
            if exp >= 5:
                chi2 += (counts[k] - exp) ** 2 / exp
                used += 1
        p = chi_square_p(chi2, used - 1)
        print(f"  {name}: mean {obs:.4f} vs {mean:.4f} (z = {z:+.2f}), "
              f"shape chi-square p = {p:.4f}   {verdict(p)}")

    mean_sum = DRAWN * (N_BALLS + 1) / 2
    var_sum = DRAWN * (N_BALLS ** 2 - 1) / 12 * (N_BALLS - DRAWN) / (N_BALLS - 1)
    sd_sum = math.sqrt(var_sum)
    obs_mean = sum(sums) / n
    obs_sd = math.sqrt(sum((s - obs_mean) ** 2 for s in sums) / (n - 1))
    z = (obs_mean - mean_sum) / (sd_sum / math.sqrt(n))
    print(f"  draw sum: mean {obs_mean:.1f} vs {mean_sum:.1f} (z = {z:+.2f}), "
          f"sd {obs_sd:.1f} vs {sd_sum:.1f}   {z_verdict(z)}")

    exp_runs = (N_BALLS - 1) * (DRAWN * (DRAWN - 1)) / (N_BALLS * (N_BALLS - 1))
    obs_runs = sum(runs) / n
    sd_runs = math.sqrt(sum((r - obs_runs) ** 2 for r in runs) / (n - 1))
    z = (obs_runs - exp_runs) / (sd_runs / math.sqrt(n))
    print(f"  adjacent pairs (i, i+1): mean {obs_runs:.4f} vs {exp_runs:.4f} expected "
          f"(z = {z:+.2f})   {z_verdict(z)}")


def test_pairs(draws):
    head("7. Do certain numbers travel together?")
    n = len(draws)
    p_pair = (DRAWN * (DRAWN - 1)) / (N_BALLS * (N_BALLS - 1))
    expected = n * p_pair
    sd = math.sqrt(expected * (1 - p_pair))

    if np is not None:
        mat = np.zeros((N_BALLS + 1, N_BALLS + 1), dtype=np.int32)
        for d in draws:
            idx = np.array(d["result"])
            mat[np.ix_(idx, idx)] += 1
        iu = np.triu_indices(N_BALLS + 1, k=1)
        vals = mat[iu][np.array(iu[0])[np.newaxis, :][0] >= 1]
        pairs = [((a, b), int(mat[a, b])) for a, b in zip(*iu) if a >= 1]
    else:
        counter = Counter()
        for d in draws:
            nums = d["result"]
            for i in range(len(nums)):
                for j in range(i + 1, len(nums)):
                    counter[(nums[i], nums[j])] += 1
        pairs = list(counter.items())

    values = [v for _, v in pairs]
    zs = [(v - expected) / sd for v in values]
    m = len(zs)
    mean_z = sum(zs) / m
    sd_z = math.sqrt(sum((x - mean_z) ** 2 for x in zs) / (m - 1))
    worst = max(abs(x) for x in zs)
    ranked = sorted(pairs, key=lambda kv: -kv[1])
    print(f"  {m} pairs, expected {expected:.1f} co-appearances each (sd {sd:.1f})")
    print(f"  z-scores: mean {mean_z:+.3f} (expect 0), sd {sd_z:.3f} (expect ~1), "
          f"largest |z| {worst:.2f}")
    print("  strongest : " + ", ".join(f"{a}-{b} ({v}, {(v - expected) / sd:+.1f}sd)" for (a, b), v in ranked[:4]))
    print("  weakest   : " + ", ".join(f"{a}-{b} ({v}, {(v - expected) / sd:+.1f}sd)" for (a, b), v in ranked[-4:]))
    beyond3 = sum(1 for x in zs if abs(x) > 3)
    print(f"  pairs beyond 3sd: {beyond3} (chance gives about {m * 0.0027:.0f})")
    print(f"  most extreme pair, corrected for {m} comparisons: p = {family_p(worst, m):.2f}   "
          f"{verdict(family_p(worst, m))}")
    print("  (pair counts are mildly dependent, so read the spread, not a single p)")


def test_side_bets(draws):
    head("8. The side bets recorded in the data (Chan/Le and Lon/Nho)")
    odd_even = Counter()
    big_small = Counter()
    for d in draws:
        nums = d["result"]
        evens = sum(1 for x in nums if x % 2 == 0)
        lows = sum(1 for x in nums if x <= 40)
        odd_even["tie" if evens == 10 else ("even" if evens > 10 else "odd")] += 1
        big_small["tie" if lows == 10 else ("small" if lows > 10 else "big")] += 1

    n = len(draws)
    p_tie = hyper_pmf(10, N_BALLS, 40, DRAWN)
    p_side = (1 - p_tie) / 2
    for name, counts, labels in (("odd / even", odd_even, ("odd", "even")),
                                 ("big / small", big_small, ("big", "small"))):
        print(f"  {name}:")
        for key, exp_p in ((labels[0], p_side), (labels[1], p_side), ("tie", p_tie)):
            obs = counts[key]
            exp = n * exp_p
            z = (obs - exp) / math.sqrt(n * exp_p * (1 - exp_p))
            print(f"    {key:<6} {obs:>7} ({obs / n:.4f})   expected {exp_p:.4f}   "
                  f"z = {z:+5.2f}  {z_verdict(z)}")


def test_pick_odds(paytable=None):
    head("9. What picking k numbers actually gets you (exact, not empirical)")
    print("  P(matching m of your k picks), from the hypergeometric distribution.")
    print("  Fixed by the rules — no selection strategy moves a single one of these.\n")
    print(f"  {'k':>2} | {'P(0 hits)':>9} | {'P(all k)':>12} | {'1 in':>12} | {'mean hits':>9}")
    print("  " + "-" * 56)
    for k in range(1, 11):
        p_all = hyper_pmf(k, N_BALLS, DRAWN, k)
        p_none = hyper_pmf(0, N_BALLS, DRAWN, k)
        print(f"  {k:>2} | {p_none:9.5f} | {p_all:12.3e} | {1 / p_all:12,.0f} | {k * P_HIT:9.2f}")

    if not paytable:
        print("\n  Pass --paytable FILE to turn these into expected value and house edge.")
        print('  Format: {"ticket_price": 10000, "tiers": {"4": {"4": 500000, "3": 20000}}}')
        return

    head("9b. Expected value under the supplied paytable")
    price = paytable.get("ticket_price", 1)
    tiers = paytable.get("tiers", {})
    print(f"  ticket price {price:,}\n")
    print(f"  {'k':>2} | {'EV/ticket':>12} | {'return':>7} | {'house edge':>10} | "
          f"{'sd':>12} | {'P(any prize)':>12}")
    print("  " + "-" * 74)
    rows = []
    for k_str in sorted(tiers, key=int):
        k = int(k_str)
        table = {int(m): float(v) for m, v in tiers[k_str].items()}
        ev = sd2 = p_win = 0.0
        for m in range(0, k + 1):
            pm = hyper_pmf(m, N_BALLS, DRAWN, k)
            prize = table.get(m, 0.0)
            ev += pm * prize
            if prize > 0:
                p_win += pm
        for m in range(0, k + 1):
            pm = hyper_pmf(m, N_BALLS, DRAWN, k)
            sd2 += pm * (table.get(m, 0.0) - ev) ** 2
        ret = ev / price if price else float("nan")
        rows.append((k, ev, ret, 1 - ret, math.sqrt(sd2), p_win))
        print(f"  {k:>2} | {ev:12,.0f} | {ret:6.2%} | {1 - ret:9.2%} | "
              f"{math.sqrt(sd2):12,.0f} | {p_win:11.2%}")
    if rows:
        best = min(rows, key=lambda r: r[3])
        print(f"\n  lowest house edge: k = {best[0]} at {best[3]:.2%}")
        print("  Every k loses money. This only says which loses slowest, and")
        print("  the sd column says how wildly the result swings while it does.")


def test_shuffle_control(draws, trials=5):
    head("10. Control: the same tests on shuffled data")
    print("  Rebuilding draws at random and re-running the uniformity test, so you")
    print("  can see what 'no structure at all' looks like on this sample size.\n")
    rng = random.Random(2026)
    n = len(draws)
    for t in range(trials):
        counts = Counter()
        for _ in range(n):
            counts.update(rng.sample(range(1, N_BALLS + 1), DRAWN))
        T, p, _ = uniformity_test(counts, n)
        print(f"  shuffle {t + 1}: sum z^2 = {T:6.1f}  p = {p:.4f}")
    print("\n  These p-values should look uniform on [0, 1]. If the real data's")
    print("  p-value sits inside this spread, the draws behave like these shuffles.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default="data/keno.jsonl")
    ap.add_argument("--recent", type=int, default=None,
                    help="only use the most recent N draws")
    ap.add_argument("--skip-shuffle", action="store_true")
    ap.add_argument("--paytable", help="JSON prize table, to compute EV and house edge")
    args = ap.parse_args()

    paytable = None
    if args.paytable:
        paytable = json.loads(Path(args.paytable).read_text(encoding="utf-8"))

    draws = load(args.data, args.recent)
    print(f"Keno analysis: {len(draws)} draws, {draws[0]['date']} to {draws[-1]['date']}")
    print(f"Each draw takes {DRAWN} of {N_BALLS} numbers, so every number has p = {P_HIT}")

    test_coverage(draws)
    test_uniformity(draws)
    test_drift(draws)
    test_persistence(draws)
    test_autocorrelation(draws)
    test_gaps(draws)
    test_shape(draws)
    test_pairs(draws)
    test_side_bets(draws)
    test_pick_odds(paytable)
    if not args.skip_shuffle:
        test_shuffle_control(draws)


if __name__ == "__main__":
    main()
