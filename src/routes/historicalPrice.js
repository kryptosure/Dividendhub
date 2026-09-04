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
    // Parse the date
    const targetDate = new Date(date);
    // Finnhub expects a timestamp (UNIX seconds) for the 'to' parameter
    const toTimestamp = Math.floor(targetDate.getTime() / 1000);
    // Fetch 30 days before the target date
    const fromDate = new Date(targetDate);
    fromDate.setDate(fromDate.getDate() - 30);
    const fromTimestamp = Math.floor(fromDate.getTime() / 1000);

    const response = await axios.get('https://finnhub.io/api/v1/stock/candle', {
      params: {
        symbol: symbol,
        resolution: 'D', // Daily
        from: fromTimestamp,
        to: toTimestamp,
        token: FINNHUB_API_KEY,
      },
    });

    const data = response.data;
    if (data.s === 'no_data') {
      return res.status(404).json({ error: 'No data found for this symbol and date' });
    }

    // Finnhub returns arrays: c = close, t = timestamp
    const prices = data.c || [];
    const timestamps = data.t || [];

    if (prices.length === 0) {
      return res.status(404).json({ error: 'No price data available' });
    }

    // Find the closest date to the requested date
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

    // If the closest date is more than 7 days away, return a note
    const closestDate = new Date(timestamps[closestIndex] * 1000);
    const diffDays = Math.abs((closestDate - targetDate) / (1000 * 60 * 60 * 24));
    let note = '';
    if (diffDays > 7) {
      note = `No data found for the exact date. Using closest available date (${closestDate.toISOString().split('T')[0]}), which is ${Math.round(diffDays)} days away.`;
    }

    const price = prices[closestIndex];

    res.json({
      symbol,
      requestedDate: date,
      date: closestDate.toISOString().split('T')[0],
      price: price,
      currency: 'USD',
      source: 'Finnhub',
      note: note || undefined,
    });
  } catch (error) {
    console.error('Finnhub historical price error:', error.message);
    res.status(500).json({ error: 'Failed to fetch historical price' });
  }
});

module.exports = router;