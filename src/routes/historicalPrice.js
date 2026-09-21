const express = require('express');
const axios = require('axios');
const YahooFinance = require('yahoo-finance2').default;

const router = express.Router();

// ✅ v3: instantiate the class once
const yahooFinance = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
});

const POLYGON_API_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE_URL = 'https://api.polygon.io';

// Get historical prices for a stock
router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to, timeframe = 'day' } = req.query;

    // Format dates for Polygon (YYYY-MM-DD)
    const fromDate = from || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];

    // Try Polygon if API key exists
    if (POLYGON_API_KEY) {
      try {
        const url = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/range/1/day/${fromDate}/${toDate}`;
        const response = await axios.get(url, {
          params: {
            adjusted: true,
            sort: 'asc',
            limit: 5000,
            apiKey: POLYGON_API_KEY,
          },
        });

        if (response.data.results) {
          const transformedData = response.data.results.map(item => ({
            date: new Date(item.t).toISOString().split('T')[0],
            open: item.o,
            high: item.h,
            low: item.l,
            close: item.c,
            volume: item.v,
          }));

          return res.json({
            symbol,
            from: fromDate,
            to: toDate,
            timeframe,
            data: transformedData,
          });
        }
      } catch (e) {
        console.log('Polygon failed, trying Yahoo fallback...');
      }
    }

    // ✅ v3: `historical()` was removed. Use `chart()` instead.
    // Convert YYYY-MM-DD to Unix seconds.
    const period1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
    const period2 = Math.floor(new Date(toDate + 'T23:59:59Z').getTime() / 1000);

    const result = await yahooFinance.chart(symbol, {
      period1,
      period2,
      interval: '1d',
    });

    if (!result || !result.quotes || result.quotes.length === 0) {
      return res.status(404).json({ error: 'No historical data found for symbol' });
    }

    res.json({
      symbol,
      from: fromDate,
      to: toDate,
      timeframe,
      data: result.quotes
        .filter(q => q.close != null)   // drop empty rows
        .map(item => ({
          date: new Date(item.date).toISOString().split('T')[0],
          open: item.open,
          high: item.high,
          low: item.low,
          close: item.close,
          volume: item.volume,
        })),
    });

  } catch (error) {
    console.error('Error fetching historical data:', error);
    res.status(500).json({
      error: 'Failed to fetch historical data',
      details: error.message,
    });
  }
});

module.exports = router;