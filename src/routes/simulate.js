const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const Stock = require('../models/stock');
const { fetchDividendsRaw, fetchPricesRaw, fetchSplitsRaw } = require('../services/yahooFinance');
const { round2, pct, isoOf } = require('../utils/helpers');
const { classifyAssetType } = require('../services/stockClassifier');

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

  const currentYield = Math.max(0, Math.min(SIM_YIELD_CAP, rawYield));

  let safetyScore = 'Caution';
  try {
    const dbRow = await Stock.findByPk(cleanSymbol, { attributes: ['safetyScore'] });
    if (dbRow?.safetyScore) safetyScore = dbRow.safetyScore;
  } catch (e) { /* default to Caution */ }

  return {
    symbol: cleanSymbol,
    name: meta.longName || meta.shortName || cleanSymbol,
    currencySymbol: market === 'sg' ? 'S$' : market === 'ca' ? 'C$' : '$',
    currentPrice: round2(currentPrice),
    rawYield: Math.round(rawYield * 10000) / 10000,
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
const LEADERBOARD_CANDIDATE_POOL = 50;
const LEADERBOARD_RETURN_COUNT = 15;

// Asset classes that don't compound. A "dividend compounder" must be an
// operating business whose dividend grows — not a fixed-income instrument.
const NON_COMPOUNDING_ASSET_TYPES = new Set(['Bond ETF', 'Preferred Stock']);

const LEADERBOARD_EXCLUDED = new Set([
  // Options-income ETFs — return of capital, NAV erosion
  'TSYY', 'COYY', 'IOYY', 'QBY', 'RGYY', 'YSPY', 'MUYY', 'FIYY', 'CRY',
  'AMYY', 'XBTY', 'NVYY', 'TQQY', 'MSTY', 'CONY', 'ULTY', 'TSLY', 'NVDY',
  'YMAX', 'YMAG', 'SLTY', 'CHPY', 'GPTY', 'LFGY', 'XDTE', 'QDTE', 'RDTE',
  'MAGY', 'AAPW', 'NVW', 'TSLW', 'MSTW', 'PLTW', 'COIW', 'WDTE', 'SPYT',
  'QQQY', 'IWMY', 'GLDY', 'MST', 'QQQT', 'YBTC', 'BCCC', 'JMMF', 'YBST',
  'FEPI', 'AIPI', 'CEPI', 'WEEK', 'CRSH', 'DIPS', 'YQQQ', 'WNTR', 'PYPY',
  // Daily preferred (crypto-backed)
  'SATA', 'CHAD', 'STRC',
  // Mortgage REITs — book value erosion in rate cycles
  'AGNC', 'NLY', 'ORC', 'ARR', 'IVR', 'TWO', 'MFA', 'PMT', 'CIM', 'RITM', 'ABR', 'DX',
  // Speculative CEFs — ROC-heavy distributions
  'PDI', 'PTY', 'PCN', 'PCM', 'RCS', 'UTF', 'ETV', 'ETB', 'ETY', 'BDJ', 'HPI', 'HPF', 'HPS',
  // High-risk BDCs
  'PSEC', 'OXLC', 'OCCI', 'GLAD', 'GAIN',
  // Bond ETFs
  'SJNK', 'SRLN', 'JNK', 'HYG', 'LQD', 'AGG', 'BND', 'TLT', 'IEF', 'SHY',
  'GOVT', 'SCHZ', 'SGOV', 'BIL', 'SPTL', 'SPTI', 'SPTS', 'SPIB', 'VGSH',
  'VGIT', 'VGLT', 'VCSH', 'VCIT', 'VCLT', 'USIG', 'IGIB', 'SHYG', 'HYLB',
  'ANGL', 'FALN', 'MUB', 'VTEB', 'TFI', 'BNDX', 'EMB', 'IEMB', 'IGOV',
  'BWX', 'VTIP', 'TIP', 'STIP', 'FLOT', 'FLRN', 'NEAR', 'JPST', 'MINT',
  // CEFs that have appeared
  'BME', 'BOE', 'BUI', 'EOI', 'EOS', 'ETG', 'ETJ', 'ETO', 'ETB', 'ETY',
]);

// Compounder score: what actually matters over a 40-year horizon.
// Weight dividend growth 2x because it compounds, while yield is a
// snapshot of today.
function compounderScore(metrics) {
  const yieldPct = metrics.rawYield * 100;
  const divCagrPct = metrics.dividendCAGR * 100;
  const priceCagrPct = metrics.priceCAGR * 100;
  return yieldPct + (divCagrPct * 2) + (priceCagrPct * 0.5);
}

router.get('/millionaire-leaderboard/:market', async (req, res) => {
  const market = String(req.params.market || 'us').toLowerCase();
  const cacheKey = market;
  const cached = leaderboardCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    console.log(`📦 Leaderboard cache hit for ${market}`);
    return res.json(cached.data);
  }

  try {
    // ---- Step 1: fetch a generous candidate pool ----
    const candidates = await Stock.findAll({
      where: {
        market,
        currentYield: { [Op.between]: [LEADERBOARD_MIN_YIELD, LEADERBOARD_MAX_YIELD] },
        safetyScore: { [Op.in]: ['Safe', 'Moderate'] },
        payoutCount: { [Op.gte]: LEADERBOARD_MIN_PAYOUTS },
        symbol: { [Op.notIn]: [...LEADERBOARD_EXCLUDED] },
      },
      order: [['currentYield', 'DESC']],
      limit: LEADERBOARD_CANDIDATE_POOL,
      attributes: ['symbol', 'name', 'type'],
    });

    if (candidates.length === 0) {
      console.warn(`⚠️  Leaderboard for ${market} returned 0 candidates`);
      return res.json({ stocks: [], market });
    }

    // ---- Step 2: compute metrics for each candidate ----
    const results = await Promise.allSettled(
      candidates.map(s => getMillionaireMetrics(s.symbol, market))
    );

    let enriched = results
      .filter(r => r.status === 'fulfilled' && r.value && r.value.currentPrice > 0)
      .map(r => r.value);

    // ---- Step 3: filter by asset class (drop bond ETFs / preferreds) ----
    enriched = enriched.filter(m => {
      const assetType = classifyAssetType(m.symbol, m.name);
      return !NON_COMPOUNDING_ASSET_TYPES.has(assetType);
    });

    // ---- Step 4: filter by growth quality ----
    enriched = enriched.filter(m => {
      const divCagrPct = m.dividendCAGR * 100;
      const priceCagrPct = m.priceCAGR * 100;
      if (divCagrPct < -1) return false;    // dividend must not be shrinking
      if (priceCagrPct < -5) return false;  // price must not be collapsing
      return true;
    });

    // ---- Step 5: rank by compounder score, take top N ----
    enriched.sort((a, b) => compounderScore(b) - compounderScore(a));
    const stocks = enriched.slice(0, LEADERBOARD_RETURN_COUNT);

    const payload = { stocks, market, generatedAt: new Date().toISOString() };

    leaderboardCache.set(cacheKey, { timestamp: Date.now(), data: payload });

    console.log(`✅ Leaderboard generated for ${market}: ${stocks.length} compounders (from ${candidates.length} candidates)`);
    res.json(payload);
  } catch (e) {
    console.error('Leaderboard error:', e);
    res.status(500).json({ error: 'Failed to generate leaderboard' });
  }
});

module.exports = router;