const { Sequelize } = require('sequelize');
require('dotenv').config();

let sequelize;

// If DATABASE_URL is provided (Render), use it directly
if (process.env.DATABASE_URL) {
  sequelize = new Sequelize(process.env.DATABASE_URL, {
    dialect: 'postgres',
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false, // Required for Render's free PostgreSQL
      },
    },
    logging: false, // Set to console.log to see SQL queries in dev
  });
} else {
  // Local development fallback (using individual env variables)
  sequelize = new Sequelize(
    process.env.DB_NAME || 'dividendhub',
    process.env.DB_USER || 'postgres',
    process.env.DB_PASSWORD || 'password',
    {
      host: process.env.DB_HOST || 'localhost',
      dialect: 'postgres',
      logging: false,
    }
  );
}

module.exports = sequelize;