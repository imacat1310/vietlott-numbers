#!/usr/bin/env python3
"""
Static file server + vietlott.vn crawl proxy for the number generator app.

Standard library only - no pip install needed.

    python3 server.py [--port 8099]

Why a proxy: vietlott.vn's ajaxpro endpoint sends no CORS headers, so the
browser cannot POST to it from this app's origin. This relays the exact request
the upstream Python crawler sends (src/vietlott/crawler) and hands the raw
HtmlContent back to the page, which parses it with DOMParser.

Note: vietlott.vn blocks many non-Vietnam IPs (upstream issue #13). When live
crawling fails, the app falls back to the repo's daily-updated JSONL on GitHub.
"""

import argparse
import json
import time
import urllib.error
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).parent.resolve()

PRODUCTS = {
    "power_655": {
        "url": "https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game655CompareWebPart,Vietlott.PlugIn.WebParts.ashx",
        "key": "23bbd667",
        "referer": "https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/655",
        # The endpoint validates the ArrayNumbers grid shape and 500s on a
        # mismatch, and each game uses its own (rows, cols).
        "array_shape": (5, 18),
    },
    "power_645": {
        "url": "https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game645CompareWebPart,Vietlott.PlugIn.WebParts.ashx",
        "key": "8290fce2",
        "referer": "https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/645",
        "array_shape": (6, 18),
    },
    "power_535": {
        "url": "https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game535CompareWebPart,Vietlott.PlugIn.WebParts.ashx",
        "key": "d0ea794f",
        "referer": "https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/535",
        "array_shape": (5, 35),
    },
}

ORENDER_INFO = {
    "ExtraParam1": "",
    "ExtraParam2": "",
    "ExtraParam3": "",
    "FullPageAlias": None,
    "IsPageDesign": False,
    "OrgPageAlias": None,
    "PageAlias": None,
    "RefKey": None,
    "SiteAlias": "main.vi",
    "SiteId": "main.frontend.vi",
    "SiteLang": "vi",
    "SiteName": "Vietlott",
    "SiteURL": "",
    "System": 1,
    "UserSessionId": "",
    "WebPage": None,
}

TIMEOUT = 25


def crawl_page(product: str, page: int, attempts: int = 3) -> str:
    """POST one result page and return its HtmlContent, retrying transient errors.

    vietlott.vn intermittently drops connections or times out the TLS handshake
    under rapid repeated requests; a short backoff clears it far more often than
    it does not.
    """
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            return _crawl_page_once(product, page)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = e
            if attempt < attempts - 1:
                print(f"[crawl] {product} page={page} attempt {attempt + 1} failed ({e}); retrying")
                time.sleep(1.5 * (attempt + 1))
    raise last if last else RuntimeError("crawl failed")


def _crawl_page_once(product: str, page: int) -> str:
    cfg = PRODUCTS[product]
    rows, cols = cfg["array_shape"]
    body = json.dumps(
        {
            "ORenderInfo": ORENDER_INFO,
            "Key": cfg["key"],
            "GameDrawId": "",
            "ArrayNumbers": [["" for _ in range(cols)] for _ in range(rows)],
            "CheckMulti": False,
            "PageIndex": page,
        }
    ).encode("utf-8")

    req = urllib.request.Request(
        cfg["url"],
        data=body,
        method="POST",
        headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) "
            "Gecko/20100101 Firefox/128.0",
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.5",
            "Content-Type": "text/plain; charset=utf-8",
            "X-AjaxPro-Method": "ServerSideDrawResult",
            "X-Requested-With": "XMLHttpRequest",
            "Origin": "https://vietlott.vn",
            "Referer": cfg["referer"],
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
        payload = json.loads(res.read().decode("utf-8"))

    html = (payload or {}).get("value", {}).get("HtmlContent")
    if not html:
        raise ValueError("no HtmlContent in response")
    return html


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".jsonl": "text/plain",
    }

    def _send_json(self, code: int, obj: dict) -> None:
        payload = json.dumps(obj).encode("utf-8")
        self._cache_header_sent = True
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802  (stdlib naming)
        parsed = urlparse(self.path)

        if parsed.path == "/api/health":
            self._send_json(200, {"ok": True, "products": list(PRODUCTS)})
            return

        if parsed.path == "/api/crawl":
            qs = parse_qs(parsed.query)
            product = (qs.get("product") or [""])[0]
            try:
                page = int((qs.get("page") or ["0"])[0])
            except ValueError:
                self._send_json(400, {"ok": False, "error": "bad page"})
                return

            if product not in PRODUCTS:
                self._send_json(400, {"ok": False, "error": f"unknown product: {product}"})
                return
            if not 0 <= page <= 500:
                self._send_json(400, {"ok": False, "error": f"page out of range: {page}"})
                return

            try:
                html = crawl_page(product, page)
            except (urllib.error.URLError, ValueError, TimeoutError, json.JSONDecodeError) as e:
                print(f"[crawl] {product} page={page} failed: {e}")
                self._send_json(502, {"ok": False, "error": str(e)})
                return

            print(f"[crawl] {product} page={page} ok ({len(html)} bytes)")
            self._send_json(200, {"ok": True, "product": product, "page": page, "htmlContent": html})
            return

        super().do_GET()

    def end_headers(self) -> None:
        # Static assets are served fresh so edits show up on reload; JSON
        # responses set their own Cache-Control above.
        if not getattr(self, "_cache_header_sent", False):
            self.send_header("Cache-Control", "no-cache")
        self._cache_header_sent = False
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        first = str(args[0]) if args else ""
        if "/api/" not in first:
            return  # keep the console focused on crawl activity
        super().log_message(fmt, *args)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8099)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    handler = partial(Handler, directory=str(ROOT))
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Vietlott number generator -> http://{args.host}:{args.port}")
    print("Live crawl proxy enabled at /api/crawl")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
