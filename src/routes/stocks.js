const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { Op } = require('sequelize');
const Stock = require('../models/stock');
const { getStock, getBatchStocks } = require('../services/stockService');
const { yahooSearch, fetchDividendsRaw, fetchPricesRaw } = require('../services/yahooFinance');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
});

// ---------- HARDCODED FALLBACK for common names ----------
const FALLBACK_MAP = {
  us: {
    'apple': [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' }],
    'microsoft': [{ symbol: 'MSFT', name: 'Microsoft Corp.', exchange: 'NASDAQ' }],
    'amazon': [{ symbol: 'AMZN', name: 'Amazon.com Inc.', exchange: 'NASDAQ' }],
    'google': [{ symbol: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ' }],
    'facebook': [{ symbol: 'META', name: 'Meta Platforms', exchange: 'NASDAQ' }],
    'netflix': [{ symbol: 'NFLX', name: 'Netflix Inc.', exchange: 'NASDAQ' }],
    'tesla': [{ symbol: 'TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ' }],
    'nvidia': [{ symbol: 'NVDA', name: 'NVIDIA Corp.', exchange: 'NASDAQ' }],
    'jpmorgan': [{ symbol: 'JPM', name: 'JPMorgan Chase', exchange: 'NYSE' }],
    'verizon': [{ symbol: 'VZ', name: 'Verizon Communications', exchange: 'NYSE' }],
    'coca-cola': [{ symbol: 'KO', name: 'Coca-Cola Co.', exchange: 'NYSE' }],
    'spy': [{ symbol: 'SPY', name: 'SPDR S&P 500 ETF', exchange: 'NYSE ARCA' }],
    'qqq': [{ symbol: 'QQQ', name: 'Invesco QQQ Trust', exchange: 'NASDAQ' }],
    'vti': [{ symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', exchange: 'NYSE ARCA' }],
  },
  sg: {
    'dbs': [{ symbol: 'D05.SI', name: 'DBS Group Holdings', exchange: 'SGX' }],
    'ocbc': [{ symbol: 'O39.SI', name: 'OCBC Bank', exchange: 'SGX' }],
    'uob': [{ symbol: 'U11.SI', name: 'United Overseas Bank', exchange: 'SGX' }],
    'singapore airlines': [{ symbol: 'C6L.SI', name: 'Singapore Airlines', exchange: 'SGX' }],
    'singtel': [{ symbol: 'Z74.SI', name: 'Singtel', exchange: 'SGX' }],
    'keppel': [{ symbol: 'BN4.SI', name: 'Keppel Corp', exchange: 'SGX' }],
    'es3': [{ symbol: 'ES3.SI', name: 'SPDR Straits Times Index ETF', exchange: 'SGX' }],
    'g3b': [{ symbol: 'G3B.SI', name: 'Nikko AM Singapore STI ETF', exchange: 'SGX' }],
  }
};

// ---------- Search (Updated: Combined DB + Live API Merging) ----------
router.get('/search', limiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const market = String(req.query.market || 'us').toLowerCase();

  if (q.length < 2) return res.json([]);

  try {
    let yahooResults = [];
    let dbResults = [];

    // 1. Fetch from Live Yahoo API with expanded asset class support
    try {
      const yahoo = await yahooSearch(q, market);
      if (yahoo && yahoo.length > 0) {
        yahooResults = yahoo.map(item => ({
          symbol: item.symbol,
          shortname: item.shortname || item.symbol,
          longname: item.longname || item.shortname || item.symbol,
          exchange: item.exchange || (market === 'sg' ? 'SGX' : 'NASDAQ'),
        }));
      }
    } catch (e) {
      console.warn('Yahoo live search failed:', e.message);
    }

    // 2. Fetch from Local Database to display cached/seeded assets instantly
    try {
      const stocks = await Stock.findAll({
        where: {
          market,
          [Op.or]: [
            { symbol: { [Op.iLike]: `%${q}%` } },
            { name: { [Op.iLike]: `%${q}%` } },
          ],
        },
        limit: 5,
      });
      dbResults = stocks.map(s => ({
        symbol: s.symbol,
        shortname: s.name || s.symbol,
        longname: s.name || s.symbol,
        exchange: market === 'sg' ? 'SGX' : 'NASDAQ',
      }));
    } catch (e) {
      console.warn('Database search fallback failed:', e.message);
    }

    // 3. Merge, Deduplicate by symbol (Prioritising Live Data for accurate sizing)
    const combined = [...yahooResults, ...dbResults];
    const seen = new Set();
    let unique = combined.filter(item => {
      const key = item.symbol.toUpperCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 4. Hardcoded Fallback Map fallback (Last Resort)
    if (unique.length === 0) {
      const normalized = q.toLowerCase().trim();
      const map = FALLBACK_MAP[market] || FALLBACK_MAP.us;
      for (const [key, items] of Object.entries(map)) {
        if (normalized.includes(key) || key.includes(normalized)) {
          unique = items.map(item => ({
            symbol: item.symbol,
            shortname: item.name,
            longname: item.name,
            exchange: item.exchange,
          }));
          break;
        }
      }
    }

    res.json(unique.slice(0, 10));
  } catch (e) {
    console.error('Search routing failure:', e);
    res.json([]);
  }
});

// ✅ NEW: Historical Long-Term Growth ($1,000 invested)
// MUST BE PLACED ABOVE THE /:symbol ROUTE
router.get('/long-term-growth', limiter, async (req, res) => {
  let symbol = String(req.query.symbol || '').trim().toUpperCase();
  const market = String(req.query.market || 'us').toLowerCase();
  const amount = Number(req.query.amount) || 1000;

  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (market === 'sg' && !symbol.endsWith('.SI')) symbol += '.SI';

  try {
    // Fetch current price
    const { meta } = await fetchPricesRaw(symbol, Math.floor(Date.now() / 1000) - 90 * 86400);
    const currentPrice = meta.regularMarketPrice;
    if (!currentPrice) throw new Error('Could not determine current price');

    const periods = [1, 5, 10, 20, 30];
    const noDrip = [];
    const drip = [];

    for (const yearsAgo of periods) {
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - yearsAgo);
      const startEpoch = Math.floor(startDate.getTime() / 1000);

      // Fetch prices and dividends for the period
      const { timestamps, closes } = await fetchPricesRaw(symbol, startEpoch - 30 * 86400);
      const { dividends } = await fetchDividendsRaw(symbol, market);

      // Find price on or before startEpoch
      let buyPrice = null;
      for (let i = 0; i < timestamps.length; i++) {
        if (timestamps[i] <= startEpoch) buyPrice = closes[i];
        else break;
      }

      // FALLBACK: If no price exists for that exact epoch, use the earliest available price from the fetched history
      if (!buyPrice && closes.length > 0) {
        buyPrice = closes[0];
      }

      if (!buyPrice) {
        noDrip.push(null);
        drip.push(null);
        continue;
      }

      const sharesPurchased = amount / buyPrice;
      const noDripValue = sharesPurchased * currentPrice;

      // Simulate DRIP (Reinvest dividends at next trading day's close)
      let simulatedShares = sharesPurchased;
      const divs = dividends.filter(d => d.epoch > startEpoch);
      for (const d of divs) {
        const cashFromDiv = simulatedShares * d.amount;
        // Find next trading day's price
        let reinvestPrice = null;
        for (let i = 0; i < timestamps.length; i++) {
          if (timestamps[i] > d.epoch) {
            reinvestPrice = closes[i];
            break;
          }
        }
        if (reinvestPrice && reinvestPrice > 0) {
          simulatedShares += cashFromDiv / reinvestPrice;
        }
      }

      const dripValue = simulatedShares * currentPrice;
      noDrip.push(Math.round(noDripValue * 100) / 100);
      drip.push(Math.round(dripValue * 100) / 100);
    }

    res.json({
      currencySymbol: market === 'sg' ? 'S$' : '$',
      noDrip,
      drip
    });
  } catch (e) {
    console.error('Error fetching long-term growth:', e);
    res.status(500).json({ error: 'Failed to fetch long-term growth data' });
  }
});

// ---------- Get single stock ----------
router.get('/:symbol', limiter, async (req, res) => {
  const { symbol } = req.params;
  const market = String(req.query.market || 'us').toLowerCase();

  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  try {
    const data = await getStock(symbol.toUpperCase(), market);
    if (data.error || data.message) {
      return res.json({
        symbol: symbol.toUpperCase(),
        currency: market === 'sg' ? 'SGD' : 'USD',
        currencySymbol: market === 'sg' ? 'S$' : '$',
        name: '',
        totalDividend: 0,
        payoutCount: 0,
        byYear: [],
        message: data.message || 'No data found',
        currentPrice: null,
        currentYield: null,
        dividendCAGR: null,
        safetyScore: 'Caution',
        exchange: market === 'sg' ? 'SGX' : 'NASDAQ'
      });
    }
    res.json(data);
  } catch (e) {
    console.error('Stock detail error:', e);
    res.json({
      symbol: symbol.toUpperCase(),
      currency: market === 'sg' ? 'SGD' : 'USD',
      currencySymbol: market === 'sg' ? 'S$' : '$',
      name: '',
      totalDividend: 0,
      payoutCount: 0,
      byYear: [],
      message: e.message || 'Failed to fetch stock data',
      currentPrice: null,
      currentYield: null,
      dividendCAGR: null,
      safetyScore: 'Caution',
      exchange: market === 'sg' ? 'SGX' : 'NASDAQ'
    });
  }
});

// ---------- Batch ----------
router.post('/batch', limiter, async (req, res) => {
  const { symbols, market = 'us' } = req.body;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return res.status(400).json({ error: 'symbols array required' });
  }
  if (symbols.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 symbols per batch request' });
  }

  try {
    const results = await getBatchStocks(
      symbols.map(s => s.toUpperCase()),
      market
    );
    res.json(results);
  } catch (e) {
    res.json(symbols.map(s => ({ symbol: s, data: null, error: e.message })));
  }
});

// ---------- Top stocks ----------
router.get('/top/:market', limiter, async (req, res) => {
  const market = req.params.market || 'us';
  const type = req.query.type || 'stock';

  const where = { market };
  if (type !== 'all') where.type = type;

  try {
    const stocks = await Stock.findAll({
      where,
      order: [['currentYield', 'DESC']],
      limit: 30,
    });

    res.json(stocks.map(s => ({
      symbol: s.symbol,
      name: s.name || s.symbol,
      type: s.type,
      currentPrice: parseFloat(s.currentPrice) || 0,
      currentYield: parseFloat(s.currentYield) || 0,
      safetyScore: s.safetyScore || '—',
      payoutCount: s.payoutCount || 0,
      totalDividend: parseFloat(s.totalDividend) || 0,
      lastExDate: s.lastExDate,
    })));
  } catch (e) {
    console.error('Top stocks error:', e);
    res.json([]);
  }
});

module.exports = router;