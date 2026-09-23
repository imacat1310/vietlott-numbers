#!/usr/bin/env python3
"""
Crawl Vietlott Keno results into a JSONL file.

Standard library only. Output matches the schema used by
vietvudanh/vietlott-data's data/keno.jsonl, one draw per line:

    {"date": "2026-09-23", "id": "#0296761",
     "result": [6, 7, 9, ...],            # 20 numbers, 1-80, ascending
     "big_small": "Chẵn (11)", "odd_even": "Lớn (13)"}

Usage
-----
    python3 tools/crawl_keno.py --pages 200
    python3 tools/crawl_keno.py --pages 50 --start 200     # resume deeper
    python3 tools/crawl_keno.py --pages 20 --full          # don't stop early

The endpoint returns 6 draws per page, newest first, so page N holds draws
[newest - 6N - 5 .. newest - 6N]. Keno draws roughly every 10 minutes, about
96 per day, so one day is ~16 pages.

The site is slow and rate-limits bursts, so requests are paced and retried.
By default the crawl stops once it reaches draws already in the output file;
pass --full to keep going regardless.
"""

import argparse
import json
import random
import re
import sys
import time
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

URL = (
    "https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts."
    "GameKenoCompareWebPart,Vietlott.PlugIn.WebParts.ashx"
)

ORENDER_INFO = {
    "ExtraParam1": "", "ExtraParam2": "", "ExtraParam3": "",
    "FullPageAlias": None, "IsPageDesign": False, "OrgPageAlias": None,
    "PageAlias": None, "RefKey": None, "SiteAlias": "main.vi",
    "SiteId": "main.frontend.vi", "SiteLang": "vi", "SiteName": "Vietlott",
    "SiteURL": "", "System": 1, "UserSessionId": "", "WebPage": None,
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) "
                  "Gecko/20100101 Firefox/128.0",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.5",
    "Content-Type": "text/plain; charset=utf-8",
    "X-AjaxPro-Method": "ServerSideDrawResult",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://vietlott.vn",
    "Referer": "https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/winning-number-keno",
}

# TotalRow drives a server-side count query. The 112453 the upstream crawler
# sends makes the endpoint time out; 100 returns the same 6 rows per page and
# responds reliably.
TOTAL_ROW = 100
PAGE_SIZE = 6
DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")


class KenoRowParser(HTMLParser):
    """
    Pulls draw rows out of the result table.

    Each row has four cells:
      0  two links: the draw date, then the draw number
      1  twenty <span> balls
      2  Chẵn/Lẻ  (even/odd count)
      3  Lớn/Nhỏ  (big/small count)
    """

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self._in_row = False
        self._td = -1
        self._cells = []
        self._in_span = False
        self._span_text = ""
        self._in_a = False
        self._a_text = ""

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._in_row = True
            self._td = -1
            self._cells = []
        elif tag == "td" and self._in_row:
            self._td += 1
            self._cells.append({"text": "", "spans": [], "links": []})
        elif tag == "span" and self._cells:
            self._in_span, self._span_text = True, ""
        elif tag == "a" and self._cells:
            self._in_a, self._a_text = True, ""

    def handle_endtag(self, tag):
        if tag == "tr" and self._in_row:
            self._in_row = False
            self._finish_row()
        elif tag == "span" and self._in_span:
            self._in_span = False
            self._cells[-1]["spans"].append(self._span_text.strip())
        elif tag == "a" and self._in_a:
            self._in_a = False
            self._cells[-1]["links"].append(self._a_text.strip())

    def handle_data(self, data):
        if not self._cells:
            return
        self._cells[-1]["text"] += data
        if self._in_span:
            self._span_text += data
        if self._in_a:
            self._a_text += data

    @staticmethod
    def _clean(text):
        return re.sub(r"\s+", " ", text).strip()

    def _finish_row(self):
        if len(self._cells) < 4 or len(self._cells[0]["links"]) < 2:
            return  # header, or a layout row

        date_raw, draw_id = self._cells[0]["links"][0], self._cells[0]["links"][1]
        m = DATE_RE.match(date_raw.strip())
        if not m:
            return

        numbers = [int(s) for s in self._cells[1]["spans"] if s.isdigit()]
        if not numbers:
            return

        self.rows.append({
            "date": f"{m.group(3)}-{m.group(2)}-{m.group(1)}",
            "id": draw_id.strip(),
            "result": numbers,
            # Key names follow the upstream file. Note they are swapped with
            # respect to the site's own columns: "big_small" holds the
            # Chẵn/Lẻ (even/odd) figure and "odd_even" holds Lớn/Nhỏ
            # (big/small). Kept as-is so the file stays drop-in compatible.
            "big_small": self._clean(self._cells[2]["text"]),
            "odd_even": self._clean(self._cells[3]["text"]),
        })


