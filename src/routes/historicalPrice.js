const express = require('express');
const axios = require('axios');
const router = express.Router();

// Replace with your Alpha Vantage API key
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;

router.get('/', async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'Symbol and date are required' });
  }

  try {
    // Fetch daily adjusted data from Alpha Vantage
    const response = await axios.get('https://www.alphavantage.co/query', {
      params: {
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        symbol: symbol,
        apikey: ALPHA_VANTAGE_API_KEY,
        outputsize: 'compact',
      },
    });

    const timeSeries = response.data['Time Series (Daily)'];
    if (!timeSeries) {
      return res.status(404).json({ error: 'No data found for this symbol' });
    }

    // Find the closest date to the requested date
    const targetDate = new Date(date);
    const targetDateStr = targetDate.toISOString().split('T')[0];
    
    // If the exact date exists, use it
    if (timeSeries[targetDateStr]) {
      const price = parseFloat(timeSeries[targetDateStr]['5. adjusted close']);
      return res.json({
        symbol,
        date: targetDateStr,
        price: price,
        currency: 'USD',
      });
    }

    // Otherwise, find the closest available date
    const availableDates = Object.keys(timeSeries).sort();
    let closestDate = null;
    let closestDiff = Infinity;

    for (const d of availableDates) {
      const diff = Math.abs(new Date(d).getTime() - targetDate.getTime());
      if (diff < closestDiff) {
        closestDiff = diff;
        closestDate = d;
      }
    }

    if (closestDate && closestDiff < 30 * 24 * 60 * 60 * 1000) { // within 30 days
      const price = parseFloat(timeSeries[closestDate]['5. adjusted close']);
      return res.json({
        symbol,
        date: closestDate,
        price: price,
        currency: 'USD',
        note: `Using closest available date: ${closestDate}`,
      });
    }

    res.status(404).json({ error: 'No price found within 30 days of the specified date' });
  } catch (error) {
    console.error('Historical price error:', error.message);
    res.status(500).json({ error: 'Failed to fetch historical price' });
  }
});

module.exports = router;