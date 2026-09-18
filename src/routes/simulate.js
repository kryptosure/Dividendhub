const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const Stock = require('../models/stock');
const { fetchDividendsRaw, fetchPricesRaw, fetchSplitsRaw } = require('../services/yahooFinance');
const { round2, pct, isoOf } = require('../utils/helpers');

// ============ HELPERS ============
function getFirstTradingDay(timestamps, year, month) {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 0));
  const startEpoch = Math.floor(monthStart.getTime() / 1000);
  const endEpoch = Math.floor(monthEnd.getTime() / 1000);
  for (const ts of timestamps) {
    if (ts >= startEpoch && ts <= endEpoch) return ts;
  }
  return null;
}

function findPriceAtOrBefore(timestamps, closes, targetEpoch) {
  let idx = -1;
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] <= targetEpoch) idx = i;
    else break;
  }
  if (idx < 0 || closes[idx] == null) return null;
  return { price: closes[idx], epoch: timestamps[idx] };
}

function findNextPrice(timestamps, closes, targetEpoch) {
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] > targetEpoch && closes[i] != null) {
      return { price: closes[i], epoch: timestamps[i] };
    }
  }
  return null;
}

// ============ MILLIONAIRE METRICS (reusable) ============
const PRICE_CAGR_CAP = 0.18;
const DIV_CAGR_CAP = 0.12;
const SIM_YIELD_CAP = 0.20;   // Used only for the projection math, not the displayed yield

async function getMillionaireMetrics(symbol, market) {
  let cleanSymbol = String(symbol || '').trim().toUpperCase();
  if (!cleanSymbol) throw new Error('symbol required');
  if (market === 'sg' && !cleanSymbol.endsWith('.SI')) cleanSymbol += '.SI';

  const nowEpoch = Math.floor(Date.now() / 1000);
  const fiveYearsAgo = nowEpoch - (5 * 365 * 86400);
  const { meta, timestamps, closes } = await fetchPricesRaw(cleanSymbol, fiveYearsAgo);

  let currentPrice = meta.regularMarketPrice;
  if (!currentPrice || isNaN(currentPrice)) {
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) { currentPrice = closes[i]; break; }
    }
  }
  if (!currentPrice) throw new Error('Could not determine current price');

  let priceCAGR = 0;
  if (timestamps.length > 0 && closes.length > 0) {
    let earliestPrice = null;
    for (let i = 0; i < closes.length; i++) {
      if (closes[i] != null) { earliestPrice = closes[i]; break; }
    }
    if (earliestPrice && earliestPrice > 0) {
      const yearsElapsed = (timestamps[timestamps.length - 1] - timestamps[0]) / (365 * 86400);
      if (yearsElapsed >= 1) {
        priceCAGR = Math.pow(currentPrice / earliestPrice, 1 / yearsElapsed) - 1;
        priceCAGR = Math.max(-0.10, Math.min(PRICE_CAGR_CAP, priceCAGR));
      }
    }
  }

  const { dividends } = await fetchDividendsRaw(cleanSymbol, market);
  let rawYield = 0;
  let dividendCAGR = 0;

  if (dividends.length > 0) {
    const oneYearAgo = nowEpoch - (365 * 86400);
    const recentDivs = dividends.filter(d => d.epoch > oneYearAgo);
    const trailingAnnualDiv = recentDivs.reduce((sum, d) => sum + d.amount, 0);
    rawYield = currentPrice > 0 ? (trailingAnnualDiv / currentPrice) : 0;

    const byYear = {};
    for (const d of dividends) {
      const y = new Date(d.epoch * 1000).getUTCFullYear();
      byYear[y] = (byYear[y] || 0) + d.amount;
    }
    const years = Object.keys(byYear).map(Number).sort((a, b) => a - b);
    if (years.length >= 2) {
      const latest = years[years.length - 1];
      const targetYear = Math.max(years[0], latest - 5);
      const startTotal = byYear[targetYear];
      const endTotal = byYear[latest];
      if (startTotal > 0 && endTotal > 0 && latest > targetYear) {
        dividendCAGR = Math.pow(endTotal / startTotal, 1 / (latest - targetYear)) - 1;
        dividendCAGR = Math.max(-0.10, Math.min(DIV_CAGR_CAP, dividendCAGR));
      }
    }
  }

  // Capped yield used only for the projection math, so absurd yields don't
  // produce "reached $1M in 3 months" outputs.
  const currentYield = Math.max(0, Math.min(SIM_YIELD_CAP, rawYield));

  // Look up the safety score so the frontend can flag risky yields.
  let safetyScore = 'Caution';
  try {
    const dbRow = await Stock.findByPk(cleanSymbol, { attributes: ['safetyScore'] });
    if (dbRow?.safetyScore) safetyScore = dbRow.safetyScore;
  } catch (e) { /* ignore — default to Caution */ }

  return {
    symbol: cleanSymbol,
    name: meta.longName || meta.shortName || cleanSymbol,
    currencySymbol: market === 'sg' ? 'S$' : market === 'ca' ? 'C$' : '$',
    currentPrice: round2(currentPrice),
    // ✅ rawYield: what the security actually pays right now (shown in the UI)
    rawYield: Math.round(rawYield * 10000) / 10000,
    // ✅ currentYield: capped value used by the client-side projection math
    currentYield: Math.round(currentYield * 10000) / 10000,
    safetyScore,
    priceCAGR: Math.round(priceCAGR * 10000) / 10000,
    dividendCAGR: Math.round(dividendCAGR * 10000) / 10000,
  };
}

