const express = require('express');
const router = express.Router();
const { fetchDividendsRaw, fetchPricesRaw, fetchSplitsRaw } = require('../services/yahooFinance');
const { round2, pct, isoOf } = require('../utils/helpers');

// Helper: first trading day of month
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

// ---------- Existing DCA route ----------
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

// ✅ NEW: Millionaire Simulator - returns stock metrics for client-side projection
router.get('/millionaire/:symbol', async (req, res) => {
  let symbol = String(req.params.symbol || '').trim().toUpperCase();
  const market = String(req.query.market || 'us').toLowerCase();

  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (market === 'sg' && !symbol.endsWith('.SI')) symbol += '.SI';

  try {
    // 1. Current price + 5 years of history in one call
    const nowEpoch = Math.floor(Date.now() / 1000);
    const fiveYearsAgo = nowEpoch - (5 * 365 * 86400);
    const { meta, timestamps, closes } = await fetchPricesRaw(symbol, fiveYearsAgo);

    let currentPrice = meta.regularMarketPrice;
    if (!currentPrice || isNaN(currentPrice)) {
      // Fallback to latest close
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) { currentPrice = closes[i]; break; }
      }
    }
    if (!currentPrice) throw new Error('Could not determine current price');

    // 2. Compute 5Y price CAGR
    let priceCAGR = 0;
    if (timestamps.length > 0 && closes.length > 0) {
      // Find price ~5 years ago (earliest available)
      let earliestPrice = null;
      for (let i = 0; i < closes.length; i++) {
        if (closes[i] != null) { earliestPrice = closes[i]; break; }
      }
      if (earliestPrice && earliestPrice > 0) {
        const yearsElapsed = (timestamps[timestamps.length - 1] - timestamps[0]) / (365 * 86400);
        if (yearsElapsed >= 1) {
          priceCAGR = Math.pow(currentPrice / earliestPrice, 1 / yearsElapsed) - 1;
          // Clamp to reasonable range (-10% to +30%) to avoid outliers
          priceCAGR = Math.max(-0.10, Math.min(0.30, priceCAGR));
        }
      }
    }

    // 3. Current yield and dividend CAGR
    const { dividends } = await fetchDividendsRaw(symbol, market);

    let currentYield = 0;
    let dividendCAGR = 0;

    if (dividends.length > 0) {
      const oneYearAgo = nowEpoch - (365 * 86400);
      const recentDivs = dividends.filter(d => d.epoch > oneYearAgo);
      const trailingAnnualDiv = recentDivs.reduce((sum, d) => sum + d.amount, 0);
      currentYield = currentPrice > 0 ? (trailingAnnualDiv / currentPrice) : 0;
      currentYield = Math.max(0, Math.min(0.20, currentYield)); // clamp 0-20%

      // Dividend CAGR over available history (up to 5y)
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
          dividendCAGR = Math.max(-0.10, Math.min(0.20, dividendCAGR)); // clamp
        }
      }
    }

    res.json({
      symbol,
      name: meta.longName || meta.shortName || symbol,
      currencySymbol: market === 'sg' ? 'S$' : '$',
      currentPrice: round2(currentPrice),
      currentYield: Math.round(currentYield * 10000) / 10000,
      priceCAGR: Math.round(priceCAGR * 10000) / 10000,
      dividendCAGR: Math.round(dividendCAGR * 10000) / 10000,
    });

  } catch (e) {
    console.error('Millionaire simulator error:', e);
    res.status(422).json({ error: e.message || 'Failed to fetch stock metrics' });
  }
});

module.exports = router;