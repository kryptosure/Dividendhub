/* backend/src/routes/incomePlanner.js
 * Illustrative income-target portfolio generator.
 * Educational tool only — not investment advice.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { generateAllocation, RISK_PROFILES } = require('../services/incomePlanner');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please try again in a minute.' },
});

// GET /api/income-planner/profiles — the risk profile definitions
router.get('/profiles', (req, res) => {
  const profiles = Object.values(RISK_PROFILES).map(p => ({
    key: p.key,
    label: p.label,
    tagline: p.tagline,
    description: p.description,
    expectedYieldRange: p.expectedYieldRange,
  }));
  res.json(profiles);
});

// POST /api/income-planner/generate
router.post('/generate', limiter, async (req, res) => {
  try {
    const {
      targetMonthly,
      capital = 0,
      location = 'SG',
      riskProfile = 'balanced',
    } = req.body || {};

    if (!isFinite(Number(targetMonthly)) || Number(targetMonthly) <= 0) {
      return res.status(400).json({ error: 'targetMonthly must be a positive number' });
    }
    if (Number(targetMonthly) > 1000000) {
      return res.status(400).json({ error: 'targetMonthly is unrealistically high' });
    }

    const result = await generateAllocation({
      targetMonthly: Number(targetMonthly),
      capital: Number(capital) || 0,
      location,
      riskProfile,
    });

    if (!result.ok) {
      return res.status(422).json(result);
    }

    res.json(result);
  } catch (e) {
    console.error('Income planner error:', e);
    res.status(500).json({ error: e.message || 'Failed to generate allocation' });
  }
});

module.exports = router;