/* backend/src/services/incomePlanner.js
 * Sample portfolio generator.
 *
 * NOT investment advice. Educational tool only.
 */

const Stock = require('../models/stock');

// ---------- Sector map (fallback when Yahoo doesn't provide one) ----------
const SECTOR_MAP = {
  // Consumer Staples
  KO: 'Consumer Staples', PEP: 'Consumer Staples', MO: 'Consumer Staples',
  KHC: 'Consumer Staples', PG: 'Consumer Staples', WMT: 'Consumer Staples',
  F34: 'Consumer Staples',
  // Healthcare
  JNJ: 'Healthcare', PFE: 'Healthcare', ABBV: 'Healthcare', MRK: 'Healthcare',
  // Communication Services
  VZ: 'Communication Services', T: 'Communication Services', Z74: 'Communication Services',
  // Financials
  JPM: 'Financials', BAC: 'Financials', WFC: 'Financials', C: 'Financials',
  GS: 'Financials', MS: 'Financials',
  D05: 'Financials', O39: 'Financials', U11: 'Financials', S68: 'Financials',
  // Energy
  XOM: 'Energy', CVX: 'Energy', KMI: 'Energy', ET: 'Energy',
  // Utilities
  NEE: 'Utilities', DUK: 'Utilities',
  // Technology
  IBM: 'Technology', MSFT: 'Technology', AAPL: 'Technology', NVDA: 'Technology',
  // Consumer Discretionary
  MCD: 'Consumer Discretionary', HD: 'Consumer Discretionary', F: 'Consumer Discretionary',
  // Industrials
  ZIM: 'Industrials', C6L: 'Industrials', BN4: 'Industrials', S63: 'Industrials',
  C52: 'Industrials',
  // Real Estate (REITs + property)
  MPW: 'Real Estate', VICI: 'Real Estate',
  K71U: 'Real Estate', A17U: 'Real Estate', N2IU: 'Real Estate',
  C38U: 'Real Estate', M44U: 'Real Estate', H78: 'Real Estate',
  J36: 'Real Estate', T82U: 'Real Estate', AJBU: 'Real Estate',
  // Singapore ETFs that are index funds (not REITs)
  ES3: 'Index Fund', G3B: 'Index Fund',
};

function getSector(symbol, name) {
  const clean = String(symbol || '').toUpperCase().replace(/\.SI$/, '').split('.')[0];
  if (SECTOR_MAP[clean]) return SECTOR_MAP[clean];
  const n = String(name || '').toLowerCase();
  if (n.includes('reit')) return 'Real Estate';
  if (n.includes('bond') || n.includes('treasury') || n.includes('aggregate')) return 'Fixed Income';
  if (n.includes(' etf') || n.includes('trust')) return 'Index Fund';
  return 'Other';
}

// ---------- Bond ETF exclusion (Issue 1 fix) ----------
// These pay interest, not dividends. Different tax treatment. Wrong for income planning.
const BOND_ETF_TICKERS = new Set([
  'AGG', 'BND', 'TLT', 'IEF', 'SHY', 'LQD', 'HYG', 'JNK', 'MUB',
  'VCIT', 'VCSH', 'BIV', 'BSV', 'BLV', 'GOVT', 'SCHZ', 'FLOT',
  'USIG', 'IGIB', 'SPIB', 'SPSB', 'SPTI', 'SPTS', 'SPTL',
  'A35', 'O87', 'N6M', 'S27', 'M62', 'QL3', 'Z74',
]);

function isBondEtf(symbol, name) {
  const clean = String(symbol || '').toUpperCase().replace(/\.SI$/, '').split('.')[0];
  if (BOND_ETF_TICKERS.has(clean)) return true;
  const n = String(name || '').toLowerCase();
  if (
    n.includes(' bond') ||
    n.includes('treasury') ||
    n.includes('aggregate bond') ||
    n.includes('fixed income') ||
    n.includes('total bond')
  ) {
    return true;
  }
  return false;
}

// ---------- REIT detection (Issue 2 fix) ----------
function isReit(symbol, name, sector) {
  if (sector === 'Real Estate') return true;
  const n = String(name || '').toLowerCase();
  if (n.includes('reit')) return true;
  return false;
}

