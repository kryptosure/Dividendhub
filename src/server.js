require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const sequelize = require('./config/database');
require('./jobs/refreshStocks');

// Import models and operators for search
const Stock = require('./models/stock');
const { Op } = require('sequelize');
const { yahooSearch } = require('./services/yahooFinance');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(compression());
app.use(express.json());

// Serve static files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Existing routes ----------
app.use('/api/stocks-list', require('./routes/stocksList'));
app.use('/api/stocks', require('./routes/stocks'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/portfolio', require('./routes/portfolio'));
app.use('/api/simulate', require('./routes/simulate'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/historical-price', require('./routes/historicalPrice'));

// ---------- NEW: /api/search endpoint ----------
// Fallback map for common names (as a last resort)
const FALLBACK_MAP = {
  us: {
    'apple': [{ symbol: 'AAPL', name: 'Apple Inc.' }],
    'microsoft': [{ symbol: 'MSFT', name: 'Microsoft Corp.' }],
    'amazon': [{ symbol: 'AMZN', name: 'Amazon.com Inc.' }],
    'google': [{ symbol: 'GOOGL', name: 'Alphabet Inc.' }],
    'facebook': [{ symbol: 'META', name: 'Meta Platforms' }],
    'netflix': [{ symbol: 'NFLX', name: 'Netflix Inc.' }],
    'tesla': [{ symbol: 'TSLA', name: 'Tesla Inc.' }],
    'nvidia': [{ symbol: 'NVDA', name: 'NVIDIA Corp.' }],
    'jpmorgan': [{ symbol: 'JPM', name: 'JPMorgan Chase' }],
    'verizon': [{ symbol: 'VZ', name: 'Verizon Communications' }],
    'coca-cola': [{ symbol: 'KO', name: 'Coca-Cola Co.' }],
    'spy': [{ symbol: 'SPY', name: 'SPDR S&P 500 ETF' }],
    'qqq': [{ symbol: 'QQQ', name: 'Invesco QQQ Trust' }],
    'vti': [{ symbol: 'VTI', name: 'Vanguard Total Stock Market ETF' }],
  },
  sg: {
    'dbs': [{ symbol: 'D05.SI', name: 'DBS Group Holdings' }],
    'ocbc': [{ symbol: 'O39.SI', name: 'OCBC Bank' }],
    'uob': [{ symbol: 'U11.SI', name: 'United Overseas Bank' }],
    'singapore airlines': [{ symbol: 'C6L.SI', name: 'Singapore Airlines' }],
    'singtel': [{ symbol: 'Z74.SI', name: 'Singtel' }],
    'keppel': [{ symbol: 'BN4.SI', name: 'Keppel Corp' }],
    'es3': [{ symbol: 'ES3.SI', name: 'SPDR Straits Times Index ETF' }],
    'g3b': [{ symbol: 'G3B.SI', name: 'Nikko AM Singapore STI ETF' }],
  }
};

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const market = String(req.query.market || 'us').toLowerCase();

  if (q.length < 2) return res.json([]);

  try {
    let results = [];

    // 1. Query Yahoo Finance (good for US and popular SGX)
    try {
      const yahoo = await yahooSearch(q, market);
      if (yahoo && yahoo.length > 0) {
        results = yahoo.map(item => ({
          symbol: item.symbol,
          name: item.longname || item.shortname || item.symbol,
          market: market,
        }));
      }
    } catch (e) {
      console.warn('Yahoo search failed:', e.message);
    }

    // 2. ALWAYS query your local database (this covers all SGX stocks you have)
    let dbResults = [];
    try {
      const stocks = await Stock.findAll({
        where: {
          market,
          [Op.or]: [
            { symbol: { [Op.iLike]: `%${q}%` } },
            { name: { [Op.iLike]: `%${q}%` } },
          ],
        },
        limit: 10,
        attributes: ['symbol', 'name'],
      });
      dbResults = stocks.map(s => ({
        symbol: s.symbol,
        name: s.name || s.symbol,
        market: market,
      }));
    } catch (e) {
      console.warn('Database search failed:', e.message);
    }

    // Merge Yahoo + DB, deduplicate by symbol
    const all = [...results, ...dbResults];
    const seen = new Set();
    const unique = all.filter(item => {
      const key = item.symbol;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 3. Hardcoded fallback (only if still empty)
    if (unique.length === 0) {
      const normalized = q.toLowerCase().trim();
      const map = FALLBACK_MAP[market] || FALLBACK_MAP.us;
      for (const [key, items] of Object.entries(map)) {
        if (normalized.includes(key) || key.includes(normalized)) {
          unique.push(...items.map(item => ({
            symbol: item.symbol,
            name: item.name,
            market: market,
          })));
          break;
        }
      }
    }

    // Return max 10 results in the format frontend expects
    const response = unique.slice(0, 10).map(item => ({
      symbol: item.symbol,
      name: item.name,
      market: market,
    }));

    res.json(response);
  } catch (e) {
    console.error('Search error:', e);
    res.json([]);
  }
});

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Start server
sequelize.sync({ alter: true }).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 DividendHub backend running on port ${PORT}`);
    console.log(`📦 Compression: enabled`);
    console.log(`🗄️  Serving static files from: ${path.join(__dirname, 'public')}`);
  });
});