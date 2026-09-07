const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const User = sequelize.define('User', {
  email: { type: DataTypes.STRING, primaryKey: true },
  password: { type: DataTypes.STRING, allowNull: false },
  country: { type: DataTypes.STRING, defaultValue: '' },
  portfolio: { type: DataTypes.JSONB, defaultValue: [] },
  watchlist: { type: DataTypes.JSONB, defaultValue: [] },
}, {
  tableName: 'users',
  timestamps: false,
});

module.exports = User;