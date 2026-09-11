/* backend/src/routes/chat.js
 * AI chat proxy with rate limiting, compliance guardrails, context awareness,
 * and follow-up suggestion generation.
 */

const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const router = express.Router();

// ---------- CONFIG ----------
const DAILY_LIMIT = 10;
const MINUTE_LIMIT = 5;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SUGGESTIONS_DELIMITER = '---SUGGESTIONS---';

const MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'deepseek/deepseek-r1-0528:free',
  'z-ai/glm-5.2:free',
  'qwen/qwen3-235b-a22b:free',
  'minimax/minimax-m3:free',
  'google/gemma-4-31b-it:free',
];

// ---------- BASE SYSTEM PROMPT ----------
const BASE_SYSTEM_PROMPT = `You are DividendBro AI — a knowledgeable, friendly dividend investing educator on dividendbro.com.

## Your Role
Help users understand dividend investing in a way that feels like talking to a smart friend who happens to be a financial educator. Be specific, insightful, and practical. Use real numbers and examples from the context provided.

## Answer Style
- Write in clear, natural paragraphs (2-4 short paragraphs usually). Avoid bullet-point dumps unless the user asks for a list.
- When numbers are available in the context, USE them. Don't say "a typical stock" if you know the exact yield — say "this stock's 5.8% yield".
- Explain the "why" behind metrics. Don't just state facts — tell the user what they mean and why they matter.
- If the user asks a comparative or open-ended question, give them a thoughtful mini-analysis, not a one-line answer.
- If they ask a simple factual question, answer it directly without padding.

## STRICT COMPLIANCE RULES (never break these)
1. NEVER recommend buying, selling, or holding a specific stock.
2. NEVER predict stock prices or future returns.
3. NEVER say "you should invest in X" or "X is a good buy" or "consider selling X".
4. ALWAYS frame answers as educational explanations.
5. End EVERY answer with this exact sentence on its own line: "This is educational only, not financial advice."
6. If asked for a recommendation, say: "I can share what the numbers currently show, but I can't recommend specific investments. Please consult a licensed financial adviser."
7. If you don't have information, say so honestly. Never invent metrics, dates, or company facts.
8. Do not use emojis unless the user uses them first.

## Follow-Up Suggestions (VERY IMPORTANT)
After EVERY answer, you MUST append exactly 3 follow-up questions the user might naturally ask next.
Format them EXACTLY like this, on a new line after the disclaimer:

${SUGGESTIONS_DELIMITER}
Question 1?
Question 2?
Question 3?

Rules for suggestions:
- Each suggestion must be a SINGLE question ending in "?".
- Keep each suggestion under 60 characters.
- They must be natural follow-ups to the current answer, not repeats.
- They must be answerable by you (educational, not asking for recommendations).
- Do NOT include the word "You" at the start unless it makes sense.
- Do NOT add bullet points, numbers, or prefixes like "-" or "1.".
- Just the raw question text on each line.`;

// ---------- STOCK CONTEXT ----------
function buildStockPrompt(context) {
  const metrics = [];
  if (context.name) metrics.push(`Name: ${context.name}`);
  if (context.symbol) metrics.push(`Symbol: ${context.symbol}`);
  if (context.market) metrics.push(`Market: ${context.market.toUpperCase()}`);
  if (context.price != null) metrics.push(`Current Price: ${context.currencySymbol || '$'}${Number(context.price).toFixed(2)}`);
  if (context.yield != null) metrics.push(`Dividend Yield: ${Number(context.yield).toFixed(2)}%`);
  if (context.totalDividend != null) metrics.push(`Total Dividends Paid Per Share (all-time): ${context.currencySymbol || '$'}${Number(context.totalDividend).toFixed(2)}`);
  if (context.payoutCount != null) metrics.push(`Number of Payouts on Record: ${context.payoutCount}`);
  if (context.payoutRatio != null) metrics.push(`Payout Ratio: ${Number(context.payoutRatio).toFixed(2)}%`);
  if (context.dividendCAGR != null) metrics.push(`5-Year Dividend CAGR: ${Number(context.dividendCAGR).toFixed(2)}%`);
  if (context.safetyScore) metrics.push(`Safety Score: ${context.safetyScore}`);
  if (context.lastExDate) metrics.push(`Last Ex-Dividend Date: ${context.lastExDate}`);

  return `${BASE_SYSTEM_PROMPT}

---
## CURRENT CONTEXT
The user is viewing **${context.name || context.symbol}** (${context.symbol}) on DividendBro.com.

Known metrics:
${metrics.join('\n')}

Reference these exact numbers in your answer when relevant. Do NOT invent any metric that isn't in the list above.
---`;
}

