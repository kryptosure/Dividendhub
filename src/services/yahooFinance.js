const { fetchJson, sleep, currencySymbol, round2, pct, isoOf } = require('../utils/helpers');
const yahooFinanceLib = require('yahoo-finance2');
const yahooFinance = yahooFinanceLib.default || yahooFinanceLib;

const UA = process.env.YAHOO_FINANCE_UA || 'Mozilla/5.0 (compatible; DividendHub/2.0)';

// ✅ FIX (CA): centralize market-aware defaults so Canada gets CAD/TSX
// instead of silently falling back to USD/NASDAQ.
function defaultCurrencyFor(market) {
  if (market === 'sg') return 'SGD';
  if (market === 'ca') return 'CAD';
  return 'USD';
}
function defaultExchangeFor(market) {
  if (market === 'sg') return 'SGX';
  if (market === 'ca') return 'TSX';
  return 'NASDAQ';
}

async function fetchDividendsRaw(symbol, market) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=0&period2=${now}&interval=1d&events=div`;
  const data = await fetchJson(url);
  const chart = data?.chart;
  if (!chart) return { currency: defaultCurrencyFor(market), dividends: [] };
  if (chart.error) throw new Error(chart.error.description || 'source error');
  const result = chart.result?.[0];
  if (!result) return { currency: defaultCurrencyFor(market), dividends: [] };
  // ✅ FIX (CA): use market-aware default rather than hardcoded USD
  const currency = result.meta?.currency || defaultCurrencyFor(market);
  const divs = result.events?.dividends || {};
  const out = [];
  for (const ts in divs) {
    const amt = Number(divs[ts].amount);
    if (!isFinite(amt)) continue;
    out.push({ epoch: Number(divs[ts].date), amount: amt });
  }
  return { currency, dividends: out };
}

async function resolveName(symbol, market) {
  try {
    // ✅ FIX (CA): strip any of .SI / .TO / .V before searching,
    // not just .SI.
    const query = symbol.replace(/\.(SI|TO|V)$/, '');
    const results = await yahooSearch(query, market);
    const match = results.find(r => r.symbol === symbol);
    return match?.longname || match?.shortname || symbol;
  } catch (e) {
    console.warn('Failed to resolve name for', symbol, e.message);
    return symbol;
  }
}

async function fetchPricesRaw(symbol, startEpoch) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${startEpoch}&period2=${now}&interval=1d&includeAdjustedClose=true`;
  const data = await fetchJson(url);
  const chart = data?.chart;
  if (!chart || chart.error || !chart.result?.length) throw new Error('No price data.');
  const r0 = chart.result[0];
  const meta = r0.meta || {};
  const ts = r0.timestamp || [];
  const quote = r0.indicators?.quote?.[0] || {};
  const closes = quote.close || [];
  return { meta, timestamps: ts, closes };
}

async function fetchEPSRaw(symbol) {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ['defaultKeyStatistics', 'financialData']
    });
    const stats = result.defaultKeyStatistics || {};
    const fin = result.financialData || {};
    return stats.trailingEps?.raw || stats.forwardEps?.raw || fin.trailingEps?.raw || null;
  } catch (e) {
    console.warn('Yahoo Finance quoteSummary failed for EPS:', symbol, e.message);
    return null;
  }
}

async function fetchSplitsRaw(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=0&period2=${now}&interval=1d&events=split`;
  const data = await fetchJson(url);
  const chart = data?.chart;
  if (!chart || chart.error || !chart.result?.length) return [];
  const ev = chart.result[0].events?.splits || {};
  const splits = Object.values(ev).map(s => ({
    epoch: s.date,
    ratio: (Number(s.numerator) || 1) / (Number(s.denominator) || 1)
  })).filter(s => isFinite(s.ratio) && s.ratio > 0);
  splits.sort((a, b) => a.epoch - b.epoch);
  return splits;
}

async function yahooSearch(q, market) {
  // ✅ FIX (CA): map market → Yahoo region code, and add a CA branch
  // that accepts TSX (.TO) and TSXV (.V) listings.
  const regionMap = { sg: 'SG', ca: 'CA', us: 'US' };
  const region = regionMap[market] || 'US';
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=24&newsCount=0&lang=en-US&region=${region}`;

  const data = await fetchJson(url);
  const quotes = data.quotes || [];

  let filtered;

  if (market === 'sg') {
    filtered = quotes.filter(x =>
      String(x.symbol || '').toUpperCase().endsWith('.SI') &&
      ['EQUITY', 'MUTUALFUND', 'ETF', 'TRUST'].includes(x.quoteType)
    );
  } else if (market === 'ca') {
    // ✅ NEW: TSX / TSXV listings only
    filtered = quotes.filter(x =>
      /\.(TO|V)$/i.test(String(x.symbol || '')) &&
      ['EQUITY', 'ETF', 'MUTUALFUND', 'TRUST'].includes(x.quoteType)
    );
  } else {
    filtered = quotes.filter(x =>
      ['EQUITY', 'ETF'].includes(x.quoteType) &&
      (x.exchange === 'NYQ' || x.exchange === 'NMS' || x.exchange === 'BATS' || x.exchange === 'PCX' || !String(x.symbol).includes(':'))
    );
  }

  return filtered.map(x => ({
    symbol: x.symbol,
    shortname: x.shortname || x.symbol,
    longname: x.longname || x.shortname || '',
    // ✅ FIX (CA): market-aware exchange fallback
    exchange: x.exchange || defaultExchangeFor(market)
  }));
}

