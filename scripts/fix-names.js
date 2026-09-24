/* backend/scripts/fix-names.js
 * Re-resolves the name for stocks where name === symbol.
 * Adds a delay between calls to avoid Yahoo rate limits.
 */

require('dotenv').config();
const Stock = require('../src/models/stock');
const { yahooSearch } = require('../src/services/yahooFinance');

const DELAY_MS = 1500;  // 1.5s between calls to stay under rate limit

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // Find all stocks where name === symbol
  const all = await Stock.findAll({ raw: false });
  const broken = all.filter(s => s.name === s.symbol);

  console.log(`Found ${broken.length} stocks with name === symbol`);
  console.log('');

  let fixed = 0;
  let failed = 0;

  for (const s of broken) {
    const symbol = s.symbol;
    const market = s.market;

    try {
      // Strip exchange suffix before search
      const query = symbol.replace(/\.(SI|TO|V)$/, '');
      const results = await yahooSearch(query, market);

      // Find exact symbol match, or the first result
      const match = results.find(r => r.symbol === symbol) || results[0];

      if (match && (match.longname || match.shortname) && match.longname !== symbol) {
        const resolvedName = match.longname || match.shortname;
        s.name = resolvedName;
        await s.save();
        console.log(`✅ ${symbol.padEnd(12)} → ${resolvedName}`);
        fixed++;
      } else {
        console.log(`⚠️  ${symbol.padEnd(12)} → no match found (Yahoo returned: ${match?.longname || match?.shortname || 'nothing'})`);
        failed++;
      }
    } catch (e) {
      console.log(`❌ ${symbol.padEnd(12)} → ${e.message}`);
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