/* backend/src/routes/analytics.js
 * Admin-only analytics endpoints.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Op, fn, col, literal } = require('sequelize');
const sequelize = require('../config/database');
const User = require('../models/User');
const Event = require('../models/Event');

// ---------- Admin auth middleware ----------
function adminOnly(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (!adminEmails.includes(String(decoded.email).toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.adminEmail = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- Helpers ----------
function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}
function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ✅ NEW: Count unique visitors since a date.
// Uses COALESCE(userEmail, visitorId) — a registered user is identified by email,
// an anonymous visitor is identified by their persistent visitorId.
async function countDistinctVisitors(sinceDate) {
  const result = await Event.findOne({
    attributes: [[
      literal('COUNT(DISTINCT COALESCE("userEmail", "visitorId"))'),
      'count',
    ]],
    where: { createdAt: { [Op.gte]: sinceDate } },
    raw: true,
  });
  return parseInt(result?.count || 0, 10);
}

// ---------- GET /api/analytics/dashboard ----------
router.get('/dashboard', adminOnly, async (req, res) => {
  try {
    const now = new Date();
    const today = startOfToday();

    // ---------- 1. User counts (registered) ----------
    const [
      totalUsers, signupsToday, signups7d, signups30d,
      activeToday, active7d, active30d,
    ] = await Promise.all([
      User.count(),
      User.count({ where: { createdAt: { [Op.gte]: today } } }),
      User.count({ where: { createdAt: { [Op.gte]: daysAgo(7) } } }),
      User.count({ where: { createdAt: { [Op.gte]: daysAgo(30) } } }),
      User.count({ where: { lastLoginAt: { [Op.gte]: today } } }),
      User.count({ where: { lastLoginAt: { [Op.gte]: daysAgo(7) } } }),
      User.count({ where: { lastLoginAt: { [Op.gte]: daysAgo(30) } } }),
    ]);

    // ---------- 1b. Visitor counts (anonymous + registered) ----------
    const [visitorsToday, visitors7d, visitors30d] = await Promise.all([
      countDistinctVisitors(today),
      countDistinctVisitors(daysAgo(7)),
      countDistinctVisitors(daysAgo(30)),
    ]);

    // ---------- 2. Portfolio & watchlist adoption ----------
    const users = await User.findAll({
      attributes: ['email', 'portfolio', 'watchlist', 'country'],
    });

    const usersWithPortfolio = users.filter(u => Array.isArray(u.portfolio) && u.portfolio.length > 0).length;
    const usersWithWatchlist = users.filter(u => Array.isArray(u.watchlist) && u.watchlist.length > 0).length;

    let totalHoldings = 0, totalWatched = 0;
    const holdingCounts = {}, watchCounts = {}, countryCounts = {};

    for (const u of users) {
      if (Array.isArray(u.portfolio)) {
        totalHoldings += u.portfolio.length;
        for (const h of u.portfolio) {
          if (h?.symbol) {
            const s = String(h.symbol).toUpperCase();
            holdingCounts[s] = (holdingCounts[s] || 0) + 1;
          }
        }
      }
      if (Array.isArray(u.watchlist)) {
        totalWatched += u.watchlist.length;
        for (const w of u.watchlist) {
          if (w?.symbol) {
            const s = String(w.symbol).toUpperCase();
            watchCounts[s] = (watchCounts[s] || 0) + 1;
          }
        }
      }
      const c = u.country && u.country.trim() ? u.country.trim() : 'Unknown';
      countryCounts[c] = (countryCounts[c] || 0) + 1;
    }

    const topHoldings = Object.entries(holdingCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([symbol,count])=>({symbol,count}));
    const topWatched = Object.entries(watchCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([symbol,count])=>({symbol,count}));
    const countryBreakdown = Object.entries(countryCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([country,count])=>({country,count}));

    // ---------- 3. Signups timeline (last 30 days) ----------
    const signupsTimeline = await User.findAll({
      attributes: [
        [fn('DATE', col('createdAt')), 'date'],
        [fn('COUNT', '*'), 'count'],
      ],
      where: { createdAt: { [Op.gte]: daysAgo(30) } },
      group: [fn('DATE', col('createdAt'))],
      order: [[fn('DATE', col('createdAt')), 'ASC']],
      raw: true,
    });

    // ---------- 4. Daily active VISITORS (last 30 days) ----------
    // ✅ FIXED: No longer filters out anonymous users.
    // Uses COALESCE(userEmail, visitorId) so both are counted as distinct people.
    const dauTimeline = await Event.findAll({
      attributes: [
        [fn('DATE', col('createdAt')), 'date'],
        [literal('COUNT(DISTINCT COALESCE("userEmail", "visitorId"))'), 'count'],
      ],
      where: { createdAt: { [Op.gte]: daysAgo(30) } },
      group: [fn('DATE', col('createdAt'))],
      order: [[fn('DATE', col('createdAt')), 'ASC']],
      raw: true,
    });

    // ---------- 5. Feature usage (last 30 days) ----------
    const featureUsage = await Event.findAll({
      attributes: [
        'eventType',
        [fn('COUNT', '*'), 'count'],
      ],
      where: { createdAt: { [Op.gte]: daysAgo(30) } },
      group: ['eventType'],
      order: [[fn('COUNT', '*'), 'DESC']],
      raw: true,
    });

    // ---------- 6. Top searched tickers ----------
    const searchEvents = await Event.findAll({
      where: { eventType: 'search', createdAt: { [Op.gte]: daysAgo(30) } },
      attributes: ['eventData'],
      raw: true,
    });
    const searchCounts = {};
    for (const e of searchEvents) {
      const q = String(e.eventData?.query || '').toLowerCase().trim();
      if (q && q.length >= 2) searchCounts[q] = (searchCounts[q] || 0) + 1;
    }
    const topSearches = Object.entries(searchCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([query,count])=>({query,count}));

    // ---------- 7. Top viewed stocks ----------
    const viewEvents = await Event.findAll({
      where: { eventType: 'view_stock', createdAt: { [Op.gte]: daysAgo(30) } },
      attributes: ['eventData'],
      raw: true,
    });
    const viewCounts = {};
    for (const e of viewEvents) {
      const s = String(e.eventData?.symbol || '').toUpperCase();
      if (s) viewCounts[s] = (viewCounts[s] || 0) + 1;
    }
    const topViewed = Object.entries(viewCounts).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([symbol,count])=>({symbol,count}));

    // ---------- 8. Chat usage breakdown ----------
    const chatEvents = await Event.findAll({
      where: { eventType: 'chat_message', createdAt: { [Op.gte]: daysAgo(30) } },
      attributes: ['eventData'],
      raw: true,
    });
    const chatBreakdown = { stock: 0, portfolio: 0, generic: 0 };
    for (const e of chatEvents) {
      const t = e.eventData?.context || 'generic';
      if (chatBreakdown[t] != null) chatBreakdown[t] += 1;
      else chatBreakdown.generic += 1;
    }

    // ---------- 9. Top viewed articles ----------
    const articleEvents = await Event.findAll({
      where: { eventType: 'view_article', createdAt: { [Op.gte]: daysAgo(30) } },
      attributes: ['eventData'],
      raw: true,
    });
    const articleCounts = {};
    for (const e of articleEvents) {
      const slug = String(e.eventData?.slug || '');
      if (slug) articleCounts[slug] = (articleCounts[slug] || 0) + 1;
    }
    const topArticles = Object.entries(articleCounts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([slug,count])=>({slug,count}));

    // ---------- 10. Cohort retention ----------
    const cohorts = [];
    const nowUTC = new Date();
    for (let w = 7; w >= 0; w--) {
      const weekStart = new Date(nowUTC);
      weekStart.setDate(weekStart.getDate() - (w * 7) - 6);
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const cohortUsers = await User.findAll({
        where: { createdAt: { [Op.gte]: weekStart, [Op.lt]: weekEnd } },
        attributes: ['email'],
        raw: true,
      });
      const cohortEmails = cohortUsers.map(u => u.email);
      if (cohortEmails.length === 0) continue;

      const cohortData = { week: weekStart.toISOString().slice(0, 10), size: cohortEmails.length, w1: 0, w2: 0, w4: 0 };

      const w1End = new Date(weekStart); w1End.setDate(w1End.getDate() + 14);
      const w1Active = await Event.count({
        where: { userEmail: { [Op.in]: cohortEmails }, createdAt: { [Op.gte]: weekStart, [Op.lt]: w1End } },
        distinct: true,
        col: 'userEmail',
      });
      cohortData.w1 = Math.round((w1Active / cohortEmails.length) * 100);

      const w2End = new Date(weekStart); w2End.setDate(w2End.getDate() + 21);
      const w2Active = await Event.count({
        where: { userEmail: { [Op.in]: cohortEmails }, createdAt: { [Op.gte]: w1End, [Op.lt]: w2End } },
        distinct: true,
        col: 'userEmail',
      });
      cohortData.w2 = Math.round((w2Active / cohortEmails.length) * 100);

      const w4End = new Date(weekStart); w4End.setDate(w4End.getDate() + 35);
      const w4Active = await Event.count({
        where: { userEmail: { [Op.in]: cohortEmails }, createdAt: { [Op.gte]: new Date(weekStart.getTime() + 21 * 86400000), [Op.lt]: w4End } },
        distinct: true,
        col: 'userEmail',
      });
      cohortData.w4 = Math.round((w4Active / cohortEmails.length) * 100);

      cohorts.push(cohortData);
    }

    // ---------- Stickiness (visitor-based now) ----------
    const stickiness = visitors30d > 0 ? Math.round((visitorsToday / visitors30d) * 100) : 0;
    const dailyStickiness = visitors7d > 0 ? Math.round((visitorsToday / visitors7d) * 100) : 0;

    res.json({
      generatedAt: now.toISOString(),
      users: {
        // Registered users
        total: totalUsers,
        signupsToday, signups7d, signups30d,
        activeToday, active7d, active30d,
        // ✅ NEW: Visitors (anonymous + registered)
        visitorsToday, visitors7d, visitors30d,
        usersWithPortfolio, usersWithWatchlist,
        portfolioAdoptionPct: totalUsers > 0 ? Math.round((usersWithPortfolio / totalUsers) * 100) : 0,
        watchlistAdoptionPct: totalUsers > 0 ? Math.round((usersWithWatchlist / totalUsers) * 100) : 0,
        stickiness,
        dailyStickiness,
      },
      holdings: {
        totalHoldings, totalWatched,
        avgHoldingsPerUser: usersWithPortfolio > 0 ? (totalHoldings / usersWithPortfolio).toFixed(1) : '0',
        topHoldings, topWatched,
      },
      timelines: {
        signups: signupsTimeline,
        dau: dauTimeline,
      },
      featureUsage,
      topSearches,
      topViewed,
      chat: chatBreakdown,
      topArticles,
      geography: { countryBreakdown },
      cohorts,
    });
  } catch (e) {
    console.error('Analytics dashboard error:', e);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// ---------- GET /api/analytics/users ----------
router.get('/users', adminOnly, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;
    const search = String(req.query.search || '').trim().toLowerCase();

    const where = search ? { email: { [Op.iLike]: `%${search}%` } } : {};

    const { count, rows } = await User.findAndCountAll({
      where,
      attributes: ['email', 'country', 'createdAt', 'lastLoginAt', 'loginCount', 'portfolio', 'watchlist'],
      order: [['createdAt', 'DESC']],
      limit,
      offset,
    });

    const emails = rows.map(r => r.email);
    const eventCounts = {};
    if (emails.length > 0) {
      const counts = await Event.findAll({
        attributes: ['userEmail', [fn('COUNT', '*'), 'count']],
        where: { userEmail: { [Op.in]: emails }, createdAt: { [Op.gte]: daysAgo(7) } },
        group: ['userEmail'],
        raw: true,
      });
      for (const c of counts) eventCounts[c.userEmail] = parseInt(c.count);
    }

    const users = rows.map(u => ({
      email: u.email,
      country: u.country || '',
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      loginCount: u.loginCount || 0,
      holdingsCount: Array.isArray(u.portfolio) ? u.portfolio.length : 0,
      watchlistCount: Array.isArray(u.watchlist) ? u.watchlist.length : 0,
      eventsLast7d: eventCounts[u.email] || 0,
    }));

    res.json({ total: count, limit, offset, users });
  } catch (e) {
    console.error('Analytics users error:', e);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;