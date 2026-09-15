const Stock = require('../models/stock');
const { fetchDividendData } = require('./yahooFinance');
const { fetchPayoutRatio } = require('./fmpService');
const { sleep } = require('../utils/helpers');

// ---------- Payout ratio cache (24h TTL) ----------
// Protects the FMP free tier (250 req/day). Keyed by uppercase symbol.
const payoutCache = new Map();
const PAYOUT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getCachedPayoutRatio(symbol) {
  const key = String(symbol || '').toUpperCase().trim();
  if (!key) return null;

  const cached = payoutCache.get(key);
  if (cached && Date.now() - cached.timestamp < PAYOUT_CACHE_TTL_MS) {
    return cached.value;
  }

  const value = await fetchPayoutRatio(key);
  payoutCache.set(key, { value, timestamp: Date.now() });

  // Periodic cleanup so the Map doesn't grow forever
  if (payoutCache.size > 500) {
    const cutoff = Date.now() - PAYOUT_CACHE_TTL_MS;
    for (const [k, v] of payoutCache.entries()) {
      if (v.timestamp < cutoff) payoutCache.delete(k);
    }
  }

  return value;
}

// ---------- Concurrency limiter for batch FMP calls ----------
// Prevents a 20-symbol watchlist from firing 20 FMP requests in parallel.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function run() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, run);
  await Promise.all(runners);
  return results;
}

// ---------- Get single stock ----------
async function getStock(symbol, market, type = 'stock') {
  const cleanSymbol = String(symbol || '').toUpperCase().trim();
  if (!cleanSymbol) throw new Error('Symbol required');

  const stock = await Stock.findByPk(cleanSymbol);

  // Cached path (12-hour window)
  if (stock && Date.now() - new Date(stock.lastUpdated).getTime() < 12 * 60 * 60 * 1000) {
    const data = stock.dividendData || {};

    // If the cached entry has no payoutRatio (or it's null), try FMP once
    let payoutRatio = data.payoutRatio;
    if (payoutRatio == null) {
      payoutRatio = await getCachedPayoutRatio(cleanSymbol);
      // Best-effort: persist to the cached JSONB so we don't re-fetch
      if (payoutRatio != null) {
        try {
          const merged = { ...data, payoutRatio };
          stock.dividendData = merged;
          await stock.save();
        } catch (e) {
          // ignore persistence errors
        }
      }
    }

    return {
      symbol: stock.symbol,
      name: stock.name,
      market: stock.market,
      type: stock.type,
      currency: data.currency || 'USD',
      currencySymbol: data.currencySymbol || '$',
      totalDividend: parseFloat(stock.totalDividend),
      payoutCount: stock.payoutCount,
      firstExDate: stock.firstExDate,
      lastExDate: stock.lastExDate,
      byYear: data.byYear || [],
      currentPrice: parseFloat(stock.currentPrice),
      currentYield: parseFloat(stock.currentYield),
      dividendCAGR: data.dividendCAGR || null,
      trailingAnnualDiv: data.trailingAnnualDiv || null,
      payoutRatio: payoutRatio, // ✅ FMP-sourced (or null)
      safetyScore: stock.safetyScore,
      exchange: data.exchange || (market === 'sg' ? 'SGX' : 'NASDAQ'),
    };
  }

  // Fresh fetch path
  const data = await fetchDividendData(cleanSymbol, market);
  if (data.error || data.message) throw new Error(data.error || data.message);

  // ✅ Override Yahoo-derived payoutRatio with the FMP value.
  // This is stored inside dividendData (JSONB) so it persists.
  const fmpPayoutRatio = await getCachedPayoutRatio(cleanSymbol);
  data.payoutRatio = fmpPayoutRatio; // may be null — that's fine

  await Stock.upsert({
    symbol: data.symbol || cleanSymbol,
    name: data.name,
    market: market,
    type: type,
    dividendData: data,
    currentPrice: data.currentPrice,
    currentYield: data.currentYield,
    safetyScore: data.safetyScore,
    payoutCount: data.payoutCount,
    totalDividend: data.totalDividend,
    firstExDate: data.firstExDate,
    lastExDate: data.lastExDate,
    lastUpdated: new Date(),
  });

  return data;
}

// ---------- Batch (watchlist, comparison, portfolio) ----------
async function getBatchStocks(symbols, market) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];

  return mapWithConcurrency(symbols, 3, async (symbol) => {
    try {
      const data = await getStock(symbol, market);
      return { symbol, data, error: null };
    } catch (e) {
      return { symbol, data: null, error: e.message };
    }
  });
}

// ---------- Refresh top stocks & ETFs (admin job) ----------
async function refreshTopStocks(market = 'us') {
  const stockSymbols = market === 'us'
    ? ['VZ','T','KHC','MO','ABBV','PFE','XOM','CVX','JPM','BAC','WFC','KO','PEP','MCD','MSFT','AAPL','NVDA','JNJ','PG','HD']
    : ['D05.SI','O39.SI','U11.SI','C6L.SI','Z74.SI','BN4.SI','S63.SI','C52.SI','F34.SI','G13.SI','H78.SI','J36.SI','C07.SI','S68.SI','K71U.SI','A17U.SI','N2IU.SI','C38U.SI','M44U.SI'];

  const etfSymbols = market === 'us'
    ? ['SPY','QQQ','VTI','VOO','IVV','BND','AGG','GLD','SLV','EEM','EFA','IWM','XLK','XLF','XLE','XLI','XLV','XLY','XLP','XLU']
    : ['ES3.SI','G3B.SI','CFA.SI','O87.SI','M62.SI','N6M.SI','S27.SI','ER7.SI','NS8U.SI','GRN.SI'];

  // Wipe existing entries for this market to avoid duplicates
  await Stock.destroy({ where: { market } });

  for (const symbol of stockSymbols) {
    try {
      await getStock(symbol, market, 'stock');
      await sleep(200);
    } catch (e) {
      console.error(`Failed to refresh stock ${symbol}:`, e.message);
    }
  }

  for (const symbol of etfSymbols) {
    try {
      await getStock(symbol, market, 'etf');
      await sleep(200);
    } catch (e) {
      console.error(`Failed to refresh ETF ${symbol}:`, e.message);
    }
  }

  console.log(`✅ Refreshed top stocks and ETFs for ${market}`);
}

module.exports = { getStock, getBatchStocks, refreshTopStocks, getCachedPayoutRatio };