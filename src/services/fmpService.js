/* backend/src/services/fmpService.js
 * Fetches the TTM dividend payout ratio from Financial Modeling Prep.
 *
 * IMPORTANT: FMP retired their /api/v3/ endpoints on 2025-08-31.
 * New signups MUST use /stable/ endpoints. This file uses /stable/ratios-ttm.
 *
 * FMP free tier only covers US-listed companies. SGX symbols are skipped.
 */

const axios = require('axios');

const FMP_API_KEY = process.env.FMP_API_KEY;
const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

/**
 * Fetch the TTM payout ratio for a US-listed symbol.
 * @param {string} symbol - e.g. "AAPL"
 * @returns {Promise<number|null>} - Percentage (e.g. 45.2) or null
 */
async function fetchPayoutRatio(symbol) {
  if (!FMP_API_KEY) {
    console.warn('⚠️ FMP_API_KEY not set — skipping payout ratio fetch');
    return null;
  }

  const cleanSymbol = String(symbol || '').toUpperCase().trim();
  if (!cleanSymbol) return null;

  // ✅ FMP free tier does not cover SGX. Skip silently to save quota.
  if (cleanSymbol.endsWith('.SI')) {
    return null;
  }

  try {
    const url = `${FMP_BASE_URL}/ratios-ttm?symbol=${encodeURIComponent(cleanSymbol)}&apikey=${FMP_API_KEY}`;
    const response = await axios.get(url, { timeout: 10000 });

    // /stable/ratios-ttm returns an object, not an array
    const row = response.data;
    if (!row || Array.isArray(row)) return null;

    // FMP returns dividendPayoutRatioTTM as a decimal (0.45 = 45%)
    const raw = row.dividendPayoutRatioTTM;
    if (raw == null || isNaN(raw)) return null;

    // Convert to percentage, round to 2 decimals
    return Math.round(Number(raw) * 10000) / 100;
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.['Error Message'] || err.response?.data?.message || err.message;

    // Suppress noisy 403s for the free tier — they're expected for some symbols
    if (status === 403) {
      console.warn(`FMP ${cleanSymbol}: not available on free tier (403)`);
    } else {
      console.warn(`FMP payout fetch failed for ${cleanSymbol} (${status || 'network'}):`, msg);
    }
    return null;
  }
}

module.exports = { fetchPayoutRatio };