/* backend/scripts/probe-canada.js
 * Validates Yahoo + FMP data quality for TSX tickers BEFORE adding them
 * to stockUniverse.js.
 *
 * Usage:
 *   node scripts/probe-canada.js
 *
 * Requires:
 *   FMP_API_KEY (already in your .env)
 */

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { fetchPayoutRatio } = require('../src/services/fmpService');

const UA = process.env.YAHOO_FINANCE_UA || 'Mozilla/5.0 (compatible; DividendHub/2.0)';

// ---------------------------------------------------------------------------
// Phase 1 candidates. REITs are listed twice (.UN and -UN) because Yahoo's
// symbol format for Canadian trust units has flip-flopped historically.
// ---------------------------------------------------------------------------
const CANDIDATES = [
  // Big Six banks
  'RY.TO', 'TD.TO', 'BNS.TO', 'BMO.TO', 'CM.TO', 'NA.TO',

  // Energy & pipelines
  'ENB.TO', 'TRP.TO', 'PPL.TO', 'SU.TO', 'CNQ.TO', 'FRU.TO',

  // REITs — both dot and dash variants
  'SRU.UN.TO', 'SRU-UN.TO',
  'REI.UN.TO', 'REI-UN.TO',
  'GRT.UN.TO', 'GRT-UN.TO',
  'CRT.UN.TO', 'CRT-UN.TO',
  'CRR.UN.TO', 'CRR-UN.TO',
  'DIR.UN.TO', 'DIR-UN.TO',
  'VITL.UN.TO', 'VITL-UN.TO',
  'CHP.UN.TO', 'CHP-UN.TO',

  // Monthly non-REIT
  'WCP.TO', 'DIV.TO', 'EIF.TO',

  // Utilities & telecom
  'FTS.TO', 'CU.TO', 'T.TO', 'BCE.TO',

  // ETFs
  'PDC.TO', 'DXC.TO',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function detectFrequencyFromDates(dates) {
  if (!dates || dates.length < 3) return 'unknown';
  const sorted = [...dates].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    gaps.push((sorted[i] - sorted[i - 1]) / (1000 * 60 * 60 * 24));
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median < 3) return 'daily';
  if (median < 10) return 'weekly';
  if (median < 20) return 'bi-weekly';
  if (median <= 45) return 'monthly';
  if (median <= 120) return 'quarterly';
  if (median <= 250) return 'semi-annual';
  return 'annual';
}

async function probeYahoo(symbol) {
  const out = {
    symbol,
    yahooOk: false,
    currency: null,
    divCount: 0,
    lastDiv: null,
    frequency: 'unknown',
    error: null,
  };

  try {
    const now = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?period1=0&period2=${now}&interval=1d&events=div`;

    const data = await fetchJson(url);
    const chart = data?.chart;
    if (!chart || chart.error) {
      throw new Error(chart?.error?.description || 'no chart');
    }
    const result = chart.result?.[0];
    if (!result) throw new Error('no result');

    out.currency = result.meta?.currency || null;

    const divs = result.events?.dividends || {};
    const epochs = Object.values(divs)
      .map((d) => Number(d.date) * 1000)
      .filter((n) => isFinite(n));

    out.divCount = epochs.length;
    if (epochs.length) {
      out.lastDiv = new Date(Math.max(...epochs)).toISOString().slice(0, 10);
    }
    out.frequency = detectFrequencyFromDates(epochs);
    out.yahooOk = true;
  } catch (err) {
    out.error = err?.message || String(err);
  }

  return out;
}

async function main() {
  const results = [];

  for (const symbol of CANDIDATES) {
    process.stdout.write(`Probing ${symbol}… `);

    const y = await probeYahoo(symbol);

    // Test the real production payout-ratio path (Yahoo → FMP fallback)
    let payout = null;
    let payoutErr = null;
    try {
      payout = await fetchPayoutRatio(symbol);
    } catch (e) {
      payoutErr = e.message;
    }

    const merged = {
      symbol,
      ccy: y.currency,
      ok: y.yahooOk,
      divs: y.divCount,
      freq: y.frequency,
      last: y.lastDiv,
      payout,
      note: y.error || payoutErr || '',
    };
    results.push(merged);

    console.log(
      y.yahooOk
        ? `✅ ${y.divCount} divs, ${y.frequency}, payout=${payout ?? '—'}`
        : `❌ ${y.error}`
    );

    await sleep(350); // be polite
  }

  console.log('\n=== Canada probe results ===\n');
  console.table(
    results.map((r) => ({
      Symbol: r.symbol,
      Ccy: r.ccy,
      OK: r.ok ? '✅' : '❌',
      Divs: r.divs,
      Freq: r.freq,
      Last: r.last,
      Payout: r.payout ?? '',
      Note: r.note.slice(0, 30),
    }))
  );

  const good = results.filter((r) => r.ok && r.divs >= 8);
  const noPayout = results.filter((r) => r.ok && r.payout == null);
  const failed = results.filter((r) => !r.ok);

  console.log('\n=== Verdict ===');
  console.log(`✅ Good (Yahoo + dividend history): ${good.length}/${results.length}`);
  console.log(`⚠️  No payout ratio: ${noPayout.length}`);
  if (noPayout.length) console.log('   ' + noPayout.map((r) => r.symbol).join(', '));
  console.log(`❌ Failed Yahoo: ${failed.length}`);
  if (failed.length) {
    console.log('   ' + failed.map((r) => `${r.symbol} (${r.note})`).join('\n   '));
  }

  // REIT format winner
  const reits = results.filter((r) => /\.UN\.|-UN\./.test(r.symbol));
  if (reits.length) {
    console.log('\n=== REIT symbol format ===');
    const byBase = {};
    for (const r of reits) {
      const base = r.symbol.replace(/-UN/, '.UN').replace('.UN.TO', '');
      byBase[base] = byBase[base] || [];
      byBase[base].push(`${r.symbol} → ${r.ok ? 'OK' : 'FAIL'}`);
    }
    for (const [base, variants] of Object.entries(byBase)) {
      console.log(`  ${base}: ${variants.join('  |  ')}`);
    }
  }

  const outPath = path.resolve(__dirname, 'probe-canada-results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 Written to ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});