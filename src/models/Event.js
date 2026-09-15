const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Event = sequelize.define('Event', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userEmail: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  eventType: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  eventData: {
    type: DataTypes.JSONB,
    defaultValue: {},
  },
  sessionId: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  // ✅ Persistent anonymous visitor ID (localStorage-backed)
  visitorId: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  // ✅ ISO 3166-1 alpha-2 country code from Cloudflare (e.g. "SG", "US")
  country: {
    type: DataTypes.STRING(2),
    allowNull: true,
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'events',
  timestamps: false,
  indexes: [
    { fields: ['eventType'] },
    { fields: ['createdAt'] },
    { fields: ['userEmail'] },
    { fields: ['visitorId'] },
    { fields: ['country'] },
  ],
});

module.exports = Event;