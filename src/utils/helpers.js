function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, { retries = 3, timeout = 10000 } = {}) {
  let lastErr;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': process.env.YAHOO_FINANCE_UA || 'Mozilla/5.0' }, signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.status === 404) throw new Error('Ticker not found.');
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error('Upstream busy (HTTP ' + res.status + ')');
        if (i < retries) { await sleep(800 * (i + 1)); continue; }
      }
      throw new Error('Upstream HTTP ' + res.status);
    } catch (e) {
      clearTimeout(timeoutId);
      if (String(e.message).startsWith('Ticker not found')) throw e;
      if (e.name === 'AbortError') lastErr = new Error('Request timeout');
      else lastErr = e;
      if (i < retries) await sleep(800 * (i + 1));
    }
  }
  throw lastErr || new Error('Network error');
}

function currencySymbol(c, market) {
  const map = { USD: '$', SGD: 'S$', EUR: '€', GBP: '£' };
  if (market === 'sg') {
    const cur = c || 'SGD';
    return map[cur] || cur + ' ';
  }
  return map[c] || '$';
}

function round2(n) { return Math.round(n * 100) / 100; }
function pct(n, base) { return base === 0 ? 0 : Math.round((n / base) * 10000) / 100; }
function isoOf(epoch) { return new Date(epoch * 1000).toISOString().slice(0, 10); }

module.exports = { sleep, fetchJson, currencySymbol, round2, pct, isoOf };