// ---------- Risk profiles ----------
const RISK_PROFILES = {
  conservative: {
    key: 'conservative',
    label: 'Safe',
    tagline: 'Play it safe',
    description: 'Lower risk, lower income. Steady names only.',
    allowedSafety: ['Safe'],
    minStreak: 10,
    maxPayoutRatio: 80,
    maxPositionPct: 10,
    maxSectorPct: 25,
    targetCount: 15,
    weights: { yield: 0.30, safety: 0.50, growth: 0.20 },
    expectedYieldRange: [2.5, 4.5],
  },
  balanced: {
    key: 'balanced',
    label: 'Balanced',
    tagline: 'The middle ground',
    description: 'A mix of safety and income. Good for most people.',
    allowedSafety: ['Safe', 'Moderate'],
    minStreak: 5,
    maxPayoutRatio: 90,
    maxPositionPct: 12,
    maxSectorPct: 30,
    targetCount: 12,
    weights: { yield: 0.40, safety: 0.35, growth: 0.25 },
    expectedYieldRange: [3.5, 6.0],
  },
  growth: {
    key: 'growth',
    label: 'Growth',
    tagline: 'Small income that grows',
    description: 'Lower starting income, but the payments grow over time.',
    allowedSafety: ['Safe', 'Moderate'],
    minStreak: 5,
    maxPayoutRatio: 85,
    maxPositionPct: 12,
    maxSectorPct: 35,
    targetCount: 12,
    weights: { yield: 0.25, safety: 0.30, growth: 0.45 },
    expectedYieldRange: [2.5, 5.0],
  },
  'high-income': {
    key: 'high-income',
    label: 'High Income',
    tagline: 'Maximum monthly income',
    description: 'Higher income now, but riskier stocks.',
    allowedSafety: ['Safe', 'Moderate', 'Caution'],
    minStreak: 3,
    maxPayoutRatio: 110,
    maxPositionPct: 8,
    maxSectorPct: 35,
    targetCount: 12,
    weights: { yield: 0.70, safety: 0.20, growth: 0.10 },
    expectedYieldRange: [5.0, 8.0],
  },
};

const LOCATION_MARKETS = {
  SG: ['sg'],
  US: ['us'],
  Both: ['us', 'sg'],
};

const SAFETY_MULT = { Safe: 1.0, Moderate: 0.7, Caution: 0.4 };

// ---------- Candidate cache (30 min TTL) ----------
// Caches the raw stock fetch so repeated requests don't hammer the DB.
const candidateCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000;

function marketsKey(markets) {
  return [...markets].sort().join(',');
}

async function loadCandidates(markets) {
  const key = marketsKey(markets);
  const cached = candidateCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.rows;
  }

  const rows = await Stock.findAll({
    where: { market: markets },
    raw: false,
  });

  candidateCache.set(key, { rows, timestamp: Date.now() });
  return rows;
}

