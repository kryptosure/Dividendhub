const express = require('express');
const Stock = require('../models/stock');
const yahooFinance = require('yahoo-finance2');

const router = express.Router();

// Refresh top stocks
router.post('/refresh', async (req, res) => {
  try {
    // US Top Dividend Stocks
    const usSymbols = [
      'ZIM', 'MO', 'VZ', 'PFE', 'ABBV', 'T', 'IBM', 
      'KMI', 'ET', 'MPW', 'VICI', 'F', 'NEE', 'DUK',
      'JPM', 'BAC', 'C', 'WFC', 'GS', 'MS',
      'PG', 'JNJ', 'MRK', 'KO', 'PEP', 'MCD', 'WMT'
    ];

    let updatedCount = 0;
    
    for (const symbol of usSymbols) {
      try {
        const quote = await yahooFinance.quote(symbol);
        
        // Calculate dividend yield
        const annualDividend = quote.trailingAnnualDividendRate || 0;
        const yield_ = quote.regularMarketPrice ? (annualDividend / quote.regularMarketPrice * 100) : 0;

        // Find or create stock
        const [stock, created] = await Stock.upsert({
          symbol: symbol,
          name: quote.longName || quote.shortName || symbol,
          currentPrice: quote.regularMarketPrice || 0,
          market: 'US',
          currentYield: yield_,
          lastUpdated: new Date()
        });

        updatedCount++;
        console.log(`Updated ${symbol}: $${quote.regularMarketPrice}, yield: ${yield_.toFixed(2)}%`);
        
        // Rate limit - wait 1 second between requests
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (err) {
        console.error(`Error updating ${symbol}:`, err.message);
      }
    }

    res.json({
      success: true,
      message: `Updated ${updatedCount} US stocks`,
      updated: updatedCount
    });

  } catch (error) {
    console.error('Error refreshing stocks:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;