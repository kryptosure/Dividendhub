const redis = require('redis');
require('dotenv').config();

let client = null;
let useRedis = false;

try {
  client = redis.createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    socket: {
      reconnectStrategy: (retries) => Math.min(retries * 50, 2000),
    },
  });
  client.on('error', (err) => console.warn('Redis error:', err));
  client.on('connect', () => { console.log('✅ Redis connected'); useRedis = true; });
  client.connect().catch(() => console.warn('⚠️ Redis not available, using in-memory fallback'));
} catch (e) {
  console.warn('⚠️ Redis not installed, using in-memory cache');
}

module.exports = { client, useRedis };