// ============ DCA ROUTE ============
router.get('/dca', async (req, res) => {
  let symbol = String(req.query.ticker || '').trim().toUpperCase();
  const market = String(req.query.market || 'us').toLowerCase();
  const monthlyAmount = Number(req.query.amount);
  const startDateStr = String(req.query.startDate || '').trim();

  if (!symbol) return res.status(400).json({ error: 'ticker required' });
  if (market === 'sg' && !symbol.endsWith('.SI')) symbol += '.SI';
  if (!startDateStr || !/^\d{4}-\d{2}-\d{2}$/.test(startDateStr)) {
    return res.status(400).json({ error: 'startDate must be YYYY-MM-DD' });
  }
  if (!isFinite(monthlyAmount) || monthlyAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const startDate = new Date(startDateStr + 'T00:00:00Z');
  if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'invalid startDate' });
  const now = new Date();
  if (startDate > now) return res.status(422).json({ error: 'start date is in the future' });
  const startEpoch = Math.floor(startDate.getTime() / 1000);
  const nowEpoch = Math.floor(now.getTime() / 1000);

  try {
    const { dividends } = await fetchDividendsRaw(symbol, market);
    const { timestamps, closes } = await fetchPricesRaw(symbol, startEpoch - 30 * 86400);
    const splits = await fetchSplitsRaw(symbol);

    const schedule = [];
    let currentDate = new Date(startDate);
    currentDate.setUTCDate(1);
    while (currentDate <= now) {
      const year = currentDate.getUTCFullYear();
      const month = currentDate.getUTCMonth() + 1;
      const firstTradingEpoch = getFirstTradingDay(timestamps, year, month);
      if (firstTradingEpoch) {
        const priceInfo = findPriceAtOrBefore(timestamps, closes, firstTradingEpoch);
        if (priceInfo) {
          schedule.push({
            date: isoOf(firstTradingEpoch),
            epoch: firstTradingEpoch,
            amount: monthlyAmount,
            price: priceInfo.price,
            actualDate: isoOf(priceInfo.epoch),
          });
        }
      }
      currentDate.setUTCMonth(currentDate.getUTCMonth() + 1);
    }

    if (schedule.length === 0) {
      return res.status(422).json({ error: 'No trading days found.' });
    }

    const events = [];
    for (const inv of schedule) events.push({ epoch: inv.epoch, type: 'invest', data: inv });
    for (const d of dividends) events.push({ epoch: d.epoch, type: 'dividend', amount: d.amount });
    events.sort((a, b) => a.epoch - b.epoch);

    let sharesNoDRIP = 0;
    let sharesDRIP = 0;
    let totalInvested = 0;
    let totalDividendsNoDRIP = 0;
    let totalDividendsDRIP = 0;
    const scheduleWithShares = [];

    for (const ev of events) {
      if (ev.type === 'invest') {
        const price = ev.data.price;
        const amount = ev.data.amount;
        sharesNoDRIP += amount / price;
        sharesDRIP += amount / price;
        totalInvested += amount;
        scheduleWithShares.push({
          date: isoOf(ev.epoch),
          amount: amount,
          price: price,
          sharesNoDRIP: sharesNoDRIP,
          sharesDRIP: sharesDRIP,
        });
      } else if (ev.type === 'dividend') {
        const divAmount = ev.amount;
        const cashNoDRIP = sharesNoDRIP * divAmount;
        const cashDRIP = sharesDRIP * divAmount;
        totalDividendsNoDRIP += cashNoDRIP;
        totalDividendsDRIP += cashDRIP;
        const nextPriceInfo = findNextPrice(timestamps, closes, ev.epoch);
        if (nextPriceInfo && nextPriceInfo.price > 0) {
          const sharesBought = cashDRIP / nextPriceInfo.price;
          sharesDRIP += sharesBought;
        }
      }
    }

    let currentPrice = null;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) { currentPrice = closes[i]; break; }
    }
    if (currentPrice == null) {
      return res.status(422).json({ error: 'Could not determine current price.' });
    }

    const currentValueNoDRIP = sharesNoDRIP * currentPrice;
    const currentValueDRIP = sharesDRIP * currentPrice;

    res.json({
      symbol,
      market,
      totalInvested: round2(totalInvested),
      sharesNoDRIP: round2(sharesNoDRIP),
      currentValueNoDRIP: round2(currentValueNoDRIP),
      totalDividendsNoDRIP: round2(totalDividendsNoDRIP),
      sharesDRIP: round2(sharesDRIP),
      currentValueDRIP: round2(currentValueDRIP),
      totalDividendsDRIP: round2(totalDividendsDRIP),
      startDate: startDateStr,
      endDate: isoOf(nowEpoch),
      monthlyAmount,
      schedule: scheduleWithShares,
      splits: splits.map(s => ({ date: isoOf(s.epoch), ratio: s.ratio })),
      currentPrice: round2(currentPrice),
    });

  } catch (e) {
    console.error('DCA simulation error:', e);
    res.status(422).json({ error: e.message });
  }
});

