const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Stock = sequelize.define('Stock', {
  symbol: {
    type: DataTypes.STRING(20),
    primaryKey: true,
  },
  name: DataTypes.TEXT,
  market: DataTypes.STRING(5),
  type: {
    type: DataTypes.STRING(10),
    allowNull: true,
    defaultValue: 'stock',
  },
  lastUpdated: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  dividendData: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  currentPrice: DataTypes.DECIMAL(10, 2),
  currentYield: DataTypes.DECIMAL(5, 2),
  safetyScore: DataTypes.STRING(20),
  payoutCount: DataTypes.INTEGER,
  totalDividend: DataTypes.DECIMAL(10, 2),
  firstExDate: DataTypes.DATEONLY,
  lastExDate: DataTypes.DATEONLY,
}, {
  tableName: 'stocks',
  timestamps: false,
});

module.exports = Stock;