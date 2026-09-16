/* backend/src/services/incomePlanner.js
 * Illustrative income-target portfolio generator.
 *
 * NOT investment advice. Educational tool only.
 *
 * Algorithm:
 *   1. Filter universe by market, safety score, payout ratio, streak
 *   2. Compute composite score (yield × safety × growth, weights by profile)
 *   3. Select top N with sector diversification constraints
 *   4. Weight by score, apply position + sector caps iteratively
 *   5. Round to whole shares, compute actual income
 */

const Stock = require('../models/stock');

// ---------- Sector map (fallback for stocks not in Yahoo's assetProfile) ----------
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
  // Real Estate (REITs)
  MPW: 'Real Estate', VICI: 'Real Estate',
  K71U: 'Real Estate', A17U: 'Real Estate', N2IU: 'Real Estate',
  C38U: 'Real Estate', M44U: 'Real Estate', H78: 'Real Estate',
  J36: 'Real Estate',
};

function getSector(symbol) {
  const clean = String(symbol || '').toUpperCase().replace(/\.SI$/, '').split('.')[0];
  return SECTOR_MAP[clean] || 'Other';
}

// ---------- Risk profiles ----------
const RISK_PROFILES = {
  conservative: {
    key: 'conservative',
    label: 'Conservative',
    tagline: 'Capital preservation first.',
    description: 'Lower yield, highest quality names only. Prioritises dividend safety over income.',
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
    tagline: 'The middle ground.',
    description: 'A mix of stability and income. Suitable for most long-term investors.',
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
    tagline: 'Income with rising dividends.',
    description: 'Moderate yield with dividend growth as the priority. Lower starting yield, faster compounding.',
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
    tagline: 'Higher yield, higher risk.',
    description: 'Maximum income. May include stocks with elevated payout ratios or lower safety scores.',
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

// ---------- Location → markets ----------
const LOCATION_MARKETS = {
  SG: ['sg'],
  US: ['us'],
  Both: ['us', 'sg'],
};

// ---------- Safety multipliers ----------
const SAFETY_MULT = { Safe: 1.0, Moderate: 0.7, Caution: 0.4 };

// ---------- Main algorithm ----------
async function generateAllocation({
  targetMonthly,
  capital = 0,
  location = 'SG',
  riskProfile = 'balanced',
  maxPositions,
}) {
  // ---------- Validate ----------
  const markets = LOCATION_MARKETS[location];
  if (!markets) throw new Error('Invalid location');

  const profile = RISK_PROFILES[riskProfile];
  if (!profile) throw new Error('Invalid risk profile');

  if (!isFinite(targetMonthly) || targetMonthly <= 0) throw new Error('targetMonthly must be positive');
  if (capital < 0) throw new Error('capital cannot be negative');

  // ---------- 1. Filter universe ----------
  const allStocks = await Stock.findAll({
    where: { market: markets },
    raw: false,
  });

  const candidates = [];
  for (const s of allStocks) {
    const data = s.dividendData || {};
    const safety = s.safetyScore || 'Caution';
    const yieldPct = parseFloat(s.currentYield) || 0;
    const payoutRatio = data.payoutRatio != null ? Number(data.payoutRatio) : null;
    const cagr = data.dividendCAGR != null ? Number(data.dividendCAGR) : null;
    const streak = data.dividendStreak != null ? Number(data.dividendStreak) : 0;
    const price = parseFloat(s.currentPrice) || 0;

    // Hard filters
    if (yieldPct <= 0) continue;
    if (price <= 0) continue;
    if (!profile.allowedSafety.includes(safety)) continue;
    if (payoutRatio != null && payoutRatio > profile.maxPayoutRatio) continue;
    if (cagr != null && cagr < -10) continue; // skip sharply declining dividends
    if (streak < profile.minStreak) continue;

    candidates.push({
      symbol: s.symbol,
      name: s.name || s.symbol,
      market: s.market,
      sector: getSector(s.symbol),
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
      error: 'Not enough stocks meet your criteria. Try a broader risk profile or a different market.',
      candidatesCount: candidates.length,
    };
  }

  // ---------- 2. Score ----------
  const maxYield = Math.max(...candidates.map(c => c.currentYield), 0.01);

  for (const c of candidates) {
    const yieldScore = Math.min(c.currentYield / maxYield, 1);
    const safetyScoreVal = SAFETY_MULT[c.safety] || 0.4;
    const growthScore = Math.min(Math.max(c.dividendCAGR, 0) / 10, 1); // capped at 10% CAGR
    const payoutPenalty =
      c.payoutRatio == null ? 1.0
        : c.payoutRatio > 100 ? 0.5
        : c.payoutRatio > 85 ? 0.8
        : 1.0;

    const w = profile.weights;
    c._score =
      (w.yield * yieldScore + w.safety * safetyScoreVal + w.growth * growthScore) * payoutPenalty;
  }

  candidates.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return a.symbol.localeCompare(b.symbol); // deterministic tiebreak
  });

  // ---------- 3. Select with sector diversification ----------
  const targetN = maxPositions || profile.targetCount;
  const selected = [];
  const sectorCounts = {};
  const maxPerSector = Math.max(2, Math.floor(targetN * 0.3)); // ~30% max per sector

  for (const c of candidates) {
    if (selected.length >= targetN) break;
    const sc = sectorCounts[c.sector] || 0;
    if (sc >= maxPerSector) continue;
    selected.push(c);
    sectorCounts[c.sector] = sc + 1;
  }

  // If we didn't fill enough slots, do a second pass with relaxed sector caps
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
      error: 'Could not construct a sufficiently diversified allocation. Try a broader risk profile.',
    };
  }

  // ---------- 4. Initial weights from score ----------
  const totalScore = selected.reduce((s, c) => s + c._score, 0);
  for (const c of selected) c._weight = c._score / totalScore;

  // ---------- 5. Apply position caps iteratively ----------
  const maxPos = profile.maxPositionPct / 100;
  const maxSec = profile.maxSectorPct / 100;

  for (let iter = 0; iter < 8; iter++) {
    let changed = false;

    // Position cap
    for (const c of selected) {
      if (c._weight > maxPos) {
        c._weight = maxPos;
        changed = true;
      }
    }

    // Sector cap
    const bySector = {};
    for (const c of selected) {
      bySector[c.sector] = (bySector[c.sector] || 0) + c._weight;
    }
    for (const c of selected) {
      const secTotal = bySector[c.sector];
      if (secTotal > maxSec) {
        const factor = maxSec / secTotal;
        c._weight *= factor;
        changed = true;
      }
    }

    // Renormalize
    const sum = selected.reduce((s, c) => s + c._weight, 0);
    if (sum > 0) {
      for (const c of selected) c._weight /= sum;
    }

    if (!changed) break;
  }

  // ---------- 6. Compute required capital ----------
  const weightedYield = selected.reduce((s, c) => s + c.currentYield * c._weight, 0);
  const requiredCapital = weightedYield > 0 ? (targetMonthly * 12) / (weightedYield / 100) : 0;

  // ---------- 7. Allocation math ----------
  // Two scenarios: if user provided capital, allocate it. If not, allocate required capital
  // so they can see what the plan looks like.
  const effectiveCapital = capital > 0 ? capital : requiredCapital;

  const positions = [];
  let totalCost = 0;
  let totalMonthlyIncome = 0;
  let leftoverCash = 0;

  for (const c of selected) {
    const targetDollars = effectiveCapital * c._weight;
    const shares = Math.floor(targetDollars / c.currentPrice);

    if (shares <= 0) {
      // Position too small for one share; skip but note leftover
      leftoverCash += targetDollars;
      continue;
    }

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

  // ---------- 8. Summaries ----------
  const sectorBreakdown = {};
  const safetyBreakdown = { Safe: 0, Moderate: 0, Caution: 0 };
  for (const p of positions) {
    sectorBreakdown[p.sector] = (sectorBreakdown[p.sector] || 0) + 1;
    safetyBreakdown[p.safety] = (safetyBreakdown[p.safety] || 0) + 1;
  }

  const avgYield = totalCost > 0 ? (totalMonthlyIncome * 12 / totalCost) * 100 : 0;

  // ---------- 9. Warnings ----------
  const warnings = [];
  if (capital > 0 && totalMonthlyIncome < targetMonthly * 0.9) {
    warnings.push(`Your provided capital of $${capital.toLocaleString()} generates about $${totalMonthlyIncome.toFixed(2)}/month, which is below your target of $${targetMonthly.toLocaleString()}.`);
  }
  if (leftoverCash > 0) {
    warnings.push(`Approximately $${leftoverCash.toFixed(2)} couldn't be allocated (share prices too high for the remaining balance).`);
  }
  if (positions.length < 8) {
    warnings.push(`Only ${positions.length} positions could be included. Consider a broader risk profile for better diversification.`);
  }
  if (riskProfile === 'high-income') {
    warnings.push('High Income profiles may include stocks with elevated payout ratios. Review each holding carefully.');
  }

  // ---------- 10. Return ----------
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
      'This is a hypothetical illustration based on historical data. It is not investment advice, a recommendation, or a personalised financial plan. DividendBro is not licensed under the Financial Advisers Act (Singapore). Past performance is not indicative of future results. Dividends are not guaranteed and may be reduced or eliminated at any time. Conduct your own due diligence and consult a licensed financial adviser before making any investment decisions.',
  };
}

module.exports = {
  generateAllocation,
  RISK_PROFILES,
  LOCATION_MARKETS,
};