const express = require('express');
const axios = require('axios');
const router = express.Router();

// Twelve Data free API key (sign up at twelvedata.com)
// You can also use your own key
const TWELVE_DATA_API_KEY = 'demo'; // demo key works for limited requests

router.get('/', async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'Symbol and date are required' });
  }

  try {
    // Use Twelve Data historical price API
    const response = await axios.get('https://api.twelvedata.com/time_series', {
      params: {
        symbol: symbol,
        interval: '1day',
        outputsize: 30,
        apikey: TWELVE_DATA_API_KEY,
        start_date: date,
        end_date: date,
      },
    });

    if (response.data.status === 'error') {
      throw new Error(response.data.message || 'API error');
    }

    const values = response.data.values || [];
    if (values.length === 0) {
      // Try to find the closest date by fetching 30 days and searching
      const extendedResponse = await axios.get('https://api.twelvedata.com/time_series', {
        params: {
          symbol: symbol,
          interval: '1day',
          outputsize: 30,
          apikey: TWELVE_DATA_API_KEY,
          start_date: date,
          end_date: new Date(new Date(date).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        },
      });
      
      const extendedValues = extendedResponse.data.values || [];
      if (extendedValues.length === 0) {
        return res.status(404).json({ error: 'No historical data found for this date' });
      }
      
      // Find the closest date
      const targetDateMs = new Date(date).getTime();
      let closest = null;
      let closestDiff = Infinity;
      
      for (const entry of extendedValues) {
        const entryDate = new Date(entry.datetime).getTime();
        const diff = Math.abs(entryDate - targetDateMs);
        if (diff < closestDiff) {
          closestDiff = diff;
          closest = entry;
        }
      }
      
      if (closest) {
        return res.json({
          symbol,
          date: closest.datetime,
          price: parseFloat(closest.close),
          currency: 'USD',
        });
      }
      
      return res.status(404).json({ error: 'No matching price found' });
    }

    // Return the price for the exact date
    const price = parseFloat(values[0].close);
    if (!price) {
      return res.status(404).json({ error: 'No price found for this date' });
    }

    res.json({
      symbol,
      date: values[0].datetime,
      price: price,
      currency: 'USD',
    });
  } catch (error) {
    console.error('Historical price error:', error.message);
    // If Twelve Data fails, try a fallback with Yahoo Finance as last resort
    try {
      const yahooFinance = require('yahoo-finance2');
      const historical = await yahooFinance.historical(symbol, {
        period1: new Date(date),
        period2: new Date(new Date(date).getTime() + 24 * 60 * 60 * 1000),
        interval: '1d',
      });
      if (historical && historical.length > 0) {
        const closest = historical.reduce((a, b) => {
          const aDiff = Math.abs(new Date(a.date).getTime() - new Date(date).getTime());
          const bDiff = Math.abs(new Date(b.date).getTime() - new Date(date).getTime());
          return aDiff < bDiff ? a : b;
        });
        return res.json({
          symbol,
          date: closest.date,
          price: closest.close,
          currency: 'USD',
        });
      }
    } catch (fallbackError) {
      console.error('Fallback error:', fallbackError.message);
    }
    res.status(500).json({ error: 'Failed to fetch historical price' });
  }
});

module.exports = router;