#!/usr/bin/env node
/**
 * Static file server + vietlott.vn crawl proxy for the number generator app.
 *
 * No dependencies - node >= 18 only.
 *
 *   node server.js [--port 8099]
 *
 * Why a proxy: vietlott.vn's ajaxpro endpoint returns no CORS headers, so the
 * browser cannot POST to it from this app's origin. The proxy relays the exact
 * request the upstream Python crawler sends and hands the raw HtmlContent back
 * to the page, which parses it with DOMParser.
 *
 * Note: vietlott.vn blocks many non-Vietnam IPs (upstream issue #13). If live
 * crawling fails, the app falls back to the repo's daily-updated JSONL.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : 0) || 8099;

const PRODUCTS = {
  power_655: {
    url: 'https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game655CompareWebPart,Vietlott.PlugIn.WebParts.ashx',
    key: '23bbd667',
    referer: 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/655',
    // The endpoint validates the ArrayNumbers grid shape and 500s on a
    // mismatch, and each game uses its own [rows, cols].
    arrayShape: [5, 18],
  },
  power_645: {
    url: 'https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game645CompareWebPart,Vietlott.PlugIn.WebParts.ashx',
    key: '8290fce2',
    referer: 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/645',
    arrayShape: [6, 18],
  },
  power_535: {
    url: 'https://vietlott.vn/ajaxpro/Vietlott.PlugIn.WebParts.Game535CompareWebPart,Vietlott.PlugIn.WebParts.ashx',
    key: 'd0ea794f',
    referer: 'https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/535',
    arrayShape: [5, 35],
  },
};

const ORENDER_INFO = {
  ExtraParam1: '',
  ExtraParam2: '',
  ExtraParam3: '',
  FullPageAlias: null,
  IsPageDesign: false,
  OrgPageAlias: null,
  PageAlias: null,
  RefKey: null,
  SiteAlias: 'main.vi',
  SiteId: 'main.frontend.vi',
  SiteLang: 'vi',
  SiteName: 'Vietlott',
  SiteURL: '',
  System: 1,
  UserSessionId: '',
  WebPage: null,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * vietlott.vn intermittently drops connections or times out the TLS handshake
 * under rapid repeated requests; a short backoff clears it far more often than
 * it does not.
 */
async function crawlPage(product, page, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await crawlPageOnce(product, page);
    } catch (e) {
      last = e;
      if (attempt < attempts - 1) {
        console.log(`[crawl] ${product} page=${page} attempt ${attempt + 1} failed (${e.message}); retrying`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
  }
  throw last;
}

function crawlPageOnce(product, page) {
  const cfg = PRODUCTS[product];
  const [rows, cols] = cfg.arrayShape;
  const body = JSON.stringify({
    ORenderInfo: ORENDER_INFO,
    Key: cfg.key,
    GameDrawId: '',
    ArrayNumbers: Array.from({ length: rows }, () => Array(cols).fill('')),
    CheckMulti: false,
    PageIndex: page,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      cfg.url,
      {
        method: 'POST',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
          Accept: '*/*',
          'Accept-Language': 'en-US,en;q=0.5',
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'X-AjaxPro-Method': 'ServerSideDrawResult',
          'X-Requested-With': 'XMLHttpRequest',
          Origin: 'https://vietlott.vn',
          Referer: cfg.referer,
        },
        timeout: 25000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`vietlott.vn HTTP ${res.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const html = parsed?.value?.HtmlContent;
            if (!html) {
              reject(new Error('no HtmlContent in response'));
              return;
            }
            resolve(html);
          } catch {
            reject(new Error(`unparseable response: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout after 25s')));
    req.on('error', reject);
    req.end(body);
  });
}

function sendJson(res, code, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, products: Object.keys(PRODUCTS) });
    return;
  }

  if (url.pathname === '/api/crawl') {
    const product = url.searchParams.get('product');
    const page = Number(url.searchParams.get('page') ?? 0);
    if (!PRODUCTS[product]) {
      sendJson(res, 400, { ok: false, error: `unknown product: ${product}` });
      return;
    }
    if (!Number.isInteger(page) || page < 0 || page > 500) {
      sendJson(res, 400, { ok: false, error: `bad page: ${page}` });
      return;
    }
    try {
      const htmlContent = await crawlPage(product, page);
      console.log(`[crawl] ${product} page=${page} ok (${htmlContent.length} bytes)`);
      sendJson(res, 200, { ok: true, product, page, htmlContent });
    } catch (e) {
      console.error(`[crawl] ${product} page=${page} failed: ${e.message}`);
      sendJson(res, 502, { ok: false, error: e.message });
    }
    return;
  }

  serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`Vietlott number generator -> http://localhost:${PORT}`);
  console.log('Live crawl proxy enabled at /api/crawl');
});
