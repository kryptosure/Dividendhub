const express = require('express');
const Stock = require('../models/stock');
const router = express.Router();

// GET /api/stocks/list – returns all stocks from DB
router.get('/', async (req, res) => {
  try {
    const stocks = await Stock.findAll({
      attributes: ['symbol', 'name', 'market'],
      order: [['symbol', 'ASC']],
    });
    res.json(stocks);
  } catch (error) {
    console.error('Failed to fetch stock list:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;