// ---------- Main algorithm ----------
async function generateAllocation({
  targetMonthly,
  capital = 0,
  location = 'SG',
  riskProfile = 'balanced',
}) {
  const markets = LOCATION_MARKETS[location];
  if (!markets) throw new Error('Invalid location');

  const profile = RISK_PROFILES[riskProfile];
  if (!profile) throw new Error('Invalid risk profile');

  if (!isFinite(targetMonthly) || targetMonthly <= 0) throw new Error('targetMonthly must be positive');
  if (capital < 0) throw new Error('capital cannot be negative');

  // ---------- Load candidates (cached) ----------
  const allStocks = await loadCandidates(markets);

  const candidates = [];
  for (const s of allStocks) {
    const data = s.dividendData || {};
    const safety = s.safetyScore || 'Caution';
    const yieldPct = parseFloat(s.currentYield) || 0;
    const payoutRatio = data.payoutRatio != null ? Number(data.payoutRatio) : null;
    const cagr = data.dividendCAGR != null ? Number(data.dividendCAGR) : null;
    const streak = data.dividendStreak != null ? Number(data.dividendStreak) : 0;
    const price = parseFloat(s.currentPrice) || 0;
    const sector = getSector(s.symbol, s.name);

    // ✋ Issue 1: hard exclude bond ETFs
    if (isBondEtf(s.symbol, s.name)) continue;
    if (sector === 'Fixed Income') continue;

    // Basic sanity
    if (yieldPct <= 0) continue;
    if (price <= 0) continue;

    // Safety filter
    if (!profile.allowedSafety.includes(safety)) continue;

    // ✋ Issue 2: skip payout ratio filter for REITs
    // REITs are legally required to distribute 90%+ of income, so EPS-based payout
    // ratios are meaningless for them. Use different rules.
    const reit = isReit(s.symbol, s.name, sector);
    if (!reit) {
      if (payoutRatio != null && payoutRatio > profile.maxPayoutRatio) continue;
    }

    // Dividend history filters (still apply to everyone)
    if (cagr != null && cagr < -10) continue;
    if (streak < profile.minStreak) continue;

    candidates.push({
      symbol: s.symbol,
      name: s.name || s.symbol,
      market: s.market,
      sector,
      isReit: reit,
      safety,
      currentYield: yieldPct,
      dividendCAGR: cagr != null ? cagr : 0,
      payoutRatio,
      dividendStreak: streak,
      currentPrice: price,
      currency: data.currency || (s.market === 'sg' ? 'SGD' : 'USD'),
    });
  }

  if (candidates.length < 5) {
    return {
      ok: false,
      error: 'Not enough stocks match your criteria. Try a different risk level or market.',
    };
  }

  // ---------- Score ----------
  const maxYield = Math.max(...candidates.map(c => c.currentYield), 0.01);

  for (const c of candidates) {
    const yieldScore = Math.min(c.currentYield / maxYield, 1);
    const safetyScoreVal = SAFETY_MULT[c.safety] || 0.4;
    const growthScore = Math.min(Math.max(c.dividendCAGR, 0) / 10, 1);

    // REITs get no payout penalty (their ratios are structurally high)
    const payoutPenalty = c.isReit ? 1.0
      : c.payoutRatio == null ? 1.0
        : c.payoutRatio > 100 ? 0.5
          : c.payoutRatio > 85 ? 0.8
            : 1.0;

    const w = profile.weights;
    c._score =
      (w.yield * yieldScore + w.safety * safetyScoreVal + w.growth * growthScore) * payoutPenalty;
  }

  candidates.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return a.symbol.localeCompare(b.symbol);
  });

  // ---------- Select with sector diversification ----------
  const targetN = profile.targetCount;
  const selected = [];
  const sectorCounts = {};
  const maxPerSector = Math.max(2, Math.floor(targetN * 0.3));

  for (const c of candidates) {
    if (selected.length >= targetN) break;
    const sc = sectorCounts[c.sector] || 0;
    if (sc >= maxPerSector) continue;
    selected.push(c);
    sectorCounts[c.sector] = sc + 1;
  }

  if (selected.length < Math.min(8, targetN)) {
    const picked = new Set(selected.map(s => s.symbol));
    for (const c of candidates) {
      if (selected.length >= Math.min(8, targetN)) break;
      if (picked.has(c.symbol)) continue;
      selected.push(c);
      picked.add(c.symbol);
    }
  }

  if (selected.length < 5) {
    return {
      ok: false,
      error: 'Could not build a diversified portfolio. Try a different risk level.',
    };
  }

  // ---------- Weights ----------
  const totalScore = selected.reduce((s, c) => s + c._score, 0);
  for (const c of selected) c._weight = c._score / totalScore;

  const maxPos = profile.maxPositionPct / 100;
  const maxSec = profile.maxSectorPct / 100;

  for (let iter = 0; iter < 8; iter++) {
    let changed = false;

    for (const c of selected) {
      if (c._weight > maxPos) { c._weight = maxPos; changed = true; }
    }

    const bySector = {};
    for (const c of selected) {
      bySector[c.sector] = (bySector[c.sector] || 0) + c._weight;
    }
    for (const c of selected) {
      const secTotal = bySector[c.sector];
      if (secTotal > maxSec) {
        c._weight *= maxSec / secTotal;
        changed = true;
      }
    }

    const sum = selected.reduce((s, c) => s + c._weight, 0);
    if (sum > 0) for (const c of selected) c._weight /= sum;
    if (!changed) break;
  }

  // ---------- Required capital ----------
  const weightedYield = selected.reduce((s, c) => s + c.currentYield * c._weight, 0);
  const requiredCapital = weightedYield > 0 ? (targetMonthly * 12) / (weightedYield / 100) : 0;
  const effectiveCapital = capital > 0 ? capital : requiredCapital;

  // ---------- Allocation math ----------
  const positions = [];
  let totalCost = 0;
  let totalMonthlyIncome = 0;
  let leftoverCash = 0;

  for (const c of selected) {
    const targetDollars = effectiveCapital * c._weight;
    const shares = Math.floor(targetDollars / c.currentPrice);

    if (shares <= 0) { leftoverCash += targetDollars; continue; }

    const cost = shares * c.currentPrice;
    const annualIncome = cost * (c.currentYield / 100);
    const monthlyIncome = annualIncome / 12;

    positions.push({
      symbol: c.symbol,
      name: c.name,
      sector: c.sector,
      safety: c.safety,
      currentPrice: Math.round(c.currentPrice * 100) / 100,
      currentYield: Math.round(c.currentYield * 100) / 100,
      dividendCAGR: Math.round(c.dividendCAGR * 100) / 100,
      payoutRatio: c.payoutRatio != null ? Math.round(c.payoutRatio * 100) / 100 : null,
      dividendStreak: c.dividendStreak,
      weight: Math.round(c._weight * 10000) / 100,
      shares,
      cost: Math.round(cost * 100) / 100,
      annualIncome: Math.round(annualIncome * 100) / 100,
      monthlyIncome: Math.round(monthlyIncome * 100) / 100,
      currency: c.currency,
    });

    totalCost += cost;
    totalMonthlyIncome += monthlyIncome;
  }

  const sectorBreakdown = {};
  const safetyBreakdown = { Safe: 0, Moderate: 0, Caution: 0 };
  for (const p of positions) {
    sectorBreakdown[p.sector] = (sectorBreakdown[p.sector] || 0) + 1;
    safetyBreakdown[p.safety] = (safetyBreakdown[p.safety] || 0) + 1;
  }

  const avgYield = totalCost > 0 ? (totalMonthlyIncome * 12 / totalCost) * 100 : 0;

  const warnings = [];
  if (capital > 0 && totalMonthlyIncome < targetMonthly * 0.9) {
    warnings.push(`Your ${capital.toLocaleString()} would generate about $${totalMonthlyIncome.toFixed(2)}/month — below your goal of $${targetMonthly.toLocaleString()}.`);
  }
  if (leftoverCash > 50) {
    warnings.push(`About $${leftoverCash.toFixed(2)} couldn't be allocated because some share prices are too high for the remaining amount.`);
  }
  if (positions.length < 8) {
    warnings.push(`Only ${positions.length} stocks made the cut. Try "Growth" or "High Income" for more options.`);
  }
  if (riskProfile === 'high-income') {
    warnings.push('High Income picks are riskier. Double-check each one before investing.');
  }

  return {
    ok: true,
    inputs: { targetMonthly, capital, location, riskProfile },
    profile: {
      key: profile.key,
      label: profile.label,
      tagline: profile.tagline,
      description: profile.description,
      expectedYieldRange: profile.expectedYieldRange,
    },
    summary: {
      targetMonthly: Math.round(targetMonthly * 100) / 100,
      targetAnnual: Math.round(targetMonthly * 12 * 100) / 100,
      requiredCapital: Math.round(requiredCapital * 100) / 100,
      providedCapital: capital > 0 ? Math.round(capital * 100) / 100 : 0,
      gap: capital > 0 ? Math.max(0, Math.round((requiredCapital - capital) * 100) / 100) : 0,
      totalCost: Math.round(totalCost * 100) / 100,
      totalMonthlyIncome: Math.round(totalMonthlyIncome * 100) / 100,
      totalAnnualIncome: Math.round(totalMonthlyIncome * 12 * 100) / 100,
      avgYield: Math.round(avgYield * 100) / 100,
      positionCount: positions.length,
      leftoverCash: Math.round(leftoverCash * 100) / 100,
    },
    positions,
    sectorBreakdown,
    safetyBreakdown,
    warnings,
    disclaimer:
      'This is a sample portfolio for learning purposes only. It is not investment advice, a recommendation, or a personalised plan. DividendBro is not licensed under the Financial Advisers Act (Singapore). Past performance does not predict future results. Dividends can be cut or stopped at any time. Always do your own research or speak to a licensed financial adviser before investing.',
  };
}

module.exports = {
  generateAllocation,
  RISK_PROFILES,
  LOCATION_MARKETS,
};