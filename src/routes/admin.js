const express = require('express');
const Stock = require('../models/stock');
const yahooFinance = require('yahoo-finance2');
const { refreshTopStocks } = require('../services/stockService');

const router = express.Router();

// ---------- Legacy: small curated refresh ----------
router.post('/refresh', async (req, res) => {
  try {
    const usSymbols = [
      'ZIM', 'MO', 'VZ', 'PFE', 'ABBV', 'T', 'IBM',
      'KMI', 'ET', 'MPW', 'VICI', 'F', 'NEE', 'DUK',
      'JPM', 'BAC', 'C', 'WFC', 'GS', 'MS',
      'PG', 'JNJ', 'MRK', 'KO', 'PEP', 'MCD', 'WMT'
    ];

    let updatedCount = 0;
    for (const symbol of usSymbols) {
      try {
        const quote = await yahooFinance.quote(symbol);
        const annualDividend = quote.trailingAnnualDividendRate || 0;
        const yield_ = quote.regularMarketPrice ? (annualDividend / quote.regularMarketPrice * 100) : 0;

        await Stock.upsert({
          symbol: symbol,
          name: quote.longName || quote.shortName || symbol,
          currentPrice: quote.regularMarketPrice || 0,
          market: 'US',
          currentYield: yield_,
          lastUpdated: new Date()
        });

        updatedCount++;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        console.error(`Error updating ${symbol}:`, err.message);
      }
    }

    res.json({
      success: true,
      message: `Updated ${updatedCount} US stocks`,
      updated: updatedCount
    });
  } catch (error) {
    console.error('Error refreshing stocks:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Full universe seed (background job) ----------
let seedInProgress = false;
let lastSeedResult = null;

router.post('/seed-universe', async (req, res) => {
  if (seedInProgress) {
    return res.status(409).json({ error: 'Seed already in progress', lastSeedResult });
  }

  const market = req.query.market || 'all';
  seedInProgress = true;
  lastSeedResult = null;

  (async () => {
    const startedAt = new Date().toISOString();
    try {
      console.log(`🌱 Seed starting: market=${market}`);
      const { getSeedList } = require('../services/stockUniverse');
      const lists = getSeedList();
      console.log(`📋 Seed list loaded: US=${lists.us.length}, SG=${lists.sg.length}`);

      const result = await refreshTopStocks(market === 'all' ? null : market);
      lastSeedResult = { ...result, startedAt, finishedAt: new Date().toISOString() };
      console.log(`✅ Seed complete:`, JSON.stringify(result));
    } catch (e) {
      console.error('❌ Seed failed with error:', e.message);
      console.error('Stack:', e.stack);
      lastSeedResult = { error: e.message, startedAt, finishedAt: new Date().toISOString() };
    } finally {
      seedInProgress = false;
    }
  })();

  res.json({
    success: true,
    message: 'Universe seed started in background. Check /api/admin/seed-status for progress.',
  });
});

router.get('/seed-status', async (req, res) => {
  const total = await Stock.count();
  res.json({
    inProgress: seedInProgress,
    lastResult: lastSeedResult,
    totalStocksInDB: total,
  });
});

module.exports = router;