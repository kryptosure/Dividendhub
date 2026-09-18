const Stock = require('../models/stock');
const { fetchDividendData, computeDividendMetrics } = require('./yahooFinance');
const { fetchPayoutRatio } = require('./fmpService');
const { getSeedList, getCategoryMap } = require('./stockUniverse');

// ---------- Payout ratio cache (24h TTL) ----------
const payoutCache = new Map();
const PAYOUT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getCachedPayoutRatio(symbol) {
  const key = String(symbol || '').toUpperCase().trim();
  if (!key) return null;
  const cached = payoutCache.get(key);
  if (cached && Date.now() - cached.timestamp < PAYOUT_CACHE_TTL_MS) return cached.value;
  const value = await fetchPayoutRatio(key);
  payoutCache.set(key, { value, timestamp: Date.now() });
  if (payoutCache.size > 500) {
    const cutoff = Date.now() - PAYOUT_CACHE_TTL_MS;
    for (const [k, v] of payoutCache.entries()) {
      if (v.timestamp < cutoff) payoutCache.delete(k);
    }
  }
  return value;
}

// ---------- Concurrency limiter ----------
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

  if (stock && Date.now() - new Date(stock.lastUpdated).getTime() < 12 * 60 * 60 * 1000) {
    const data = stock.dividendData || {};
    const metrics = computeDividendMetrics(data.byYear || []);

    let payoutRatio = data.payoutRatio;
    if (payoutRatio == null) {
      payoutRatio = await getCachedPayoutRatio(cleanSymbol);
      if (payoutRatio != null) {
        try {
          const merged = { ...data, payoutRatio };
          stock.dividendData = merged;
          await stock.save();
        } catch (e) { /* ignore */ }
      }
    }

    return {
      symbol: stock.symbol, name: stock.name, market: stock.market, type: stock.type,
      currency: data.currency || 'USD',
      currencySymbol: data.currencySymbol || '$',
      totalDividend: parseFloat(stock.totalDividend),
      payoutCount: stock.payoutCount,
      firstExDate: stock.firstExDate, lastExDate: stock.lastExDate,
      byYear: data.byYear || [],
      currentPrice: parseFloat(stock.currentPrice),
      currentYield: parseFloat(stock.currentYield),
      dividendCAGR: metrics.dividendCAGR,
      dividendFrequency: metrics.dividendFrequency,
      dividendStreak: metrics.dividendStreak,
      trailingAnnualDiv: data.trailingAnnualDiv || null,
      payoutRatio,
      safetyScore: stock.safetyScore,
      exchange: data.exchange || (market === 'sg' ? 'SGX' : 'NASDAQ'),
    };
  }

  const data = await fetchDividendData(cleanSymbol, market);
  if (data.error || data.message) throw new Error(data.error || data.message);

  const freshPayoutRatio = await getCachedPayoutRatio(cleanSymbol);
  data.payoutRatio = freshPayoutRatio;

  await Stock.upsert({
    symbol: data.symbol || cleanSymbol,
    name: data.name, market: market, type: type,
    dividendData: data,
    currentPrice: data.currentPrice, currentYield: data.currentYield,
    safetyScore: data.safetyScore, payoutCount: data.payoutCount,
    totalDividend: data.totalDividend,
    firstExDate: data.firstExDate, lastExDate: data.lastExDate,
    lastUpdated: new Date(),
  });

  return data;
}

// ---------- Batch ----------
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

// ---------- Refresh universe ----------
async function refreshTopStocks(market, options = {}) {
  const { onProgress } = options;

  // ✅ FIX (CA): include 'ca' in the allowed target markets.
  const targetMarket = ['us', 'sg', 'ca'].includes(market) ? market : null;

  const lists = getSeedList();
  const categoryMap = getCategoryMap();
  const job = [];

  if (!targetMarket || targetMarket === 'us') {
    for (const sym of lists.us) {
      const isEtf = categoryMap[sym] === 'ETF' || categoryMap[sym] === 'Bond ETF';
      job.push({ symbol: sym, market: 'us', type: isEtf ? 'etf' : 'stock' });
    }
  }
  if (!targetMarket || targetMarket === 'sg') {
    for (const sym of lists.sg) {
      const isEtf = categoryMap[sym] === 'ETF' || categoryMap[sym] === 'Bond ETF';
      job.push({ symbol: sym, market: 'sg', type: isEtf ? 'etf' : 'stock' });
    }
  }
  // ✅ NEW: Canada branch
  if (!targetMarket || targetMarket === 'ca') {
    for (const sym of lists.ca) {
      const isEtf = categoryMap[sym] === 'ETF' || categoryMap[sym] === 'Bond ETF';
      job.push({ symbol: sym, market: 'ca', type: isEtf ? 'etf' : 'stock' });
    }
  }

  console.log(`🌱 Seed job: ${job.length} tickers total (US: ${lists.us.length}, SG: ${lists.sg.length}, CA: ${lists.ca.length})`);

  let updated = 0;
  let failed = 0;
  const failedSymbols = [];

  await mapWithConcurrency(job, 3, async ({ symbol, market: m, type }) => {
    try {
      await getStock(symbol, m, type);
      updated++;
      if (onProgress && updated % 25 === 0) {
        onProgress({ updated, failed, total: job.length });
      }
    } catch (e) {
      failed++;
      failedSymbols.push(symbol);
      console.warn(`Seed failed for ${symbol}:`, e.message);
    }
  });

  console.log(`✅ Refreshed ${updated} stocks, ${failed} failed (${job.length} total)`);
  if (failedSymbols.length > 0 && failedSymbols.length <= 20) {
    console.log(`Failed tickers: ${failedSymbols.join(', ')}`);
  }
  return { updated, failed, total: job.length };
}

module.exports = { getStock, getBatchStocks, refreshTopStocks, getCachedPayoutRatio };