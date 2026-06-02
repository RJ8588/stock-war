const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 4173);

const snapshots = {
  BIL: {
    symbol: "BIL",
    rate: 3.49,
    source: "State Street 30-Day SEC Yield snapshot",
    updatedAt: "2026-05-20T16:00:00-04:00"
  },
  SGOV: {
    symbol: "SGOV",
    rate: 3.54,
    source: "iShares 30-Day SEC Yield snapshot",
    updatedAt: "2026-05-22T16:00:00-04:00"
  }
};

const normalize = symbol => {
  const s = String(symbol || "").trim().toUpperCase();
  return s === "SVOG" ? "SGOV" : s;
};

async function textFrom(url) {
  const res = await fetch(url, {
    headers: {
      "accept": "text/html,application/json;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 DashboardYieldFetcher/1.0"
    }
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.text();
}

function extractSecYield(html) {
  const flat = html.replace(/\s+/g, " ");
  const match = flat.match(/30\s*Day\s*SEC\s*Yield(?:[^0-9%]{0,120})(\d+(?:\.\d+)?)\s*%/i);
  if (!match) return null;
  const dateMatch = flat.match(/30\s*Day\s*SEC\s*Yield\s*as\s*of\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  return { rate: Number(match[1]), asOf: dateMatch?.[1] || "" };
}

async function officialYield(symbol) {
  if (symbol === "SGOV") {
    const html = await textFrom("https://www.ishares.com/us/products/314116/");
    const parsed = extractSecYield(html);
    if (parsed) {
      return {
        symbol,
        rate: parsed.rate,
        source: `iShares 30-Day SEC Yield${parsed.asOf ? ` as of ${parsed.asOf}` : ""}`,
        updatedAt: new Date().toISOString()
      };
    }
  }
  if (symbol === "BIL") {
    const html = await textFrom("https://www.ssga.com/us/en/intermediary/etfs/state-street-spdr-bloomberg-1-3-month-t-bill-etf-bil");
    const parsed = extractSecYield(html);
    if (parsed) {
      return {
        symbol,
        rate: parsed.rate,
        source: `State Street 30-Day SEC Yield${parsed.asOf ? ` as of ${parsed.asOf}` : ""}`,
        updatedAt: new Date().toISOString()
      };
    }
  }
  return null;
}

async function yahooYields(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = await res.json();
  return (json.quoteResponse?.result || []).map(q => {
    const raw = q.trailingAnnualDividendYield ?? q.dividendYield ?? q.yield;
    if (raw == null) return null;
    const rate = Number(raw) > 1 ? Number(raw) : Number(raw) * 100;
    return {
      symbol: normalize(q.symbol),
      rate,
      source: "Yahoo Finance dividend yield",
      updatedAt: new Date().toISOString()
    };
  }).filter(Boolean);
}

async function yahooQuotes(symbols) {
  const unique = [...new Set(symbols.map(normalize).filter(Boolean))];
  if (!unique.length) return [];
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(unique.join(","))}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo ${res.status}`);
  const json = await res.json();
  return (json.quoteResponse?.result || []).map(q => ({
    symbol: normalize(q.symbol),
    price: Number(q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? 0),
    changePercent: Number(q.regularMarketChangePercent ?? 0),
    source: "Yahoo Finance quote",
    updatedAt: new Date().toISOString()
  })).filter(q => q.symbol && q.price > 0);
}

async function yieldResponse(symbols) {
  const unique = [...new Set(symbols.map(normalize).filter(Boolean))];
  const rows = [];
  const errors = [];
  for (const symbol of unique) {
    try {
      const official = await officialYield(symbol);
      if (official) {
        rows.push(official);
        continue;
      }
      errors.push({ source: `${symbol} official`, message: "No SEC yield parsed from official page" });
    } catch (e) {
      errors.push({ source: `${symbol} official`, message: String(e?.message || e) });
    }
  }
  const missing = unique.filter(symbol => !rows.some(row => row.symbol === symbol));
  if (missing.length) {
    try {
      rows.push(...await yahooYields(missing));
    } catch (e) {
      errors.push({ source: "Yahoo Finance", message: String(e?.message || e) });
    }
  }
  for (const symbol of unique) {
    if (!rows.some(row => row.symbol === symbol) && snapshots[symbol]) rows.push(snapshots[symbol]);
  }
  return { yields: rows, errors };
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/api/yields") {
      const symbols = String(url.searchParams.get("symbols") || "BIL,SGOV").split(",");
      const payload = await yieldResponse(symbols);
      send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/quotes") {
      const symbols = String(url.searchParams.get("symbols") || "").split(",");
      const quotes = await yahooQuotes(symbols).catch(() => []);
      send(res, 200, JSON.stringify({ quotes }), "application/json; charset=utf-8");
      return;
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const file = path.join(root, pathname);
    if (!file.startsWith(root)) {
      send(res, 403, "forbidden");
      return;
    }
    const data = await fs.readFile(file);
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream";
    send(res, 200, data, type);
  } catch {
    send(res, 404, "not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Dashboard running at http://127.0.0.1:${port}/`);
});
