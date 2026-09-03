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

// Helper: price at or before
function findPriceAtOrBefore(timestamps, closes, targetEpoch) {
  let idx = -1;
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] <= targetEpoch) idx = i;
    else break;
  }
  if (idx < 0 || closes[idx] == null) return null;
  return { price: closes[idx], epoch: timestamps[idx] };
}

// Helper: next price after
function findNextPrice(timestamps, closes, targetEpoch) {
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] > targetEpoch && closes[i] != null) {
      return { price: closes[i], epoch: timestamps[i] };
    }
  }
  return null;
}

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

    // Schedule: first trading day each month
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

    // Combine events (investments + dividends) – NO splits applied
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

module.exports = router;