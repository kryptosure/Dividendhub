const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// ---------- Helper: check if email is admin ----------
function isAdminEmail(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails.includes(String(email).toLowerCase());
}

function signToken(email) {
  return jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
}

/* ============================================================
   ✅ Google OAuth — registered only when env vars are present.
   This lets the server boot without Google configured (local dev,
   or Render before you've added the vars). If any var is missing,
   the /google routes return a clean 503 instead of crashing boot.
   ============================================================ */
const GOOGLE_OAUTH_ENABLED =
  !!process.env.GOOGLE_CLIENT_ID &&
  !!process.env.GOOGLE_CLIENT_SECRET &&
  !!process.env.GOOGLE_CALLBACK_URL;

if (GOOGLE_OAUTH_ENABLED) {
  passport.use(
    new GoogleStrategy(
      {
        clientID:     process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:  process.env.GOOGLE_CALLBACK_URL,
      },
      async (_accessToken, _refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value?.toLowerCase();
          if (!email) return done(new Error('Google account has no email'), null);

          // 1) Already linked by googleId
          let user = await User.findOne({ where: { googleId: profile.id } });

          // 2) Existing email → link Google to it
          if (!user) {
            user = await User.findByPk(email);
            if (user) {
              user.googleId = profile.id;
              await user.save();
            }
          }

          // 3) Brand new → create Google-only user
          if (!user) {
            user = await User.create({
              email,
              password: null,
              googleId: profile.id,
              country: '',
              portfolio: [],
              watchlist: [],
              createdAt: new Date(),
              lastLoginAt: new Date(),
              loginCount: 1,
            });
          } else {
            user.lastLoginAt = new Date();
            user.loginCount = (user.loginCount || 0) + 1;
            await user.save();
          }

          return done(null, user);
        } catch (err) {
          return done(err, null);
        }
      }
    )
  );
  console.log('✅ Google OAuth enabled');
} else {
  console.warn(
    '⚠️  Google OAuth disabled — set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALLBACK_URL to enable.'
  );
}

/* ---------- Google routes (guarded) ---------- */

router.get(
  '/google',
  (req, res, next) => {
    if (!GOOGLE_OAUTH_ENABLED) {
      return res.status(503).json({
        error: 'Google login is not configured on this server.',
      });
    }
    next();
  },
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    prompt: 'select_account',
  })
);

router.get(
  '/google/callback',
  (req, res, next) => {
    if (!GOOGLE_OAUTH_ENABLED) {
      const frontend = process.env.FRONTEND_URL || '/';
      return res.redirect(`${frontend}/login?error=google_failed`);
    }
    next();
  },
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL || '/'}/login?error=google_failed`,
  }),
  (req, res) => {
    const token = signToken(req.user.email);
    res.redirect(`${process.env.FRONTEND_URL || '/'}/login?token=${token}`);
  }
);

/* ============================================================
   EXISTING ROUTES — unchanged
   ============================================================ */

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

    const token = signToken(email);
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

    // Google-only accounts have no password
    if (!user.password) {
      return res.status(401).json({
        error: 'This account uses Google sign-in. Please continue with Google.',
      });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    user.lastLoginAt = new Date();
    user.loginCount = (user.loginCount || 0) + 1;
    await user.save();

    const token = signToken(email);
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
    const decoded = jwt.verify(token, JWT_SECRET);
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
    const decoded = jwt.verify(token, JWT_SECRET);
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
    const decoded = jwt.verify(token, JWT_SECRET);
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