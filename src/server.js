require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const sequelize = require('./config/database');
require('./jobs/refreshStocks');

const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(compression());
app.use(express.json());

// ✅ Serve static files from the 'public' folder (sitemap.xml, etc.)
// __dirname is 'backend/src', so go up one level to 'backend/public'
app.use(express.static(path.join(__dirname, '../public')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/stocks', require('./routes/stocks'));
app.use('/api/portfolio', require('./routes/portfolio'));
app.use('/api/simulate', require('./routes/simulate'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

sequelize.sync({ alter: true }).then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 DividendHub backend running on port ${PORT}`);
    console.log(`📦 Compression: enabled`);
    console.log(`🗄️  Serving static files from: ${path.join(__dirname, '../public')}`);
  });
});