// ---------- PORTFOLIO CONTEXT ----------
function buildPortfolioPrompt(context) {
  const { holdings = [], totals = {}, currency = 'USD', currencySymbol = '$' } = context;

  const holdingLines = holdings.map((h, i) => {
    const parts = [`${i + 1}. ${h.symbol}${h.name ? ' (' + h.name + ')' : ''}`];
    if (h.shares != null) parts.push(`Shares: ${h.shares}`);
    if (h.valueInBase != null) parts.push(`Value: ${currencySymbol}${Number(h.valueInBase).toFixed(2)}`);
    if (h.yieldPct != null) parts.push(`Yield: ${Number(h.yieldPct).toFixed(2)}%`);
    if (h.annualIncomeInBase != null) parts.push(`Annual Income: ${currencySymbol}${Number(h.annualIncomeInBase).toFixed(2)}`);
    if (h.gain != null) parts.push(`Gain/Loss: ${currencySymbol}${Number(h.gain).toFixed(2)}`);
    if (h.gainPct != null) parts.push(`Return: ${Number(h.gainPct).toFixed(2)}%`);
    if (h.safetyScore) parts.push(`Safety: ${h.safetyScore}`);
    return parts.join(' | ');
  }).join('\n');

  const totalsLines = [
    totals.totalValue != null ? `- Total Portfolio Value: ${currencySymbol}${Number(totals.totalValue).toFixed(2)}` : null,
    totals.totalCostBasis != null ? `- Total Cost Basis: ${currencySymbol}${Number(totals.totalCostBasis).toFixed(2)}` : null,
    totals.totalGain != null ? `- Total Capital Gain/Loss: ${currencySymbol}${Number(totals.totalGain).toFixed(2)}${totals.totalGainPct != null ? ` (${Number(totals.totalGainPct).toFixed(2)}%)` : ''}` : null,
    totals.totalAnnualDividend != null ? `- Annual Dividend Income (forward-looking): ${currencySymbol}${Number(totals.totalAnnualDividend).toFixed(2)}` : null,
    totals.totalDividendIncome != null ? `- Total Dividends Received (all-time): ${currencySymbol}${Number(totals.totalDividendIncome).toFixed(2)}` : null,
    totals.avgYield != null ? `- Weighted Average Yield: ${Number(totals.avgYield).toFixed(2)}%` : null,
    totals.holdingCount != null ? `- Number of Holdings: ${totals.holdingCount}` : null,
    `- Base Currency: ${currency}`,
  ].filter(Boolean).join('\n');

  return `${BASE_SYSTEM_PROMPT}

---
## PORTFOLIO CONTEXT
The user is asking about **their own dividend portfolio**.

### Portfolio Totals
${totalsLines}

### Individual Holdings
${holdingLines}

## How to Answer Portfolio Questions
- Cite exact numbers. If they ask about income, say "$1,234.56" not "a few hundred dollars".
- Add insight, not just facts. If their top holding is 40% of the portfolio, point that out.
- Connect holdings when relevant. If two holdings are Singapore banks, mention the sector concentration.
- Compute comparisons from the numbers. "Verizon's yield (6.2%) is nearly double SCHD's (3.5%)."

## Special Rules
- You MAY cite exact numbers and describe observations.
- You MAY NOT recommend rebalancing, selling, or buying.
- You MAY NOT say "your portfolio is good/bad/risky".
- If asked for advice: "I can describe what your numbers show, but for allocation decisions please consult a licensed financial adviser."
---`;
}

// ---------- SYSTEM PROMPT ROUTER ----------
function buildSystemPrompt(context) {
  if (!context) return BASE_SYSTEM_PROMPT;
  if (context.type === 'portfolio' && Array.isArray(context.holdings)) return buildPortfolioPrompt(context);
  if (context.symbol) return buildStockPrompt(context);
  return BASE_SYSTEM_PROMPT;
}

// ---------- PARSE AI RESPONSE ----------
function parseAIResponse(raw) {
  if (!raw) return { reply: '', suggestions: [] };

  const idx = raw.indexOf(SUGGESTIONS_DELIMITER);
  if (idx === -1) {
    // AI didn't include suggestions — fall back gracefully
    return { reply: raw.trim(), suggestions: [] };
  }

  const reply = raw.slice(0, idx).trim();
  const suggestionsBlock = raw.slice(idx + SUGGESTIONS_DELIMITER.length).trim();

  const suggestions = suggestionsBlock
    .split('\n')
    .map(line => line.trim())
    .map(line => line.replace(/^[-•*\d.)\s]+/, '').trim())  // strip bullets/numbers
    .filter(line => line.length > 0 && line.endsWith('?'))
    .map(line => line.slice(0, 80))  // cap each suggestion length
    .slice(0, 3);

  return { reply, suggestions };
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
  if (context?.type === 'portfolio') console.log(`💼 Chat context: PORTFOLIO (${context.holdings?.length || 0} holdings)`);
  else if (context?.symbol) console.log(`📊 Chat context: ${context.symbol}`);

  try {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });

    const payload = {
      messages: [{ role: 'system', content: systemPrompt }, ...recentMessages],
      max_tokens: 1200,      // ← Increased to fit answer + suggestions
      temperature: 0.6,
      top_p: 0.95,
    };

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dividendbro.com',
      'X-Title': 'DividendBro AI',
    };

    let rawMessage = null;
    let lastError = null;

    for (const model of MODELS) {
      try {
        console.log(`🤖 Trying: ${model}`);
        const response = await axios.post(
          OPENROUTER_URL,
          { ...payload, model },
          { headers, timeout: 45000 }
        );
        rawMessage = response.data?.choices?.[0]?.message?.content;
        if (rawMessage) {
          console.log(`✅ Success: ${model}`);
          break;
        }
      } catch (err) {
        lastError = err;
        console.warn(`❌ Failed ${model}:`, err.response?.data?.error?.message || err.message);
      }
    }

    if (!rawMessage) throw lastError || new Error('All AI models failed');

    const { reply, suggestions } = parseAIResponse(rawMessage);
    console.log(`📝 Reply: ${reply.length} chars, ${suggestions.length} suggestions`);

    res.json({ reply, suggestions });
  } catch (err) {
    console.error('Chat AI error:', err.response?.data || err.message);
    const status = err.response?.status || 500;
    const message = err.response?.data?.error?.message || 'AI service temporarily unavailable.';
    res.status(status).json({ error: message });
  }
});

module.exports = router;