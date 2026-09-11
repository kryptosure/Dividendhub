const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// ---------- Helper: check if email is admin ----------
function isAdminEmail(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(String(email).toLowerCase());
}

router.post('/signup', async (req, res) => {
  const { email, password, country } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  try {
    const existingUser = await User.findByPk(email);
    if (existingUser) return res.status(400).json({ error: 'User already exists' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({
      email,
      password: hashed,
      country: country || '',
      portfolio: [],
      watchlist: [],
      createdAt: new Date(),
      lastLoginAt: new Date(),
      loginCount: 1,
    });

    const token = jwt.sign({ email }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: '30d' });
    res.json({
      token,
      portfolio: user.portfolio,
      watchlist: user.watchlist,
      isAdmin: isAdminEmail(email),
    });
  } catch (e) {
    console.error('Signup error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const user = await User.findByPk(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    // Update login tracking
    user.lastLoginAt = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    await user.save();

    const token = jwt.sign({ email }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: '30d' });
    res.json({
      token,
      portfolio: user.portfolio,
      watchlist: user.watchlist,
      isAdmin: isAdminEmail(email),
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const user = await User.findByPk(decoded.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      email: user.email,
      country: user.country,
      portfolio: user.portfolio,
      watchlist: user.watchlist,
      isAdmin: isAdminEmail(user.email),
    });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

router.put('/portfolio', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const { portfolio } = req.body;
    if (!Array.isArray(portfolio)) return res.status(400).json({ error: 'Portfolio must be an array' });
    const user = await User.findByPk(decoded.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.portfolio = portfolio;
    await user.save();
    res.json({ success: true });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

router.put('/watchlist', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const { watchlist } = req.body;
    if (!Array.isArray(watchlist)) return res.status(400).json({ error: 'Watchlist must be an array' });
    const user = await User.findByPk(decoded.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.watchlist = watchlist;
    await user.save();
    res.json({ success: true });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;