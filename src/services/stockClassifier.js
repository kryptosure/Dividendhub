/* backend/src/services/stockClassifier.js */

const { getCategoryMap } = require('./stockUniverse');

const BOND_ETF_TICKERS = new Set([
  'AGG', 'BND', 'TLT', 'IEF', 'SHY', 'LQD', 'HYG', 'JNK', 'MUB',
  'VCIT', 'VCSH', 'BIV', 'BSV', 'BLV', 'GOVT', 'SCHZ', 'FLOT',
  'USIG', 'IGIB', 'SPIB', 'SPSB', 'SPTI', 'SPTS', 'SPTL', 'EMB',
  'BNDX', 'VTIP', 'TIP', 'STIP', 'PFF', 'PGX', 'SGOV',
  'A35', 'O87', 'N6M', 'S27', 'M62', 'QL3', 'OVQ',
]);

const KNOWN_REIT_TICKERS = new Set([
  'O', 'VICI', 'SPG', 'PLD', 'AMT', 'CCI', 'EQIX', 'PSA', 'EXR',
  'WELL', 'DLR', 'AVB', 'EQR', 'ESS', 'MAA', 'UDR', 'NNN', 'STAG', 'WPC',
  'K71U', 'A17U', 'N2IU', 'C38U', 'M44U', 'H78', 'J36', 'T82U', 'AJBU',
  'C2PU', 'SK6U', 'ME8U', 'U14', 'AW9U', 'Q5T', 'C07', 'BUOU', 'CLR',
  'OXMU', 'BTOU', 'RW0U', 'TS0U', 'J91U', 'P40U', 'Y92', 'D5IU',
]);

const KNOWN_ETF_TICKERS = new Set([
  'SPY', 'QQQ', 'VTI', 'VOO', 'IVV', 'IWM', 'DIA',
  'SCHD', 'VYM', 'VIG', 'DVY', 'HDV', 'SPHD', 'SDY', 'DGRO',
  'JEPI', 'JEPQ', 'QYLD', 'XYLD', 'RYLD', 'SPYI', 'DIVO',
  'XLK', 'XLF', 'XLE', 'XLI', 'XLV', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE',
  'ES3', 'G3B', 'CFA', 'ER7', 'NS8U', 'GRN',
]);

const PREFERRED_STOCK_TICKERS = new Set([
  'SATA', 'STRC', 'BMNP', 'CHAD',
]);

let _categoryMap = null;
function categoryMap() {
  if (!_categoryMap) _categoryMap = getCategoryMap();
  return _categoryMap;
}

// ✅ FIX (CA): strip exchange suffixes (.SI, .TO, .V, .NS, .BO, .L) AND
// trust-unit markers (.UN / -UN) so Canadian symbols like SRU.UN.TO
// resolve down to their base ticker, matching the KNOWN_* sets and
// the category map's US/SG keys.
function cleanSymbol(symbol) {
  return String(symbol || '')
    .toUpperCase()
    .replace(/\.(SI|TO|V|NS|BO|L)$/, '')
    .replace(/[.-]UN$/, '')
    .split('.')[0];
}

function classifyAssetType(symbol, name, typeField) {
  const upper = String(symbol || '').toUpperCase();
  const clean = cleanSymbol(symbol);
  const n = String(name || '').toLowerCase();

  // ✅ FIX (CA): try full symbol first (Canada map uses full-symbol keys
  // like 'SRU.UN.TO'), then fall back to the cleaned base symbol for
  // US / SG where the map is keyed by plain ticker.
  const mapped = categoryMap()[upper] || categoryMap()[clean];
  if (mapped) return mapped;

  if (PREFERRED_STOCK_TICKERS.has(clean)) return 'Preferred Stock';
  if (n.includes('preferred stock') || n.includes('perpetual preferred')) return 'Preferred Stock';

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

  if (KNOWN_REIT_TICKERS.has(clean)) return 'REIT';
  if (
    n.includes('reit') ||
    n.includes('realty income') ||
    n.includes('real estate')
  ) {
    return 'REIT';
  }

  if (typeField === 'etf') return 'ETF';
  if (KNOWN_ETF_TICKERS.has(clean)) return 'ETF';
  if (/\betf\b/.test(n) || n.includes('index fund')) return 'ETF';

  return 'Stock';
}

function computeFrequency(byYear) {
  if (!Array.isArray(byYear) || byYear.length === 0) return null;

  const currentYear = new Date().getUTCFullYear();

  const completeYears = byYear
    .filter(y => y.year < currentYear && Array.isArray(y.payouts) && y.payouts.length > 0)
    .sort((a, b) => b.year - a.year);

  let reference = completeYears[0];
  if (!reference) {
    const fallback = byYear
      .filter(y => Array.isArray(y.payouts) && y.payouts.length >= 2)
      .sort((a, b) => b.year - a.year);
    reference = fallback[0];
  }
  if (!reference || !reference.payouts || reference.payouts.length === 0) return null;

  const payouts = [...reference.payouts].sort((a, b) => a.date.localeCompare(b.date));
  const count = payouts.length;

  if (count === 1) return { label: 'Annual', paymentsPerYear: 1, medianGapDays: 365 };

  const gaps = [];
  for (let i = 1; i < payouts.length; i++) {
    const d1 = new Date(payouts[i - 1].date + 'T00:00:00Z').getTime();
    const d2 = new Date(payouts[i].date + 'T00:00:00Z').getTime();
    const days = (d2 - d1) / (1000 * 60 * 60 * 24);
    if (days > 0 && days < 400) gaps.push(days);
  }

  if (gaps.length === 0) return { label: 'Unknown', paymentsPerYear: count, medianGapDays: null };

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

  return {
    label,
    paymentsPerYear: median > 0 ? Math.round(365 / median) : count,
    medianGapDays: Math.round(median * 10) / 10,
  };
}

const FREQUENCY_ORDER = {
  Daily: 0, Weekly: 1, 'Bi-Weekly': 2, Monthly: 3,
  Quarterly: 4, 'Semi-Annual': 5, Annual: 6, Unknown: 99,
};

module.exports = {
  classifyAssetType,
  computeFrequency,
  FREQUENCY_ORDER,
  BOND_ETF_TICKERS,
  KNOWN_REIT_TICKERS,
  KNOWN_ETF_TICKERS,
};