// ============ MILLIONAIRE (single stock) ============
router.get('/millionaire/:symbol', async (req, res) => {
  const market = String(req.query.market || 'us').toLowerCase();
  try {
    const data = await getMillionaireMetrics(req.params.symbol, market);
    res.json(data);
  } catch (e) {
    console.error('Millionaire simulator error:', e);
    res.status(422).json({ error: e.message || 'Failed to fetch stock metrics' });
  }
});

// ============ MILLIONAIRE LEADERBOARD ============
const leaderboardCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

const LEADERBOARD_MIN_YIELD = 2;
const LEADERBOARD_MAX_YIELD = 8;
const LEADERBOARD_MIN_PAYOUTS = 8;

const LEADERBOARD_EXCLUDED = new Set([
  'TSYY', 'COYY', 'IOYY', 'QBY', 'RGYY', 'YSPY', 'MUYY', 'FIYY', 'CRY',
  'AMYY', 'XBTY', 'NVYY', 'TQQY', 'MSTY', 'CONY', 'ULTY', 'TSLY', 'NVDY',
  'YMAX', 'YMAG', 'SLTY', 'CHPY', 'GPTY', 'LFGY', 'XDTE', 'QDTE', 'RDTE',
  'MAGY', 'AAPW', 'NVW', 'TSLW', 'MSTW', 'PLTW', 'COIW', 'WDTE', 'SPYT',
  'QQQY', 'IWMY', 'GLDY', 'MST', 'QQQT', 'YBTC', 'BCCC', 'JMMF', 'YBST',
  'FEPI', 'AIPI', 'CEPI', 'WEEK', 'CRSH', 'DIPS', 'YQQQ', 'WNTR', 'PYPY',
  'SATA', 'CHAD', 'STRC',
  'AGNC', 'NLY', 'ORC', 'ARR', 'IVR', 'TWO', 'MFA', 'PMT', 'CIM', 'RITM', 'ABR', 'DX',
  'PDI', 'PTY', 'PCN', 'PCM', 'RCS', 'UTF', 'ETV', 'ETB', 'ETY', 'BDJ', 'HPI', 'HPF', 'HPS',
  'PSEC', 'OXLC', 'OCCI', 'GLAD', 'GAIN',
]);

router.get('/millionaire-leaderboard/:market', async (req, res) => {
  const market = String(req.params.market || 'us').toLowerCase();
  const cacheKey = market;
  const cached = leaderboardCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`📦 Leaderboard cache hit for ${market}`);
    return res.json(cached.data);
  }

  try {
    const topStocks = await Stock.findAll({
      where: {
        market,
        currentYield: { [Op.between]: [LEADERBOARD_MIN_YIELD, LEADERBOARD_MAX_YIELD] },
        safetyScore: { [Op.in]: ['Safe', 'Moderate'] },
        payoutCount: { [Op.gte]: LEADERBOARD_MIN_PAYOUTS },
        symbol: { [Op.notIn]: [...LEADERBOARD_EXCLUDED] },
      },
      order: [['currentYield', 'DESC']],
      limit: 15,
      attributes: ['symbol', 'name'],
    });

    if (topStocks.length === 0) {
      console.warn(`⚠️  Leaderboard for ${market} returned 0 stocks after quality filter`);
      return res.json({ stocks: [], market });
    }

    const results = await Promise.allSettled(
      topStocks.map(s => getMillionaireMetrics(s.symbol, market))
    );

    const stocks = results
      .filter(r => r.status === 'fulfilled' && r.value && r.value.currentPrice > 0)
      .map(r => r.value);

    const payload = { stocks, market, generatedAt: new Date().toISOString() };

    leaderboardCache.set(cacheKey, { timestamp: Date.now(), data: payload });

    console.log(`✅ Leaderboard generated for ${market}: ${stocks.length} quality stocks`);
    res.json(payload);
  } catch (e) {
    console.error('Leaderboard error:', e);
    res.status(500).json({ error: 'Failed to generate leaderboard' });
  }
});

module.exports = router;