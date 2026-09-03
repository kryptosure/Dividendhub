const express = require('express');
const router = express.Router();
const { fetchDividendsRaw, fetchPricesRaw, fetchSplitsRaw } = require('../services/yahooFinance');
const { round2, pct, isoOf, currencySymbol } = require('../utils/helpers');

// ---------- Portfolio calculator ----------
router.get('/calculate', async (req, res) => {
  let symbol = String(req.query.ticker || '').trim().toUpperCase();
  const qty = Number(req.query.quantity);
  const pd = String(req.query.purchaseDate || '').trim();
  const market = String(req.query.market || 'us').toLowerCase();

  // Validate inputs
  if (!symbol) return res.status(400).json({ error: 'ticker required' });
  if (market === 'sg' && !symbol.endsWith('.SI')) symbol += '.SI';
  if (!pd || !/^\d{4}-\d{2}-\d{2}$/.test(pd)) {
    return res.status(400).json({ error: 'purchaseDate must be YYYY-MM-DD' });
  }
  if (!isFinite(qty) || qty <= 0) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }

  const purchaseDate = new Date(pd + 'T00:00:00Z');
  if (isNaN(purchaseDate.getTime())) {
    return res.status(400).json({ error: 'invalid purchaseDate' });
  }
  if (purchaseDate > new Date()) {
    return res.status(422).json({ error: 'purchase date is in the future' });
  }
  const purchaseEpoch = Math.floor(purchaseDate.getTime() / 1000);

  try {
    // Fetch raw data
    const { currency, dividends } = await fetchDividendsRaw(symbol, market);
    const { meta, timestamps, closes } = await fetchPricesRaw(symbol, purchaseEpoch - 90 * 86400);
    const name = meta.longName || meta.shortName || '';
    const splits = await fetchSplitsRaw(symbol);

    // Find buy price (closest trading day on or before purchase date)
    let buyIdx = -1;
    for (let i = 0; i < timestamps.length; i++) {
      if (timestamps[i] <= purchaseEpoch) buyIdx = i;
      else break;
    }
    if (buyIdx < 0 || closes[buyIdx] == null) {
      return res.status(422).json({
        error: 'No price data on or before ' + pd + '. The stock may not have been listed then.'
      });
    }
    const buyPrice = closes[buyIdx];
    const buyDate = isoOf(timestamps[buyIdx]);

    // Current price
    let currentPrice = meta.regularMarketPrice;
    let currentPriceDate = meta.regularMarketTime ? isoOf(meta.regularMarketTime) : null;
    if (!isFinite(currentPrice) || currentPrice == null) {
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) {
          currentPrice = closes[i];
          currentPriceDate = isoOf(timestamps[i]);
          break;
        }
      }
    }
    if (!isFinite(currentPrice)) {
      return res.status(422).json({ error: 'Could not determine current price.' });
    }

    // Split adjustment
    const splitsAfter = splits.filter(s => s.epoch > purchaseEpoch);
    const cumFactorUpTo = (epoch) => {
      let f = 1;
      for (const s of splitsAfter) {
        if (s.epoch <= epoch) f *= s.ratio;
        else break;
      }
      return f;
    };
    const splitFactorNow = cumFactorUpTo(Math.floor(Date.now() / 1000));
    const sharesToday = qty * splitFactorNow;

    // Price history for next-day close (for DRIP)
    const px = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] != null) px.push({ t: timestamps[i], c: closes[i] });
    }
    const nextDayClose = (exEpoch) => {
      for (let i = 0; i < px.length; i++) {
        if (px[i].t > exEpoch) return px[i].c;
      }
      return null;
    };

    // Year-end closes for snapshots
    const yearEndClose = {};
    px.forEach(p => {
      const y = new Date(p.t * 1000).getUTCFullYear();
      yearEndClose[y] = { epoch: p.t, close: p.c };
    });

    // Dividends by year (only those after purchase)
    const byYearMap = {};
    let totalDividendCash = 0, count = 0, totalPerShare = 0;
    for (const d of dividends) {
      if (d.epoch <= purchaseEpoch) continue;
      const sharesAtEx = qty * cumFactorUpTo(d.epoch);
      const cash = d.amount * sharesAtEx;
      const y = new Date(d.epoch * 1000).getUTCFullYear();
      if (!byYearMap[y]) {
        byYearMap[y] = { year: y, perShare: 0, total: 0, count: 0, payouts: [] };
      }
      byYearMap[y].perShare += d.amount;
      byYearMap[y].total += cash;
      byYearMap[y].count += 1;
      byYearMap[y].payouts.push({
        date: isoOf(d.epoch),
        amount: d.amount,
        cash: round2(cash)
      });
      totalDividendCash += cash;
      count += 1;
      totalPerShare += d.amount;
    }

    const dividendByYear = Object.values(byYearMap).sort((a, b) => b.year - a.year);
    dividendByYear.forEach(y => {
      y.perShare = Math.round(y.perShare * 1e6) / 1e6;
      y.total = Math.round(y.total * 100) / 100;
      y.payouts.sort((a, b) => a.date < b.date ? -1 : 1);
    });

    // Basic gains
    const purchaseCost = buyPrice * qty;
    const currentValue = sharesToday * currentPrice;
    const capitalGain = currentValue - purchaseCost;
    const totalDividendGain = totalDividendCash;
    const netGain = capitalGain + totalDividendGain;
    const cur = currency || meta.currency || (market === 'sg' ? 'SGD' : 'USD');

    // DRIP simulation
    const events = [];
    for (const s of splitsAfter) {
      events.push({ epoch: s.epoch, type: 'split', ratio: s.ratio });
    }
    for (const d of dividends) {
      if (d.epoch > purchaseEpoch) {
        events.push({ epoch: d.epoch, type: 'div', amount: d.amount });
      }
    }
    events.sort((a, b) => a.epoch - b.epoch);

    const purchaseYear = new Date(purchaseEpoch * 1000).getUTCFullYear();
    const currentYearNow = new Date().getUTCFullYear();
    const years = [];
    for (let y = purchaseYear; y <= currentYearNow; y++) years.push(y);

    const snapPoints = years.map(y => {
      if (y === currentYearNow) {
        return { year: y, epoch: Math.floor(Date.now() / 1000), close: currentPrice };
      }
      const ye = yearEndClose[y];
      return ye ? { year: y, epoch: ye.epoch, close: ye.close } : null;
    }).filter(Boolean).sort((a, b) => a.epoch - b.epoch);

    let dripShares = qty, reinvestedTotal = 0, si = 0;
    const snapshots = {};
    for (let i = 0; i <= events.length; i++) {
      const evEpoch = i < events.length ? events[i].epoch : Infinity;
      while (si < snapPoints.length && snapPoints[si].epoch <= evEpoch) {
        const sp = snapPoints[si];
        snapshots[sp.year] = {
          shares: dripShares,
          value: Math.round(dripShares * sp.close * 100) / 100
        };
        si++;
      }
      if (i < events.length) {
        const ev = events[i];
        if (ev.type === 'split') {
          dripShares *= ev.ratio;
        } else {
          const cash = ev.amount * dripShares;
          const rp = nextDayClose(ev.epoch);
          if (rp && rp > 0) {
            dripShares += cash / rp;
            reinvestedTotal += cash;
          }
        }
      }
    }

    const finalValueWith = dripShares * currentPrice;
    const valueByYear = years.map(y => ({
      year: y,
      shares: Math.round((snapshots[y] ? snapshots[y].shares : qty) * 1e4) / 1e4,
      value: snapshots[y] ? snapshots[y].value : null
    }));

    const valueByYearNoReinvest = years.map(y => {
      const sp = (y === currentYearNow)
        ? { epoch: Math.floor(Date.now() / 1000), close: currentPrice }
        : (yearEndClose[y] || null);
      if (!sp) return { year: y, value: null };
      const shares = qty * cumFactorUpTo(sp.epoch);
      return { year: y, value: Math.round(shares * sp.close * 100) / 100 };
    });

    // Final response
    res.json({
      symbol,
      name,
      currency: cur,
      currencySymbol: currencySymbol(cur, market),
      quantity: qty,
      sharesToday: Math.round(sharesToday * 1e4) / 1e4,
      splitFactor: Math.round(splitFactorNow * 1e6) / 1e6,
      splits: splitsAfter.map(s => ({ date: isoOf(s.epoch), ratio: s.ratio })),
      purchaseDate: pd,
      buyDate,
      buyPrice: round2(buyPrice),
      currentPrice: round2(currentPrice),
      currentPriceDate,
      purchaseCost: round2(purchaseCost),
      currentValue: round2(currentValue),
      capitalGain: round2(capitalGain),
      capitalGainPct: pct(capitalGain, purchaseCost),
      totalDividendsPerShare: Math.round(totalPerShare * 1e6) / 1e6,
      totalDividendGain: round2(totalDividendGain),
      dividendCount: count,
      dividendByYear,
      netGain: round2(netGain),
      netGainPct: pct(netGain, purchaseCost),
      totalReturnPct: pct(netGain, purchaseCost),
      reinvest: {
        finalShares: Math.round(dripShares * 1e4) / 1e4,
        extraShares: Math.round((dripShares - qty) * 1e4) / 1e4,
        finalValue: round2(finalValueWith),
        extraValue: round2(finalValueWith - currentValue),
        totalReturnPct: pct(finalValueWith - purchaseCost, purchaseCost),
        totalDividendsReinvested: round2(reinvestedTotal),
        costBasis: round2(purchaseCost + reinvestedTotal),
        valueByYear,
        valueByYearNoReinvest
      },
      note: 'Assumes no stock splits or corporate actions between the purchase date and today. Dividends are per share as declared, multiplied by the quantity held since purchase. Buy price is the close on the last trading day on or before the purchase date; current price is the latest market price. The reinvestment scenario reinvests each dividend into the same stock at the next trading day\'s close (fractional shares allowed).'
    });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

module.exports = router;