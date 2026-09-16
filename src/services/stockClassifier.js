/* backend/src/services/stockClassifier.js
 * Classifies a stock into an asset type (Stock / REIT / ETF / Bond ETF)
 * and computes its dividend payout frequency from historical data.
 */

// ---------- Known bond ETFs (fixed income, not equity income) ----------
const BOND_ETF_TICKERS = new Set([
  // US
  'AGG', 'BND', 'TLT', 'IEF', 'SHY', 'LQD', 'HYG', 'JNK', 'MUB',
  'VCIT', 'VCSH', 'BIV', 'BSV', 'BLV', 'GOVT', 'SCHZ', 'FLOT',
  'USIG', 'IGIB', 'SPIB', 'SPSB', 'SPTI', 'SPTS', 'SPTL', 'EMB',
  'BNDX', 'VTIP', 'TIP', 'STIP', 'PFF', 'PGX', 'SJNK',
  // SGX bond/income ETFs
  'A35', 'O87', 'N6M', 'S27', 'M62', 'QL3', 'OVQ',
]);

// ---------- Known REIT tickers (fallback when name doesn't say "REIT") ----------
const KNOWN_REIT_TICKERS = new Set([
  // US
  'O', 'VICI', 'MPW', 'SPG', 'PLD', 'AMT', 'CCI', 'EQIX', 'PSA', 'EXR',
  'WELL', 'DLR', 'AVB', 'EQR', 'ESS', 'MAA', 'UDR', 'NNN', 'STAG', 'WPC',
  // SGX REITs
  'K71U', 'A17U', 'N2IU', 'C38U', 'M44U', 'H78', 'J36', 'T82U', 'AJBU',
  'C2PU', 'SK6U', 'ME8U', 'U14', 'AW9U', 'Q5T', 'C07', 'BUOU', 'CLR',
  'OXMU', 'BTOU', 'RW0U', 'TS0U', 'J91U', 'P40U', 'Y92', 'D5IU',
]);

// ---------- Known equity ETFs ----------
const KNOWN_ETF_TICKERS = new Set([
  'SPY', 'QQQ', 'VTI', 'VOO', 'IVV', 'IWM', 'DIA',
  'SCHD', 'VYM', 'VIG', 'DVY', 'HDV', 'SPHD', 'SDY', 'DGRO',
  'JEPI', 'JEPQ', 'QYLD', 'XYLD', 'RYLD', 'SPYI', 'DIVO',
  'XLK', 'XLF', 'XLE', 'XLI', 'XLV', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE',
  'ES3', 'G3B', 'CFA', 'ER7', 'NS8U', 'GRN', 'O87',
]);

// ---------- Asset type classification ----------
function classifyAssetType(symbol, name, typeField) {
  const clean = String(symbol || '').toUpperCase().replace(/\.SI$/, '').split('.')[0];
  const n = String(name || '').toLowerCase();

  // 1. Bond ETFs — fixed income, not equity dividends
  if (BOND_ETF_TICKERS.has(clean)) return 'Bond ETF';
  if (
    n.includes(' bond') ||
    n.includes('treasury') ||
    n.includes('fixed income') ||
    n.includes('aggregate bond') ||
    n.includes('total bond')
  ) {
    return 'Bond ETF';
  }

  // 2. REITs
  if (KNOWN_REIT_TICKERS.has(clean)) return 'REIT';
  if (
    n.includes('reit') ||
    n.includes('realty income') ||
    n.includes('real estate')
  ) {
    return 'REIT';
  }

  // 3. ETFs / Index funds
  if (typeField === 'etf') return 'ETF';
  if (KNOWN_ETF_TICKERS.has(clean)) return 'ETF';
  if (
    n.includes('etf') ||
    n.includes('index fund') ||
    n.includes('total stock') ||
    n.includes('s&p 500') ||
    n.includes('nasdaq')
  ) {
    return 'ETF';
  }

  // 4. Default
  return 'Stock';
}

// ---------- Frequency detection ----------
// Returns { label, paymentsPerYear, medianGapDays } or null if unknown.
function computeFrequency(byYear) {
  if (!Array.isArray(byYear) || byYear.length === 0) return null;

  const currentYear = new Date().getUTCFullYear();

  // Prefer the latest COMPLETE year (year < currentYear)
  const completeYears = byYear
    .filter(y => y.year < currentYear && Array.isArray(y.payouts) && y.payouts.length > 0)
    .sort((a, b) => b.year - a.year);

  let reference = completeYears[0];

  // Fall back to the latest year with at least 2 payouts
  if (!reference) {
    const fallback = byYear
      .filter(y => Array.isArray(y.payouts) && y.payouts.length >= 2)
      .sort((a, b) => b.year - a.year);
    reference = fallback[0];
  }

  if (!reference || !reference.payouts || reference.payouts.length === 0) return null;

  const payouts = [...reference.payouts].sort((a, b) => a.date.localeCompare(b.date));
  const count = payouts.length;

  // Only 1 payout ever — probably annual
  if (count === 1) {
    return { label: 'Annual', paymentsPerYear: 1, medianGapDays: 365 };
  }

  // Compute gaps in days between consecutive payouts
  const gaps = [];
  for (let i = 1; i < payouts.length; i++) {
    const d1 = new Date(payouts[i - 1].date + 'T00:00:00Z').getTime();
    const d2 = new Date(payouts[i].date + 'T00:00:00Z').getTime();
    const days = (d2 - d1) / (1000 * 60 * 60 * 24);
    if (days > 0 && days < 400) gaps.push(days);
  }

  if (gaps.length === 0) {
    return { label: 'Unknown', paymentsPerYear: count, medianGapDays: null };
  }

  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  let label;
  if (median < 3) label = 'Daily';
  else if (median < 10) label = 'Weekly';
  else if (median < 20) label = 'Bi-Weekly';
  else if (median < 45) label = 'Monthly';
  else if (median < 120) label = 'Quarterly';
  else if (median < 250) label = 'Semi-Annual';
  else label = 'Annual';

  const paymentsPerYear = median > 0 ? Math.round(365 / median) : count;

  return {
    label,
    paymentsPerYear,
    medianGapDays: Math.round(median * 10) / 10,
  };
}

// ---------- Sort order for frequency (lower = more frequent) ----------
const FREQUENCY_ORDER = {
  Daily: 0,
  Weekly: 1,
  'Bi-Weekly': 2,
  Monthly: 3,
  Quarterly: 4,
  'Semi-Annual': 5,
  Annual: 6,
  Unknown: 99,
};

module.exports = {
  classifyAssetType,
  computeFrequency,
  FREQUENCY_ORDER,
  BOND_ETF_TICKERS,
  KNOWN_REIT_TICKERS,
  KNOWN_ETF_TICKERS,
};