// ================================================================
// ✅ Compute dividend metrics from a byYear array.
// (unchanged — kept as-is for completeness)
// ================================================================
function computeDividendMetrics(byYear) {
  const empty = { dividendCAGR: null, dividendFrequency: null, dividendStreak: 0, completeYears: [] };
  if (!Array.isArray(byYear) || byYear.length === 0) return empty;

  const currentYear = new Date().getUTCFullYear();

  const asc = [...byYear].sort((a, b) => a.year - b.year);
  const map = {};
  for (const y of asc) map[y.year] = y;

  const completeYears = asc
    .map(y => y.year)
    .filter(y => y < currentYear);

  // ---------- 5-Year CAGR (complete years only) ----------
  let dividendCAGR = null;
  if (completeYears.length >= 2) {
    const latestComplete = completeYears[completeYears.length - 1];
    const targetYear = latestComplete - 5;

    let startYear = completeYears[0];
    for (const y of completeYears) {
      if (y >= targetYear) { startYear = y; break; }
    }

    if (startYear < latestComplete) {
      const startTotal = map[startYear]?.total;
      const endTotal = map[latestComplete]?.total;
      if (startTotal > 0 && endTotal > 0) {
        const yearsDiff = latestComplete - startYear;
        if (yearsDiff > 0) {
          const raw = (Math.pow(endTotal / startTotal, 1 / yearsDiff) - 1) * 100;
          dividendCAGR = Math.round(raw * 100) / 100;
        }
      }
    }
  }

  // ---------- Frequency: mode of last 3 complete years ----------
  let dividendFrequency = null;
  if (completeYears.length > 0) {
    const last3 = completeYears.slice(-3);
    const counts = last3.map(y => map[y]?.count || 0).filter(c => c > 0);
    if (counts.length > 0) {
      const tally = {};
      for (const c of counts) tally[c] = (tally[c] || 0) + 1;
      let bestCount = 0, mode = null;
      for (const [count, freq] of Object.entries(tally)) {
        if (freq > bestCount) { bestCount = freq; mode = parseInt(count, 10); }
      }
      dividendFrequency = mode;
    }
  }

  // ---------- Streak: consecutive years of increase ----------
  let dividendStreak = 0;
  if (completeYears.length > 0) {
    dividendStreak = 1;
    for (let i = completeYears.length - 1; i > 0; i--) {
      const curYear = completeYears[i];
      const prevYear = completeYears[i - 1];
      if (curYear !== prevYear + 1) break;

      const cur = map[curYear]?.total || 0;
      const prev = map[prevYear]?.total || 0;
      if (cur >= prev && prev > 0) {
        dividendStreak++;
      } else {
        break;
      }
    }
  }

  return { dividendCAGR, dividendFrequency, dividendStreak, completeYears };
}

