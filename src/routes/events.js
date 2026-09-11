/* backend/src/routes/events.js
 * Receives batched analytics events from the frontend.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Event = require('../models/Event');

// Whitelist of event types we accept
const ALLOWED_EVENTS = new Set([
  // Existing events
  'search',
  'view_stock',
  'add_portfolio',
  'add_watchlist',
  'add_compare',
  'remove_portfolio',
  'remove_watchlist',
  'remove_compare',
  'run_simulator',
  'export_csv',
  'export_pdf',
  'share_whatsapp',
  'chat_message',
  'explain_this',
  'view_article',
  'open_calendar',
  'open_comparison',
  'open_portfolio',
  'open_watchlist',
  'toggle_theme',
  'toggle_market',
  // ✅ NEW: Millionaire Simulator events
  'open_millionaire_simulator',
  'millionaire_autocomplete_select',
  'millionaire_select_from_leaderboard',
  'millionaire_select_from_history',
  'millionaire_share_download',
  'millionaire_share_tweet',
  'millionaire_share_copy',
  'millionaire_share_whatsapp',
]);

router.post('/', async (req, res) => {
  try {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'events array required' });
    }

    // Optional auth to attach email
    let userEmail = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        userEmail = decoded.email;
      } catch (e) {}
    }

    // Cap batch size
    const batch = events.slice(0, 50);

    const rows = batch
      .filter(e => e && ALLOWED_EVENTS.has(e.event_type))
      .map(e => ({
        userEmail,
        eventType: e.event_type,
        eventData: e.event_data || {},
        sessionId: e.session_id || null,
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