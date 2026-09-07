const { fetchJson, sleep, currencySymbol, round2, pct, isoOf } = require('../utils/helpers');
const yahooFinance = require('yahoo-finance2'); 

const UA = process.env.YAHOO_FINANCE_UA || 'Mozilla/5.0 (compatible; DividendHub/2.0)';

async function fetchDividendsRaw(symbol, market) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=0&period2=${now}&interval=1d&events=div`;
  const data = await fetchJson(url);
  const chart = data?.chart;
  if (!chart) return { currency: 'USD', dividends: [] };
  if (chart.error) throw new Error(chart.error.description || 'source error');
  const result = chart.result?.[0];
  if (!result) return { currency: 'USD', dividends: [] };
  const currency = result.meta?.currency || (market === 'sg' ? 'SGD' : 'USD');
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
    const results = await yahooSearch(symbol.replace('.SI', ''), market);
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
  const region = market === 'sg' ? 'SG' : 'US';
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=24&newsCount=0&lang=en-US&region=${region}`;
  
  const data = await fetchJson(url);
  const quotes = data.quotes || [];
  
  let filtered;
  
  if (market === 'sg') {
    filtered = quotes.filter(x => 
      String(x.symbol || '').toUpperCase().endsWith('.SI') && 
      ['EQUITY', 'MUTUALFUND', 'ETF', 'TRUST'].includes(x.quoteType)
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
    exchange: x.exchange || (market === 'sg' ? 'SGX' : 'NASDAQ')
  }));
}

async function fetchDividendData(symbol, market) {
  try {
    const { currency, dividends } = await fetchDividendsRaw(symbol, market);
    let payoutRatio = null;

    if (!dividends.length) {
      return { symbol, currency: currency || (market === 'sg' ? 'SGD' : 'USD'), currencySymbol: currencySymbol(currency || 'USD', market), name: symbol, totalDividend: 0, payoutCount: 0, byYear: [], message: 'No dividend history found.', currentPrice: null, currentYield: null, dividendCAGR: null, payoutRatio: null, safetyScore: 'Caution', exchange: market === 'sg' ? 'SGX' : 'NASDAQ' };
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
      y.payouts.sort((a, b) => a.date < b.date ? -1 : 1);
      y.total = Math.round(y.total * 1e6) / 1e6;
    });
    const dates = dividends.map(d => isoOf(d.epoch)).sort();
    const name = await resolveName(symbol, market);

    let currentPrice = null, currentYield = null, dividendCAGR = null, trailingAnnualDiv = 0;
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

    try {
      const years = Object.keys(byYearMap).map(Number).sort((a, b) => a - b);
      if (years.length >= 2) {
        const latestYear = years[years.length - 1];
        const targetYear = latestYear - 5;
        let startYear = years[0];
        for (const y of years) {
          if (y >= targetYear) { startYear = y; break; }
        }
        if (startYear < latestYear) {
          const startTotal = byYearMap[startYear].total;
          const endTotal = byYearMap[latestYear].total;
          if (startTotal > 0 && endTotal > 0) {
            const yearsDiff = latestYear - startYear;
            if (yearsDiff > 0) {
              dividendCAGR = (Math.pow(endTotal / startTotal, 1 / yearsDiff) - 1) * 100;
              dividendCAGR = Math.round(dividendCAGR * 100) / 100;
            }
          }
        }
      }
    } catch (e) { /* skip */ }

    let safetyScore = 'Caution';
    try {
      const years = Object.keys(byYearMap).map(Number).sort((a,b)=>a-b);
      let maxStreak = 1;
      if (years.length > 0) {
        let currentStreak = 1;
        for (let i = 1; i < years.length; i++) {
          if (years[i] === years[i-1] + 1) {
            currentStreak++;
            maxStreak = Math.max(maxStreak, currentStreak);
          } else {
            currentStreak = 1;
          }
        }
      }
      const divs = years.map(y => byYearMap[y].total);
      const avgDiv = divs.length ? divs.reduce((a,b) => a+b, 0) / divs.length : 0;
      let cv = 99;
      if (avgDiv > 0) {
        const variance = divs.reduce((a,b) => a + (b-avgDiv)**2, 0) / divs.length;
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

    return { symbol, name, currency: currency || 'USD', currencySymbol: currencySymbol(currency || 'USD', market), totalDividend: Math.round(total * 1e6) / 1e6, payoutCount: dividends.length, firstExDate: dates[0] || null, lastExDate: dates[dates.length - 1] || null, byYear, currentPrice: currentPrice ? round2(currentPrice) : null, currentYield, dividendCAGR, trailingAnnualDiv, payoutRatio: payoutRatio ? Math.round(payoutRatio * 100) / 100 : null, safetyScore, exchange: market === 'sg' ? 'SGX' : 'NASDAQ' };
  } catch (e) {
    console.error('fetchDividendData error:', e);
    return { symbol, currency: market === 'sg' ? 'SGD' : 'USD', currencySymbol: market === 'sg' ? 'S$' : '$', name: symbol, totalDividend: 0, payoutCount: 0, byYear: [], message: e.message || 'Failed to fetch dividend data', currentPrice: null, currentYield: null, dividendCAGR: null, payoutRatio: null, safetyScore: 'Caution', exchange: market === 'sg' ? 'SGX' : 'NASDAQ' };
  }
}

module.exports = { fetchDividendData, fetchDividendsRaw, fetchPricesRaw, fetchEPSRaw, fetchSplitsRaw, resolveName, yahooSearch };