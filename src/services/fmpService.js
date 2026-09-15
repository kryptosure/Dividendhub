/* backend/src/services/fmpService.js
 * Fetches the TTM dividend payout ratio from Financial Modeling Prep.
 * Falls back to null gracefully so the app never breaks if FMP is down or rate-limited.
 */

const axios = require('axios');

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

/**
 * Fetch the TTM payout ratio for a symbol.
 * @param {string} symbol - e.g. "AAPL" or "D05.SI"
 * @returns {Promise<number|null>} - Percentage (e.g. 45.2) or null
 */
async function fetchPayoutRatio(symbol) {
  if (!FMP_API_KEY) {
    console.warn('⚠️ FMP_API_KEY not set — skipping payout ratio fetch');
    return null;
  }

  // FMP uses bare tickers for US stocks. For SGX, strip the ".SI" suffix.
  const cleanSymbol = String(symbol || '').toUpperCase().replace(/\.SI$/, '').trim();
  if (!cleanSymbol) return null;

  try {
    const url = `${FMP_BASE_URL}/ratios-ttm/${encodeURIComponent(cleanSymbol)}?apikey=${FMP_API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });

    const row = Array.isArray(response.data) ? response.data[0] : null;
    if (!row) return null;

    // FMP returns dividendPayoutRatioTTM as a decimal (0.45 = 45%)
    const raw = row.dividendPayoutRatioTTM;
    if (raw == null || isNaN(raw)) return null;

    // Convert to percentage, round to 2 decimals
    return Math.round(Number(raw) * 10000) / 100;
  } catch (err) {
    // Don't crash the app — log and move on
    console.warn(`FMP payout fetch failed for ${symbol}:`, err.response?.data?.message || err.message);
    return null;
  }
}

module.exports = { fetchPayoutRatio };