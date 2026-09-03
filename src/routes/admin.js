const express = require('express');
const { refreshTopStocks } = require('../services/stockService');
const router = express.Router();

router.get('/refresh', async (req, res) => {
  try {
    await refreshTopStocks('us');
    await refreshTopStocks('sg');
    res.json({ success: true, message: 'All stocks refreshed' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;