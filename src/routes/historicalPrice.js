const express = require('express');
const axios = require('axios');
const router = express.Router();

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

router.get('/', async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'Symbol and date are required' });
  }

  try {
    // Use Twelve Data's time_series endpoint
    const targetDate = new Date(date);
    const startDate = new Date(targetDate);
    startDate.setDate(startDate.getDate() - 5); // 5 days before
    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() + 5); // 5 days after

    const response = await axios.get('https://api.twelvedata.com/time_series', {
      params: {
        symbol: symbol,
        interval: '1day',
        outputsize: 30,
        apikey: TWELVE_DATA_API_KEY,
        start_date: startDate.toISOString().split('T')[0],
        end_date: endDate.toISOString().split('T')[0],
      },
    });

    // Check for errors
    if (response.data.status === 'error') {
      console.error('Twelve Data error:', response.data.message);
      return res.status(400).json({ error: response.data.message });
    }

    const values = response.data.values || [];
    if (values.length === 0) {
      return res.status(404).json({ error: 'No data found for this symbol and date' });
    }

    // Find the closest date to the requested date
    const targetDateMs = targetDate.getTime();
    let closest = null;
    let closestDiff = Infinity;

    for (const entry of values) {
      const entryDate = new Date(entry.datetime).getTime();
      const diff = Math.abs(entryDate - targetDateMs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = entry;
      }
    }

    if (closest && closestDiff < 5 * 24 * 60 * 60 * 1000) {
      const price = parseFloat(closest.close);
      return res.json({
        symbol,
        date: closest.datetime,
        price: price,
        currency: 'USD',
        source: 'Twelve Data',
      });
    }

    res.status(404).json({ error: 'No price found within 5 days of the specified date' });
  } catch (error) {
    console.error('Historical price error:', error.message);
    res.status(500).json({ error: 'Failed to fetch historical price' });
  }
});

module.exports = router;