def fetch_page(page, retries=4, timeout=40):
    """Return the HTML fragment for one result page, retrying transient errors."""
    body = json.dumps({
        "DrawDate": "", "GameDrawNo": "", "GameId": "6",
        "ORenderInfo": ORENDER_INFO, "OddEven": 2, "PageIndex": page,
        "ProcessType": 0, "TotalRow": TOTAL_ROW, "UpperLower": 2, "number": "",
    }).encode("utf-8")

    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(URL, data=body, method="POST", headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as res:
                payload = json.loads(res.read().decode("utf-8"))
            html = (payload.get("value") or {}).get("HtmlContent") or ""
            if "Timeout Expired" in html:
                raise RuntimeError("server-side query timeout")
            if not html:
                raise RuntimeError("empty HtmlContent")
            return html
        except (urllib.error.URLError, OSError, ValueError, RuntimeError) as e:
            last = e
            if attempt < retries - 1:
                wait = 3 * (attempt + 1) + random.uniform(0, 1.5)
                print(f"    page {page}: {e} — retrying in {wait:.1f}s", flush=True)
                time.sleep(wait)
    raise RuntimeError(f"page {page} failed after {retries} attempts: {last}")


def parse_page(html):
    p = KenoRowParser()
    p.feed(html)
    return p.rows


def load_jsonl(path):
    rows = {}
    if not path.exists():
        return rows
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("id"):
                rows[row["id"]] = row
    return rows


def write_jsonl(path, rows):
    """Write newest-last, matching the upstream file's ordering."""
    ordered = sorted(rows.values(), key=lambda r: (r["date"], r["id"]))
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        for row in ordered:
            fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    tmp.replace(path)
    return ordered


def verify(path):
    """Check a Keno JSONL file for structural problems. Returns an exit code."""
    if not path.exists():
        print(f"{path}: missing")
        return 1

    seen, problems, dates = {}, [], set()
    lines = dupes = 0
    with path.open(encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            lines += 1
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                problems.append(f"line {n}: bad JSON ({e})")
                continue

            missing = {"date", "id", "result", "big_small", "odd_even"} - row.keys()
            if missing:
                problems.append(f"line {n}: missing keys {sorted(missing)}")
                continue
            if not DATE_RE.match("/".join(reversed(row["date"].split("-")))):
                problems.append(f"line {n}: bad date {row['date']!r}")

            nums = row["result"]
            if len(nums) != 20:
                problems.append(f"line {n} {row['id']}: {len(nums)} numbers, expected 20")
            if len(set(nums)) != len(nums):
                problems.append(f"line {n} {row['id']}: repeated numbers")
            if any(not isinstance(x, int) or not 1 <= x <= 80 for x in nums):
                problems.append(f"line {n} {row['id']}: number outside 1-80")
            if nums != sorted(nums):
                problems.append(f"line {n} {row['id']}: not ascending")

            if row["id"] in seen:
                dupes += 1
                if seen[row["id"]] != row:
                    problems.append(f"line {n} {row['id']}: duplicate with different data")
            seen[row["id"]] = row
            dates.add(row["date"])

    ordered = sorted(seen.values(), key=lambda r: (r["date"], r["id"]))
    print(f"lines        : {lines}")
    print(f"unique draws : {len(seen)}" + (f"  ({dupes} duplicate lines)" if dupes else ""))
    print(f"days covered : {len(dates)}")
    if ordered:
        print(f"range        : {ordered[0]['date']} {ordered[0]['id']} "
              f"-> {ordered[-1]['date']} {ordered[-1]['id']}")
    if problems:
        print(f"\nPROBLEMS: {len(problems)}")
        for p in problems[:20]:
            print(f"  {p}")
        return 1
    print("\nno problems found")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pages", type=int, default=100, help="pages to crawl (6 draws each)")
    ap.add_argument("--start", type=int, default=0, help="first page index (0 = newest)")
    ap.add_argument("--out", default="data/keno.jsonl", help="output JSONL path")
    ap.add_argument("--delay", type=float, default=2.0, help="seconds between requests")
    ap.add_argument("--retries", type=int, default=4, help="attempts per page")
    ap.add_argument("--full", action="store_true",
                    help="keep going even after reaching known draws")
    ap.add_argument("--stop-after-known", type=int, default=3,
                    help="stop after this many consecutive all-known pages")
    ap.add_argument("--verify", action="store_true",
                    help="check the output file and exit without crawling")
    ap.add_argument("--recent-out", default="data/keno-recent.jsonl",
                    help="also write a trimmed tail of the history for the web app")
    ap.add_argument("--recent-count", type=int, default=5000,
                    help="how many of the newest draws the trimmed file keeps")
    args = ap.parse_args()

    out = Path(args.out)
    if args.verify:
        return verify(out)

    out.parent.mkdir(parents=True, exist_ok=True)

    rows = load_jsonl(out)
    before = len(rows)
    print(f"{out}: {before} draws already stored", flush=True)

    added = updated = fetched = failures = 0
    known_streak = 0
    last_page = args.start - 1

    for page in range(args.start, args.start + args.pages):
        try:
            parsed = parse_page(fetch_page(page, retries=args.retries))
        except RuntimeError as e:
            failures += 1
            print(f"  ! {e}", flush=True)
            if failures >= 5:
                print("  giving up after 5 failed pages", flush=True)
                break
            time.sleep(args.delay * 2)
            continue

        fetched += 1
        last_page = page
        if not parsed:
            print(f"  page {page}: no rows — assuming end of history", flush=True)
            break

        page_new = 0
        for row in parsed:
            existing = rows.get(row["id"])
            if existing is None:
                rows[row["id"]] = row
                added += 1
                page_new += 1
            elif existing.get("result") != row["result"]:
                rows[row["id"]] = row
                updated += 1

        known_streak = known_streak + 1 if page_new == 0 else 0
        print(
            f"  page {page:>4}: {len(parsed)} rows "
            f"{parsed[0]['id']} {parsed[0]['date']} -> {parsed[-1]['id']} {parsed[-1]['date']} "
            f"(+{page_new} new)",
            flush=True,
        )

        if not args.full and known_streak >= args.stop_after_known:
            print(f"  reached known draws ({known_streak} pages with nothing new) — stopping", flush=True)
            break

        # Save as we go, so an interrupted crawl keeps what it collected.
        if fetched % 20 == 0:
            write_jsonl(out, rows)

        time.sleep(args.delay + random.uniform(0, 0.6))

    ordered = write_jsonl(out, rows)

    # The full file is ~13 MB, too heavy for the browser app to fetch, so keep
    # a trimmed tail beside it for the Keno tab.
    if args.recent_out and args.recent_count > 0:
        recent = Path(args.recent_out)
        tail = ordered[-args.recent_count:]
        with recent.open("w", encoding="utf-8") as fh:
            for row in tail:
                fh.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        size_mb = recent.stat().st_size / 1e6
        print(f"trimmed copy  : {recent} — {len(tail)} draws, {size_mb:.2f} MB")

    print()
    print(f"pages fetched : {fetched} (through page {last_page}), {failures} failed")
    print(f"new draws     : {added}")
    print(f"corrected     : {updated}")
    print(f"total stored  : {len(ordered)} (was {before})")
    if ordered:
        print(f"range         : {ordered[0]['date']} {ordered[0]['id']} "
              f"-> {ordered[-1]['date']} {ordered[-1]['id']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        sys.exit(130)
