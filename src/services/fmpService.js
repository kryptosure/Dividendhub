/* backend/src/services/fmpService.js
 * Payout ratio fetcher.
 *
 * Strategy:
 *   1. Yahoo Finance quoteSummary (financialData module) — primary source.
 *      Free, no signup, works for US + SGX.
 *   2. FMP /stable/ratios-ttm — secondary fallback for US stocks (only if
 *      you upgrade to a paid plan that includes ratios).
 *   3. Manual computation from dividendRate / trailingEps — last resort.
 *
 * Returns a percentage (e.g. 45.2) or null.
 */

const yahooFinance = require('yahoo-finance2');
const axios = require('axios');

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

// ---------- Yahoo (primary) ----------
async function fetchFromYahoo(symbol) {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ['financialData', 'summaryDetail'],
      validateResult: false,
    });

    const fd = result?.financialData || {};
    const sd = result?.summaryDetail || {};

    // Preferred: Yahoo's pre-computed payoutRatio (decimal, e.g. 0.45)
    if (typeof fd.payoutRatio === 'number' && isFinite(fd.payoutRatio) && fd.payoutRatio > 0) {
      return Math.round(fd.payoutRatio * 10000) / 100;
    }

    // Fallback: compute from dividendRate / trailingEps
    const dividendRate = fd.dividendRate ?? sd.dividendRate;
    const eps = fd.trailingEps ?? sd.trailingEps;
    if (dividendRate != null && eps != null && eps > 0) {
      return Math.round((dividendRate / eps) * 10000) / 100;
    }

    return null;
  } catch (err) {
    console.warn(`Yahoo payoutRatio failed for ${symbol}:`, err.message);
    return null;
  }
}

// ---------- FMP (secondary, US only) ----------
async function fetchFromFmp(symbol) {
  if (!FMP_API_KEY) return null;

  const cleanSymbol = String(symbol || '').toUpperCase().trim();
  if (!cleanSymbol || cleanSymbol.endsWith('.SI')) return null;

  try {
    const url = `${FMP_BASE_URL}/ratios-ttm?symbol=${encodeURIComponent(cleanSymbol)}&apikey=${FMP_API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });

    const row = Array.isArray(response.data) ? response.data[0] : response.data;
    if (!row) return null;

    const raw = row.dividendPayoutRatioTTM;
    if (raw == null || isNaN(raw)) return null;

    return Math.round(Number(raw) * 10000) / 100;
  } catch (err) {
    // Silent fail — this is just a fallback
    return null;
  }
}

// ---------- Public API ----------
async function fetchPayoutRatio(symbol) {
  const cleanSymbol = String(symbol || '').toUpperCase().trim();
  if (!cleanSymbol) return null;

  // Try Yahoo first
  const yahooValue = await fetchFromYahoo(cleanSymbol);
  if (yahooValue != null) return yahooValue;

  // Then FMP
  const fmpValue = await fetchFromFmp(cleanSymbol);
  if (fmpValue != null) return fmpValue;

  return null;
}

module.exports = { fetchPayoutRatio };