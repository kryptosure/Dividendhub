const express = require('express');
const yahooFinance = require('yahoo-finance2').default;
const router = express.Router();

router.get('/', async (req, res) => {
  const { symbol, date } = req.query;
  if (!symbol || !date) {
    return res.status(400).json({ error: 'Symbol and date are required' });
  }

  try {
    // Parse the date
    const targetDate = new Date(date);
    // Yahoo Finance expects YYYY-MM-DD format
    const dateStr = targetDate.toISOString().split('T')[0];

    // Fetch historical data for the last 90 days (to find the closest trading day)
    const endDate = new Date(targetDate);
    endDate.setDate(endDate.getDate() + 5); // 5 days after

    const startDate = new Date(targetDate);
    startDate.setDate(startDate.getDate() - 30); // 30 days before

    const historical = await yahooFinance.historical(symbol, {
      period1: startDate,
      period2: endDate,
      interval: '1d',
    });

    if (!historical || historical.length === 0) {
      return res.status(404).json({ error: 'No historical data found' });
    }

    // Find the closest date to the target date
    const targetDateMs = targetDate.getTime();
    let closest = null;
    let closestDiff = Infinity;

    for (const entry of historical) {
      const entryDate = new Date(entry.date);
      const diff = Math.abs(entryDate.getTime() - targetDateMs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = entry;
      }
    }

    if (closest) {
      res.json({
        symbol,
        date: closest.date,
        price: closest.close,
        currency: 'USD',
      });
    } else {
      res.status(404).json({ error: 'No matching price found' });
    }
  } catch (error) {
    console.error('Historical price error:', error);
    res.status(500).json({ error: 'Failed to fetch historical price' });
  }
});

module.exports = router;