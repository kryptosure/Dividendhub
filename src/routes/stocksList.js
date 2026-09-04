const express = require('express');
const Stock = require('../models/Stock');   // <- capital S
const router = express.Router();

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