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
  // ✅ NEW: Persistent anonymous visitor ID (localStorage-backed)
  visitorId: {
    type: DataTypes.STRING(50),
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
    { fields: ['visitorId'] },   // ✅ NEW
  ],
});

module.exports = Event;