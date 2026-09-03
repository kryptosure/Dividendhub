const cron = require('node-cron');
const { refreshTopStocks } = require('../services/stockService');

// Run every 6 hours
cron.schedule('0 */6 * * *', async () => {
  console.log('🔄 Running stock refresh job...');
  await refreshTopStocks('us');
  await refreshTopStocks('sg');
  console.log('✅ Stock refresh job completed');
});