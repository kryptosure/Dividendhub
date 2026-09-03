const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const USERS_FILE = path.join(__dirname, '../../users.json');

function readUsers() {
  try {
    const data = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch { return {}; }
}
function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

router.post('/signup', async (req, res) => {
  const { email, password, country } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const users = readUsers();
  if (users[email]) {
    return res.status(400).json({ error: 'User already exists' });
  }
  const hashed = await bcrypt.hash(password, 10);
  users[email] = {
    email,
    password: hashed,
    country: country || '',
    portfolio: [],
  };
  writeUsers(users);
  const token = jwt.sign({ email }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: '30d' });
  res.json({ token, portfolio: [] });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const users = readUsers();
  const user = users[email];
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ email }, process.env.JWT_SECRET || 'your-secret-key', { expiresIn: '30d' });
  res.json({ token, portfolio: user.portfolio || [] });
});

router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const users = readUsers();
    const user = users[decoded.email];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ email: user.email, country: user.country, portfolio: user.portfolio || [] });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

router.put('/portfolio', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    const { portfolio } = req.body;
    if (!Array.isArray(portfolio)) {
      return res.status(400).json({ error: 'Portfolio must be an array' });
    }
    const users = readUsers();
    if (!users[decoded.email]) {
      return res.status(404).json({ error: 'User not found' });
    }
    users[decoded.email].portfolio = portfolio;
    writeUsers(users);
    res.json({ success: true });
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;