async function fetchDividendData(symbol, market) {
  // ✅ FIX (CA): single source of truth for market-aware defaults
  const defaultCcy = defaultCurrencyFor(market);
  const defaultExch = defaultExchangeFor(market);

  try {
    const { currency, dividends } = await fetchDividendsRaw(symbol, market);

    if (!dividends.length) {
      const ccy = currency || defaultCcy;
      return {
        symbol,
        currency: ccy,
        currencySymbol: currencySymbol(ccy, market),
        name: symbol,
        totalDividend: 0,
        payoutCount: 0,
        byYear: [],
        message: 'No dividend history found.',
        currentPrice: null,
        currentYield: null,
        dividendCAGR: null,
        dividendFrequency: null,
        dividendStreak: 0,
        payoutRatio: null,
        safetyScore: 'Caution',
        exchange: defaultExch,
      };
    }

    const byYearMap = {};
    let total = 0;
    for (const d of dividends) {
      const dt = new Date(d.epoch * 1000);
      const y = dt.getUTCFullYear();
      const iso = isoOf(d.epoch);
      if (!byYearMap[y]) byYearMap[y] = { year: y, total: 0, count: 0, payouts: [] };
      byYearMap[y].total += d.amount;
      byYearMap[y].count += 1;
      byYearMap[y].payouts.push({ date: iso, amount: d.amount });
      total += d.amount;
    }
    const byYear = Object.values(byYearMap).sort((a, b) => b.year - a.year);
    byYear.forEach(y => {
      y.payouts.sort((a, b) => (a.date < b.date ? -1 : 1));
      y.total = Math.round(y.total * 1e6) / 1e6;
    });

    const dates = dividends.map(d => isoOf(d.epoch)).sort();
    const name = await resolveName(symbol, market);

    const metrics = computeDividendMetrics(byYear);

    let currentPrice = null, currentYield = null, trailingAnnualDiv = 0;
    try {
      const priceData = await fetchPricesRaw(symbol, Math.floor(Date.now() / 1000) - 90 * 86400);
      const meta = priceData.meta || {};
      currentPrice = meta.regularMarketPrice;
      if (!currentPrice || isNaN(currentPrice)) {
        const closes = priceData.closes || [];
        for (let i = closes.length - 1; i >= 0; i--) {
          if (closes[i] != null) { currentPrice = closes[i]; break; }
        }
      }
      if (currentPrice && currentPrice > 0) {
        const now = Math.floor(Date.now() / 1000);
        const oneYearAgo = now - 365 * 86400;
        const recentDivs = dividends.filter(d => d.epoch > oneYearAgo);
        trailingAnnualDiv = recentDivs.reduce((sum, d) => sum + d.amount, 0);
        currentYield = (trailingAnnualDiv / currentPrice) * 100;
        currentYield = Math.round(currentYield * 100) / 100;
      }
    } catch (e) { /* skip */ }

    // ---------- Safety score (unchanged) ----------
    let safetyScore = 'Caution';
    let payoutRatio = null;
    try {
      const years = Object.keys(byYearMap).map(Number).sort((a, b) => a - b);
      let maxStreak = 1;
      if (years.length > 0) {
        let currentStreak = 1;
        for (let i = 1; i < years.length; i++) {
          if (years[i] === years[i - 1] + 1) {
            currentStreak++;
            maxStreak = Math.max(maxStreak, currentStreak);
          } else {
            currentStreak = 1;
          }
        }
      }
      const divs = years.map(y => byYearMap[y].total);
      const avgDiv = divs.length ? divs.reduce((a, b) => a + b, 0) / divs.length : 0;
      let cv = 99;
      if (avgDiv > 0) {
        const variance = divs.reduce((a, b) => a + (b - avgDiv) ** 2, 0) / divs.length;
        const stdDev = Math.sqrt(variance);
        cv = stdDev / avgDiv;
      }
      let score = 0;
      if (maxStreak > 10) score += 2;
      else if (maxStreak > 5) score += 1;
      if (years.length > 10) score += 1;
      if (cv < 0.3) score += 1;
      if (years.length > 5 && maxStreak > 3) score += 1;
      try {
        const eps = await fetchEPSRaw(symbol);
        if (eps && eps > 0 && trailingAnnualDiv > 0) {
          payoutRatio = (trailingAnnualDiv / eps) * 100;
          if (payoutRatio < 70) score += 2;
          else if (payoutRatio < 90) score += 1;
          if (payoutRatio > 0 && payoutRatio < 100) score += 1;
        }
      } catch (e) { /* ignore */ }
      if (score >= 5) safetyScore = 'Safe';
      else if (score >= 3) safetyScore = 'Moderate';
    } catch (e) { /* ignore */ }

    const ccy = currency || defaultCcy;

    return {
      symbol,
      name,
      currency: ccy,
      currencySymbol: currencySymbol(ccy, market),
      totalDividend: Math.round(total * 1e6) / 1e6,
      payoutCount: dividends.length,
      firstExDate: dates[0] || null,
      lastExDate: dates[dates.length - 1] || null,
      byYear,
      currentPrice: currentPrice ? round2(currentPrice) : null,
      currentYield,
      dividendCAGR: metrics.dividendCAGR,
      dividendFrequency: metrics.dividendFrequency,
      dividendStreak: metrics.dividendStreak,
      trailingAnnualDiv,
      payoutRatio: payoutRatio ? Math.round(payoutRatio * 100) / 100 : null,
      safetyScore,
      exchange: defaultExch,
    };
  } catch (e) {
    console.error('fetchDividendData error:', e);
    const ccy = defaultCcy;
    return {
      symbol,
      currency: ccy,
      currencySymbol: currencySymbol(ccy, market),
      name: symbol,
      totalDividend: 0,
      payoutCount: 0,
      byYear: [],
      message: e.message || 'Failed to fetch dividend data',
      currentPrice: null,
      currentYield: null,
      dividendCAGR: null,
      dividendFrequency: null,
      dividendStreak: 0,
      payoutRatio: null,
      safetyScore: 'Caution',
      exchange: defaultExch,
    };
  }
}

module.exports = {
  fetchDividendData,
  fetchDividendsRaw,
  fetchPricesRaw,
  fetchEPSRaw,
  fetchSplitsRaw,
  resolveName,
  yahooSearch,
  computeDividendMetrics,
};