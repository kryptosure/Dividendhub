const Stock = require('../models/stock');
const { fetchDividendData } = require('./yahooFinance');
const { sleep } = require('../utils/helpers');

async function getStock(symbol, market, type = 'stock') {
  let stock = await Stock.findByPk(symbol);
  if (stock && Date.now() - new Date(stock.lastUpdated).getTime() < 12 * 60 * 60 * 1000) {
    const data = stock.dividendData;
    return {
      symbol: stock.symbol,
      name: stock.name,
      market: stock.market,
      type: stock.type,
      currency: data.currency || 'USD',
      currencySymbol: data.currencySymbol || '$',
      totalDividend: parseFloat(stock.totalDividend),
      payoutCount: stock.payoutCount,
      firstExDate: stock.firstExDate,
      lastExDate: stock.lastExDate,
      byYear: data.byYear || [],
      currentPrice: parseFloat(stock.currentPrice),
      currentYield: parseFloat(stock.currentYield),
      dividendCAGR: data.dividendCAGR || null,
      trailingAnnualDiv: data.trailingAnnualDiv || null,
      payoutRatio: data.payoutRatio || null,
      safetyScore: stock.safetyScore,
      exchange: data.exchange || (market === 'sg' ? 'SGX' : 'NASDAQ'),
    };
  }

  const data = await fetchDividendData(symbol, market);
  if (data.error || data.message) throw new Error(data.error || data.message);

  await Stock.upsert({
    symbol: data.symbol,
    name: data.name,
    market: market,
    type: type,
    dividendData: data,
    currentPrice: data.currentPrice,
    currentYield: data.currentYield,
    safetyScore: data.safetyScore,
    payoutCount: data.payoutCount,
    totalDividend: data.totalDividend,
    firstExDate: data.firstExDate,
    lastExDate: data.lastExDate,
    lastUpdated: new Date(),
  });

  return data;
}

async function getBatchStocks(symbols, market) {
  const results = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const data = await getStock(symbol, market);
        return { symbol, data, error: null };
      } catch (e) {
        return { symbol, data: null, error: e.message };
      }
    })
  );
  return results;
}

async function refreshTopStocks(market = 'us') {
  const stockSymbols = market === 'us'
    ? ['VZ','T','KHC','MO','ABBV','PFE','XOM','CVX','JPM','BAC','WFC','KO','PEP','MCD','MSFT','AAPL','NVDA','JNJ','PG','HD']
    : ['D05.SI','O39.SI','U11.SI','C6L.SI','Z74.SI','BN4.SI','S63.SI','C52.SI','F34.SI','G13.SI','H78.SI','J36.SI','C07.SI','S68.SI','K71U.SI','A17U.SI','N2IU.SI','C38U.SI','M44U.SI'];

  const etfSymbols = market === 'us'
    ? ['SPY','QQQ','VTI','VOO','IVV','BND','AGG','GLD','SLV','EEM','EFA','IWM','XLK','XLF','XLE','XLI','XLV','XLY','XLP','XLU']
    : ['ES3.SI','G3B.SI','CFA.SI','O87.SI','M62.SI','N6M.SI','S27.SI','ER7.SI','NS8U.SI','GRN.SI'];

  // Delete existing entries for this market to avoid duplicates
  await Stock.destroy({ where: { market } });

  for (const symbol of stockSymbols) {
    try {
      await getStock(symbol, market, 'stock');
      await sleep(200);
    } catch (e) {
      console.error(`Failed to refresh stock ${symbol}:`, e.message);
    }
  }

  for (const symbol of etfSymbols) {
    try {
      await getStock(symbol, market, 'etf');
      await sleep(200);
    } catch (e) {
      console.error(`Failed to refresh ETF ${symbol}:`, e.message);
    }
  }

  console.log(`✅ Refreshed top stocks and ETFs for ${market}`);
}

module.exports = { getStock, getBatchStocks, refreshTopStocks };