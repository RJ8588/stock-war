const http = require("http");
const fs = require("fs/promises");
const path = require("path");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const stateFile = path.join(root, ".data", "dashboard-state.json");
const fngCacheFile = path.join(root, ".data", "cnn-fng-cache.json");
let fearGreedMemoryCache = null;
let fearGreedMemoryCachedAt = 0;
let fearGreedInFlight = null;
const fearGreedCacheTtlMs = 45 * 1000;

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

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function readRequestBody(req) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

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

const tradingViewQuoteExchangeOrder = {
  SPY: ["AMEX", "NYSEARCA", "ARCA", "NYSE", "NASDAQ"],
  BIL: ["AMEX", "NYSEARCA", "ARCA", "NYSE", "NASDAQ"],
  SGOV: ["AMEX", "NYSEARCA", "ARCA", "NYSE", "NASDAQ"],
  QQQ: ["NASDAQ", "AMEX", "NYSEARCA", "ARCA", "NYSE"],
  IWM: ["AMEX", "NYSEARCA", "ARCA", "NYSE", "NASDAQ"],
  VOO: ["NYSEARCA", "AMEX", "ARCA", "NYSE", "NASDAQ"],
  IVV: ["NYSEARCA", "AMEX", "ARCA", "NYSE", "NASDAQ"]
};

function quoteExchangeCandidates(symbol) {
  return tradingViewQuoteExchangeOrder[symbol] || ["NASDAQ", "NYSE", "AMEX", "NYSEARCA", "ARCA", "BATS", "CBOE", "OTC"];
}

function tradingViewSymbolUrl(exchange, symbol) {
  return `https://tw.tradingview.com/symbols/${exchange}-${encodeURIComponent(symbol)}/`;
}

function extractTradingViewQuote(html, symbol) {
  const flat = String(html || "").replace(/\s+/g, " ");
  const sym = escapeRegExp(symbol);
  const patterns = [
    new RegExp(`(?:The current price of|current price of)\\s+${sym}\\s+is\\s+([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*USD`, "i"),
    new RegExp(`(?:${sym}\\s+trades at|${sym}\\s+stock price today is|${sym}\\s+price today is)\\s+([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*USD`, "i"),
    new RegExp(`(?:price of\\s+${sym}|${sym}\\s+price)\\s+is\\s+([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*USD`, "i"),
    new RegExp(`\\b${sym}\\b[^\\d]{0,120}?([0-9][0-9,]*(?:\\.[0-9]+)?)\\s*USD`, "i")
  ];
  for (const pattern of patterns) {
    const match = flat.match(pattern);
    if (!match) continue;
    const price = Number(String(match[1]).replaceAll(",", ""));
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

async function tradingViewQuote(symbol) {
  const unique = normalize(symbol);
  if (!unique) return null;
  for (const exchange of quoteExchangeCandidates(unique)) {
    try {
      const html = await textFrom(tradingViewSymbolUrl(exchange, unique));
      const price = extractTradingViewQuote(html, unique);
      if (!price) continue;
      return {
        symbol: unique,
        price,
        changePercent: null,
        source: `TradingView official symbol page (${exchange})`,
        updatedAt: new Date().toISOString()
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function tradingViewQuotes(symbols) {
  const unique = [...new Set(symbols.map(normalize).filter(Boolean))];
  const quotes = [];
  const errors = [];
  for (const symbol of unique) {
    try {
      const quote = await tradingViewQuote(symbol);
      if (quote) {
        quotes.push(quote);
      } else {
        errors.push({ source: `TradingView ${symbol}`, message: "No price parsed from official symbol page" });
      }
    } catch (e) {
      errors.push({ source: `TradingView ${symbol}`, message: String(e?.message || e) });
    }
  }
  return { quotes, errors };
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

async function fetchFearGreedOfficial() {
  const res = await fetch("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", {
    headers: {
      "accept": "application/json, text/plain, */*",
      "origin": "https://edition.cnn.com",
      "referer": "https://edition.cnn.com/markets/fear-and-greed",
      "user-agent": "Mozilla/5.0"
    }
  });
  if (!res.ok) throw new Error(`CNN ${res.status}`);
  const json = await res.json();
  const fg = json?.fear_and_greed || {};
  const hist = json?.fear_and_greed_historical || {};
  const payload = {
    score: Number(fg.score || 0),
    rating: String(fg.rating || "").replaceAll("_", " "),
    timestamp: fg.timestamp || "",
    previousClose: Number(fg.previous_close || 0),
    previous1Week: Number(fg.previous_1_week || 0),
    previous1Month: Number(fg.previous_1_month || 0),
    previous1Year: Number(fg.previous_1_year || 0),
    history: Array.isArray(hist.data) ? hist.data.slice(-30).map(item => ({
      x: Number(item.x || 0),
      y: Number(item.y || 0),
      rating: String(item.rating || "").replaceAll("_", " ")
    })) : []
  };
  await writeJsonFile(fngCacheFile, payload);
  return payload;
}

async function fearGreedResponse(force = false) {
  const now = Date.now();
  if (!force && fearGreedMemoryCache && now - fearGreedMemoryCachedAt < fearGreedCacheTtlMs) {
    return fearGreedMemoryCache;
  }
  if (fearGreedInFlight) return fearGreedInFlight;
  fearGreedInFlight = (async () => {
    try {
      const payload = await fetchFearGreedOfficial();
      fearGreedMemoryCache = payload;
      fearGreedMemoryCachedAt = Date.now();
      return payload;
    } catch (err) {
      const cached = fearGreedMemoryCache || await readJsonFile(fngCacheFile).catch(() => null);
      if (cached) {
        fearGreedMemoryCache = cached;
        fearGreedMemoryCachedAt = Date.now();
        return cached;
      }
      throw err;
    } finally {
      fearGreedInFlight = null;
    }
  })();
  return fearGreedInFlight;
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/api/state") {
      if (req.method === "GET") {
        const state = await readJsonFile(stateFile);
        send(res, 200, JSON.stringify({ state }), "application/json; charset=utf-8");
        return;
      }
      if (req.method === "POST") {
        const body = await readRequestBody(req);
        const parsed = JSON.parse(body || "{}");
        await writeJsonFile(stateFile, parsed);
        send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
        return;
      }
      send(res, 405, "method not allowed");
      return;
    }
    if (url.pathname === "/api/yields") {
      const symbols = String(url.searchParams.get("symbols") || "BIL,SGOV").split(",");
      const payload = await yieldResponse(symbols);
      send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/fng") {
      const payload = await fearGreedResponse(url.searchParams.get("force") === "1");
      send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8");
      return;
    }
    if (url.pathname === "/api/quotes") {
      const symbols = String(url.searchParams.get("symbols") || "").split(",");
      const payload = await tradingViewQuotes(symbols);
      send(res, 200, JSON.stringify(payload), "application/json; charset=utf-8");
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
