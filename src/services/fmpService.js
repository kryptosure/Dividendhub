/* backend/src/services/fmpService.js
 * Payout ratio fetcher.
 *
 * Strategy (in order):
 *   1. Yahoo quoteSummary → financialData.payoutRatio (pre-computed decimal)
 *   2. Yahoo quoteSummary → dividendRate / trailingEps (compute ourselves)
 *   3. Yahoo quoteSummary → dividendRate / defaultKeyStatistics.trailingEps
 *      (alternate EPS location — sometimes financialData doesn't have it)
 *   4. FMP /stable/ratios-ttm (US-listed only, requires paid tier for ratios)
 *   5. null
 *
 * Returns a percentage (e.g. 45.2) or null.
 */

const YahooFinance = require('yahoo-finance2').default;
const axios = require('axios');

// ✅ v3: instantiate the class once at module load
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
});

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

// ---------- Yahoo (primary) ----------
async function fetchFromYahoo(symbol) {
  try {
    const result = await yahooFinance.quoteSummary(symbol, {
      modules: ['financialData', 'summaryDetail', 'defaultKeyStatistics'],
      validateResult: false,
    });

    const fd = result?.financialData || {};
    const sd = result?.summaryDetail || {};
    const ks = result?.defaultKeyStatistics || {};

    // ---------- 1. Pre-computed payoutRatio (decimal, e.g. 0.45) ----------
    if (typeof fd.payoutRatio === 'number' && isFinite(fd.payoutRatio) && fd.payoutRatio > 0) {
      return Math.round(fd.payoutRatio * 10000) / 100;
    }

    // ---------- 2. Compute from dividendRate / EPS ----------
    const dividendRate =
      fd.dividendRate ??
      sd.dividendRate ??
      null;

    // Try financialData.trailingEps first, then defaultKeyStatistics.trailingEps
    const epsCandidates = [
      fd.trailingEps,
      ks.trailingEps,
      fd.forwardEps,   // last resort — forward EPS
    ];

    for (const eps of epsCandidates) {
      if (eps != null && isFinite(eps) && Number(eps) > 0 && dividendRate != null) {
        const ratio = (Number(dividendRate) / Number(eps)) * 100;
        return Math.round(ratio * 100) / 100;
      }
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

  const yahooValue = await fetchFromYahoo(cleanSymbol);
  if (yahooValue != null) return yahooValue;

  const fmpValue = await fetchFromFmp(cleanSymbol);
  if (fmpValue != null) return fmpValue;

  return null;
}

module.exports = { fetchPayoutRatio };