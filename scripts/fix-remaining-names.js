/* backend/scripts/fix-remaining-names.js */

require('dotenv').config();
const Stock = require('../src/models/stock');

const MANUAL_NAMES = {
  'M62.SI': 'Lorenzo International Limited',
};

async function main() {
  for (const [symbol, name] of Object.entries(MANUAL_NAMES)) {
    const s = await Stock.findByPk(symbol);
    if (!s) {
      console.log(`⚠️  ${symbol} not found`);
      continue;
    }
    s.name = name;
    await s.save();
    console.log(`✅ ${symbol} → ${name}`);
  }

  // Remove NUSI (delisted)
  const nusi = await Stock.findByPk('NUSI');
  if (nusi) {
    await nusi.destroy();
    console.log('🗑️  NUSI removed (delisted)');
  } else {
    console.log('⚠️  NUSI not found');
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});