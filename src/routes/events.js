/* backend/src/routes/events.js
 * Receives batched analytics events from the frontend.
 * Captures Cloudflare's CF-IPCountry header for visitor geo.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Event = require('../models/Event');

const ALLOWED_EVENTS = new Set([
  // Core navigation & discovery
  'page_view',
  'search',
  'view_stock',
  'view_article',
  'toggle_theme',
  'toggle_market',

  // Portfolio & watchlist
  'add_portfolio',
  'remove_portfolio',
  'add_watchlist',
  'remove_watchlist',
  'open_portfolio',
  'open_watchlist',
  'open_calendar',

  // Comparison
  'add_compare',
  'remove_compare',
  'open_comparison',

  // Simulators
  'run_simulator',
  'open_millionaire_simulator',
  'millionaire_autocomplete_select',
  'millionaire_select_from_leaderboard',
  'millionaire_select_from_history',
  'millionaire_share_download',
  'millionaire_share_tweet',
  'millionaire_share_copy',
  'millionaire_share_whatsapp',

  // AI chat
  'chat_message',
  'explain_this',

  // Exports & sharing
  'export_csv',
  'export_pdf',
  'share_whatsapp',

  // ✅ NEW: Income Planner
  'income_planner_generate',
  'income_planner_save_portfolio',

  // ✅ NEW: Screener
  'screener_filter',
]);

router.post('/', async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }

    let userEmail = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        userEmail = decoded.email;
      } catch (e) {}
    }

    const country = String(req.headers['cf-ipcountry'] || '').toUpperCase().slice(0, 2) || null;

    const batch = events.slice(0, 50);

    const rows = batch
      .filter(e => e && ALLOWED_EVENTS.has(e.event_type))
      .map(e => ({
        userEmail,
        eventType: e.event_type,
        eventData: e.event_data || {},
        sessionId: e.session_id || null,
        visitorId: e.visitor_id || null,
        country,
        createdAt: new Date(),
      }));

    if (rows.length > 0) {
      await Event.bulkCreate(rows);
    }

    res.json({ ok: true, logged: rows.length });
  } catch (err) {
    console.error('Event logging error:', err);
    res.status(500).json({ error: 'Failed to log events' });
  }
});

module.exports = router;