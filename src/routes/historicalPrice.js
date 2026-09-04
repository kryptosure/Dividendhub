const express = require('express');
const axios = require('axios');
const router = express.Router();

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

router.get('/', async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'Symbol and date are required' });
  }

  try {
    // Try to get historical data (may fail on free tier)
    const targetDate = new Date(date);
    const toTimestamp = Math.floor(targetDate.getTime() / 1000);
    const fromDate = new Date(targetDate);
    fromDate.setDate(fromDate.getDate() - 30);
    const fromTimestamp = Math.floor(fromDate.getTime() / 1000);

    const response = await axios.get('https://finnhub.io/api/v1/stock/candle', {
      params: {
        symbol: symbol,
        resolution: 'D',
        from: fromTimestamp,
        to: toTimestamp,
        token: FINNHUB_API_KEY,
      },
    });

    const data = response.data;

    // If we get a valid response with prices, use it
    if (data.s !== 'no_data' && data.c && data.c.length > 0) {
      // ... (find the closest price logic)
      const prices = data.c;
      const timestamps = data.t;
      const targetDateMs = targetDate.getTime();
      let closestIndex = 0;
      let closestDiff = Infinity;

      for (let i = 0; i < timestamps.length; i++) {
        const diff = Math.abs(timestamps[i] * 1000 - targetDateMs);
        if (diff < closestDiff) {
          closestDiff = diff;
          closestIndex = i;
        }
      }

      const closestDate = new Date(timestamps[closestIndex] * 1000);
      return res.json({
        symbol,
        requestedDate: date,
        date: closestDate.toISOString().split('T')[0],
        price: prices[closestIndex],
        currency: 'USD',
        source: 'Finnhub',
      });
    }

    // Fallback: use the current price from the quote endpoint
    const quoteResponse = await axios.get('https://finnhub.io/api/v1/quote', {
      params: {
        symbol: symbol,
        token: FINNHUB_API_KEY,
      },
    });

    const currentPrice = quoteResponse.data.c; // current price
    if (currentPrice) {
      return res.json({
        symbol,
        requestedDate: date,
        date: new Date().toISOString().split('T')[0],
        price: currentPrice,
        currency: 'USD',
        source: 'Finnhub (current price)',
        note: 'Historical price not available – using current price',
      });
    }

    res.status(404).json({ error: 'No data found for this symbol' });
  } catch (error) {
    console.error('Finnhub error:', error.message);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

module.exports = router;