/* backend/src/routes/chat.js
 * AI chat proxy with rate limiting, compliance guardrails, and contextual stock awareness.
 */

const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const router = express.Router();

// ---------- CONFIG ----------
const DAILY_LIMIT = 10;
const MINUTE_LIMIT = 5;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'z-ai/glm-5.2:free',
  'minimax/minimax-m3:free',
  'google/gemma-4-31b-it:free',
];

// ---------- BASE SYSTEM PROMPT ----------
const BASE_SYSTEM_PROMPT = `You are DividendBro AI, an educational assistant for dividend investing on dividendbro.com.

STRICT RULES — you must follow these at all times:
1. NEVER recommend buying, selling, or holding any specific stock.
2. NEVER predict stock prices or future returns.
3. NEVER say "you should invest in X" or "X is a good buy."
4. ALWAYS frame answers as educational explanations.
5. ALWAYS append this exact sentence at the end of your answer: "This is educational only, not financial advice."
6. If the user asks for a recommendation, reply: "I can share general information about dividends and stocks, but I cannot recommend specific investments. Please consult a licensed financial adviser."
7. Keep answers under 200 words unless the user explicitly asks for detail.
8. Use plain English. Explain jargon when you use it.
9. If you don't know something, say "I don't have that information" — never guess.
10. You focus on: dividend yields, payout ratios, DRIP, dividend streaks, REITs, US and SGX stocks.

Tone: friendly, clear, helpful. No emojis unless the user uses them first.`;

// ---------- BUILD CONTEXT-AWARE PROMPT ----------
function buildSystemPrompt(context) {
  if (!context || !context.symbol) return BASE_SYSTEM_PROMPT;

  const metrics = [];
  if (context.name) metrics.push(`- Name: ${context.name}`);
  if (context.symbol) metrics.push(`- Symbol: ${context.symbol}`);
  if (context.market) metrics.push(`- Market: ${context.market.toUpperCase()}`);
  if (context.price != null) metrics.push(`- Current Price: ${context.currencySymbol || '$'}${Number(context.price).toFixed(2)}`);
  if (context.yield != null) metrics.push(`- Current Dividend Yield: ${Number(context.yield).toFixed(2)}%`);
  if (context.totalDividend != null) metrics.push(`- Total Dividends Paid (per share, all-time): ${context.currencySymbol || '$'}${Number(context.totalDividend).toFixed(2)}`);
  if (context.payoutCount != null) metrics.push(`- Number of Payouts on Record: ${context.payoutCount}`);
  if (context.payoutRatio != null) metrics.push(`- Payout Ratio: ${Number(context.payoutRatio).toFixed(2)}%`);
  if (context.dividendCAGR != null) metrics.push(`- 5Y Dividend CAGR: ${Number(context.dividendCAGR).toFixed(2)}%`);
  if (context.safetyScore) metrics.push(`- Safety Score: ${context.safetyScore}`);
  if (context.lastExDate) metrics.push(`- Last Ex-Dividend Date: ${context.lastExDate}`);
  if (context.sector) metrics.push(`- Sector: ${context.sector}`);

  return `${BASE_SYSTEM_PROMPT}

--- CURRENT CONTEXT ---
The user is currently viewing this stock on DividendBro.com:
${metrics.join('\n')}

When answering, prioritise this stock. Use the exact metrics above when relevant. Do NOT invent metrics that are not listed above. If the user asks about something you don't have data for, say so.
--- END CONTEXT ---`;
}

// ---------- RATE LIMITER ----------
const userRateLimits = new Map();

function checkRateLimit(key) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const minute = now.toISOString().slice(0, 16);

  const record = userRateLimits.get(key) || { day: '', count: 0, minute: '', minuteCount: 0 };

  if (record.day !== day) { record.day = day; record.count = 0; }
  if (record.minute !== minute) { record.minute = minute; record.minuteCount = 0; }

  if (record.count >= DAILY_LIMIT) {
    return { allowed: false, reason: `Daily limit of ${DAILY_LIMIT} messages reached. Please come back tomorrow.` };
  }
  if (record.minuteCount >= MINUTE_LIMIT) {
    return { allowed: false, reason: `Please wait a moment before sending more messages.` };
  }

  record.count += 1;
  record.minuteCount += 1;
  userRateLimits.set(key, record);
  return { allowed: true };
}

// ---------- CHAT ENDPOINT ----------
router.post('/', async (req, res) => {
  let userEmail = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
      userEmail = decoded.email;
    } catch (e) {}
  }

  const limitKey = userEmail || req.ip;
  const rateCheck = checkRateLimit(limitKey);
  if (!rateCheck.allowed) {
    return res.status(429).json({ error: rateCheck.reason });
  }

  const { messages, context } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const recentMessages = messages.slice(-10).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: String(m.content || '').slice(0, 2000),
  }));

  const systemPrompt = buildSystemPrompt(context);
  if (context?.symbol) console.log(`📊 Chat context: ${context.symbol}`);

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });

    const payload = {
      messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
      max_tokens: 500,
      temperature: 0.5,
    };

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dividendbro.com',
      'X-Title': 'DividendBro AI',
    };

    let aiMessage = null;
    let lastError = null;

    for (const model of MODELS) {
      try {
        console.log(`🤖 Trying: ${model}`);
        const response = await axios.post(
          OPENROUTER_URL,
          { ...payload, model },
          { headers, timeout: 30000 }
        );
        aiMessage = response.data?.choices?.[0]?.message?.content;
        if (aiMessage) {
          console.log(`✅ Success: ${model}`);
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`❌ Failed ${model}:`, err.response?.data?.error?.message || err.message);
      }
    }

    if (!aiMessage) throw lastError || new Error('All AI models failed');
    res.json({ reply: aiMessage });
  } catch (err) {
    console.error('Chat AI error:', err.response?.data || err.message);
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || 'AI service temporarily unavailable.';
    res.status(status).json({ error: message });
  }
});

module.exports = router;