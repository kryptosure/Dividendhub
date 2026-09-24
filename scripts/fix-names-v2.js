/* backend/scripts/fix-names-v2.js
 * Uses Yahoo's direct quote() endpoint (no search) to resolve names.
 * Fallback to yahooSearch() if quote() fails.
 */

require('dotenv').config();
const Stock = require('../src/models/stock');
const YahooFinance = require('yahoo-finance2').default;
const { yahooSearch } = require('../src/services/yahooFinance');

const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
});

const DELAY_MS = 2000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Try direct quote lookup first (no rate limits on this endpoint).
 */
async function resolveViaQuote(symbol) {
  try {
    const result = await yahooFinance.quote(symbol);
    if (result && (result.longName || result.shortName)) {
      return result.longName || result.shortName;
    }
  } catch (e) {
    // fall through
  }
  return null;
}

/**
 * Fall back to search if quote() returned nothing.
 */
async function resolveViaSearch(symbol, market) {
  try {
    const query = symbol.replace(/\.(SI|TO|V)$/, '');
    const results = await yahooSearch(query, market);
    const match = results.find(r => r.symbol === symbol) || results[0];
    if (match && (match.longname || match.shortname) && match.longname !== symbol) {
      return match.longname || match.shortname;
    }
  } catch (e) {
    // fall through
  }
  return null;
}

async function main() {
  const all = await Stock.findAll({ raw: false });
  const broken = all.filter(s => s.name === s.symbol);

  console.log(`Found ${broken.length} stocks with name === symbol`);
  console.log('');

  let fixed = 0;
  let failed = 0;

  for (const s of broken) {
    const symbol = s.symbol;
    const market = s.market;

    // Try quote() first, then search as fallback
    let resolvedName = await resolveViaQuote(symbol);
    let method = 'quote';

    if (!resolvedName) {
      resolvedName = await resolveViaSearch(symbol, market);
      method = 'search';
    }

    if (resolvedName) {
      s.name = resolvedName;
      await s.save();
      console.log(`✅ ${symbol.padEnd(12)} → ${resolvedName} [${method}]`);
      fixed++;
    } else {
      console.log(`❌ ${symbol.padEnd(12)} → not resolvable via either method`);
      failed++;
    }

    await sleep(DELAY_MS);
  }

  console.log('');
  console.log(`Done. Fixed: ${fixed}, Failed: ${failed}`);
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});