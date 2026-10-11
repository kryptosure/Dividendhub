/* backend/scripts/rescore-safety.js
 *
 * Re-computes safetyScore for ETFs and Preferred Stocks using the
 * new asset-type-aware logic. Stocks and REITs are left untouched.
 *
 * Usage:
 *   node scripts/rescore-safety.js
 *   node scripts/rescore-safety.js --dry-run   # preview changes only
 */

require('dotenv').config();
const Stock = require('../src/models/stock');
const { classifyAssetType } = require('../src/services/stockClassifier');
const { computeSafetyScore } = require('../src/services/yahooFinance');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const all = await Stock.findAll();
  console.log(`Loaded ${all.length} stocks from DB\n`);

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const changes = [];

  for (const s of all) {
    const data = s.dividendData || {};

    // Re-classify using the current classifier (more accurate than the DB's stored 'type')
    const assetType = classifyAssetType(s.symbol, s.name, s.type);

    // Only rescore ETFs and Preferred Stocks
    if (assetType !== 'ETF' && assetType !== 'Bond ETF' && assetType !== 'Preferred Stock') {
      skipped++;
      continue;
    }

    // Build byYearMap from cached dividendData
    const byYearMap = {};
    for (const y of data.byYear || []) {
      byYearMap[y.year] = { year: y.year, total: y.total, count: y.count, payouts: y.payouts || [] };
    }

    if (Object.keys(byYearMap).length === 0) {
      skipped++;
      continue;
    }

    const newScore = computeSafetyScore({
      assetType,
      byYearMap,
      name: s.name,
      symbol: s.symbol,
      currentYield: parseFloat(s.currentYield) || 0,
      payoutRatio: data.payoutRatio ?? null,
    });

    const oldScore = s.safetyScore || 'Caution';

    if (newScore === oldScore) {
      unchanged++;
      continue;
    }

    changes.push({
      symbol: s.symbol,
      name: s.name,
      assetType,
      old: oldScore,
      new: newScore,
    });

    if (!DRY_RUN) {
      s.safetyScore = newScore;
      await s.save();
    }
    updated++;
  }

  // ---------- Print summary ----------
  console.log('=== Changes ===\n');
  if (changes.length === 0) {
    console.log('No changes needed. All ETF / Preferred scores are already correct.');
  } else {
    const order = { Caution: 0, Moderate: 1, Safe: 2 };
    const up = changes.filter(c => order[c.new] > order[c.old]);
    const down = changes.filter(c => order[c.new] < order[c.old]);

    if (up.length > 0) {
      console.log(`⬆️  UPGRADED (${up.length}):`);
      for (const c of up) {
        console.log(`   ${c.symbol.padEnd(10)} [${c.assetType.padEnd(14)}] ${c.old.padEnd(9)} → ${c.new.padEnd(9)}  ${c.name}`);
      }
      console.log('');
    }

    if (down.length > 0) {
      console.log(`⬇️  DOWNGRADED (${down.length}):`);
      for (const c of down) {
        console.log(`   ${c.symbol.padEnd(10)} [${c.assetType.padEnd(14)}] ${c.old.padEnd(9)} → ${c.new.padEnd(9)}  ${c.name}`);
      }
      console.log('');
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total in DB:        ${all.length}`);
  console.log(`Skipped (non-ETF):  ${skipped}`);
  console.log(`Unchanged:          ${unchanged}`);
  console.log(`Updated:            ${updated}`);
  if (DRY_RUN) console.log('\n⚠️  DRY RUN — no changes written to DB');
  console.log('');

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});