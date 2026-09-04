import express from 'express';
import axios from 'axios';
const router = express.Router();

// Polygon.io API endpoint
const POLYGON_BASE_URL = 'https://api.polygon.io';
const POLYGON_API_KEY = process.env.POLYGON_API_KEY;

// Get historical prices for a stock
router.get('/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const { from, to, timeframe = 'day' } = req.query;

    if (!POLYGON_API_KEY) {
      return res.status(500).json({ 
        error: 'Polygon API key not configured' 
      });
    }

    // Build the Polygon API URL
    // Format: /v2/aggs/ticker/{symbol}/range/{multiplier}/{timespan}/{from}/{to}
    const multiplier = timeframe === 'day' ? 1 : 1;
    const timespan = timeframe === 'day' ? 'day' : 'day';
    
    // Format dates for Polygon (YYYY-MM-DD)
    const fromDate = from || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];

    // Polygon API URL
    const url = `${POLYGON_BASE_URL}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${fromDate}/${toDate}`;

    const response = await axios.get(url, {
      params: {
        adjusted: true,
        sort: 'asc',
        limit: 5000,
        apiKey: POLYGON_API_KEY
      }
    });

    if (response.data.status === 'ERROR') {
      throw new Error(response.data.error || 'Polygon API error');
    }

    // Transform Polygon data to match your frontend format
    const results = response.data.results || [];
    const transformedData = results.map(item => ({
      date: new Date(item.t).toISOString().split('T')[0],
      open: item.o,
      high: item.h,
      low: item.l,
      close: item.c,
      volume: item.v
    }));

    res.json({
      symbol: symbol,
      from: fromDate,
      to: toDate,
      timeframe: timeframe,
      data: transformedData
    });

  } catch (error) {
    console.error('Error fetching historical data from Polygon:', error);
    
    // Fallback to Yahoo Finance if Polygon fails
    try {
      console.log('Trying Yahoo Finance fallback...');
      const yahooData = await getHistoricalFromYahoo(req.params.symbol, req.query.from, req.query.to);
      return res.json(yahooData);
    } catch (fallbackError) {
      return res.status(500).json({ 
        error: 'Failed to fetch historical data',
        details: error.message 
      });
    }
  }
});

// Fallback: Yahoo Finance (using yahoo-finance2)
async function getHistoricalFromYahoo(symbol, from, to) {
  const yahooFinance = await import('yahoo-finance2');
  
  const queryOptions = {
    period1: from || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
    period2: to || new Date(),
    interval: '1d',
  };
  
  const result = await yahooFinance.historical(symbol, queryOptions);
  
  return {
    symbol: symbol,
    data: result.map(item => ({
      date: item.date.toISOString().split('T')[0],
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume
    }))
  };
}

export default router;