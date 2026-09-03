const { refreshTopStocks } = require('./src/services/stockService');
const sequelize = require('./src/config/database');
const Stock = require('./src/models/Stock');

(async () => {
  await sequelize.sync({ alter: true });

  // Clear all stocks to avoid mixed data
  await Stock.destroy({ where: {} });
  console.log('🗑️ Cleared existing stocks');

  console.log('🌱 Seeding US top stocks...');
  await refreshTopStocks('us');
  console.log('🌱 Seeding SGX top stocks...');
  await refreshTopStocks('sg');

  console.log('✅ Seeding complete. Exiting.');
  process.exit(0);
})();