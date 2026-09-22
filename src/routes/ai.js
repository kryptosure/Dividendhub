/* backend/src/routes/ai.js
 * Streaming chat endpoint with tool calling.
 * AI can query DividendBro's own database for live stock data.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const router = express.Router();

const Stock = require('../models/stock');
const {
  classifyAssetType,
  computeFrequency,
} = require('../services/stockClassifier');
const { computeDividendMetrics } = require('../services/yahooFinance');

const DAILY_LIMIT = 20;
const MINUTE_LIMIT = 5;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// ✅ Groq retires models on short notice. Try in order.
const MODELS = [
  'openai/gpt-oss-120b',   // Primary: best quality, tool calling support
  'qwen/qwen3.6-27b',      // Fallback: tool calling support
  'openai/gpt-oss-20b',    // Fallback: faster, lighter
];

// ---------- Sector → ticker map for category-based questions ----------
const SECTOR_MAP = {
  ca: {
    banks:     ['RY.TO', 'TD.TO', 'BNS.TO', 'BMO.TO', 'CM.TO', 'NA.TO'],
    energy:    ['ENB.TO', 'TRP.TO', 'PPL.TO', 'SU.TO', 'CNQ.TO', 'FRU.TO'],
    utilities: ['FTS.TO', 'CU.TO'],
    telecom:   ['BCE.TO', 'T.TO'],
    reits:     ['SRU-UN.TO', 'REI-UN.TO', 'GRT-UN.TO', 'CRT-UN.TO', 'CRR-UN.TO', 'DIR-UN.TO', 'VITL-UN.TO', 'CHP-UN.TO'],
  },
  us: {
    banks:     ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'USB', 'PNC', 'TFC', 'COF'],
    energy:    ['XOM', 'CVX', 'COP', 'EOG', 'PSX', 'VLO', 'MPC', 'KMI', 'WMB', 'OKE'],
    utilities: ['NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'XEL', 'ED', 'WEC', 'ES'],
    telecom:   ['VZ', 'T', 'TMUS', 'CMCSA'],
    reits:     ['O', 'STAG', 'LAND', 'LTC', 'ADC', 'EPR', 'GOOD', 'DOC', 'VICI', 'WPC', 'NNN', 'IRM', 'GLPI'],
    tobacco:   ['MO', 'PM'],
    staples:   ['KO', 'PEP', 'PG', 'KHC', 'GIS', 'KMB', 'CL', 'CLX', 'K', 'HSY', 'MDLZ'],
    healthcare:['JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'BMY', 'AMGN', 'GILD', 'MDT', 'ABT'],
    tech:      ['AAPL', 'MSFT', 'IBM', 'INTC', 'CSCO', 'TXN', 'AVGO', 'QCOM', 'ORCL'],
  },
  sg: {
    banks:     ['D05.SI', 'O39.SI', 'U11.SI'],
    telecom:   ['Z74.SI'],
    reits:     ['C38U.SI', 'A17U.SI', 'M44U.SI', 'ME8U.SI', 'N2IU.SI', 'J69U.SI', 'BUOU.SI', 'AJBU.SI', 'K71U.SI', 'T82U.SI'],
  },
};

// ---------- System prompt ----------
const BASE_SYSTEM_PROMPT = `You are DividendBro AI — the assistant for dividendbro.com, a dividend analysis tool covering 672 dividend-paying stocks across US, Canadian (TSX), and Singapore (SGX) markets.

## Your Role
You help users understand dividend investing AND query DividendBro's live data. Be specific, insightful, and cite real numbers from the tools.

## Answer Style
- Write in clear, natural paragraphs (2-4 short paragraphs usually).
- When you have data from a tool, USE it. Say "Enbridge yields 5.65%" not "Enbridge has a decent yield".
- Explain the "why" behind metrics briefly.
- Use markdown formatting: **bold**, bullet points for lists, tables when comparing 3+ items.

## STRICT COMPLIANCE RULES
1. NEVER recommend buying, selling, or holding a specific stock.
2. NEVER predict stock prices or future returns.
3. NEVER say "you should invest in X" or "consider selling X".
4. ALWAYS frame answers as educational explanations.
5. If asked for a recommendation, say: "I can share what the numbers currently show, but I can't recommend specific investments. Please consult a licensed financial adviser."
6. Never invent specific metrics, dates, or numbers. Always use tools.

## Tools Available
You have tools that query DividendBro's live database. USE THEM whenever the user asks about specific stocks, current yields, upcoming dividend dates, categories of stocks, or wants to filter stocks.

Examples that REQUIRE tool calls:
- "What's Enbridge's yield?" → get_stock_details(symbol='ENB.TO', market='ca')
- "Show me top monthly dividend stocks" → screen_stocks(market='us', frequency='monthly')
- "What's paying dividends next week?" → get_upcoming_dividends(market='us', days=7)
- "Is Coca-Cola safe?" → get_stock_details(symbol='KO', market='us')
- "Compare Canadian banks vs US banks" → get_stocks_by_sector(sector='banks', market='ca') AND get_stocks_by_sector(sector='banks', market='us')
- "Show me energy stocks" → get_stocks_by_sector(sector='energy', market='us')
- "List Canadian REITs" → get_stocks_by_sector(sector='reits', market='ca')

If you need data about a CATEGORY of stocks (banks, energy, utilities, telecom, REITs, tobacco, staples, healthcare, tech) rather than a specific ticker, use get_stocks_by_sector. NEVER try to search for a category with search_stocks — that tool only works on specific ticker symbols or company names.

NEVER invent specific numbers. If you don't have them, call a tool.

## Field naming (IMPORTANT — do not misread units)
Tool results use explicit unit suffixes. Read them carefully:
- \`yieldPercent\` — a percentage. 5.65 means 5.65%.
- \`dividendCAGRPercent\` — a percentage. 7.08 means 7.08%.
- \`dividendStreakYears\` — YEARS, not quarters or months. 31 means 31 YEARS.
- \`paymentsPerYear\` — payments per year. 4 = quarterly, 12 = monthly, 1 = annual.

When describing values, always use the correct unit. Say "31 years" NOT "31 quarters".

## Links (IMPORTANT)
When you mention a specific stock, ALWAYS include a markdown link to its DividendBro detail page using the "url" field from the tool result:
[ENB.TO](https://dividendbro.com/search?symbol=ENB.TO) — Enbridge, 5.65% yield

When you mention a tool, feature, or page, link to it:
- [Income Planner](https://dividendbro.com/) — build a sample portfolio for a target income
- [Screener](https://dividendbro.com/screener) — filter all 672 stocks
- [Dividend Calendar](https://dividendbro.com/calendar) — upcoming ex-dates
- [Compare](https://dividendbro.com/compare) — side-by-side stock comparison
- [Millionaire Simulator](https://dividendbro.com/millionaire)

Include 1-3 relevant links in most answers. Make them feel natural, not spammy.

## Format
- Use markdown: **bold**, bullet points, tables.
- Long answers should have ## section headers.

## Follow-Up Suggestions (REQUIRED)
After EVERY answer, you MUST append exactly 3 follow-up questions the user might naturally ask next.

Format them EXACTLY like this, on a new line after your answer:

---SUGGESTIONS---
Question one?
Question two?
Question three?

Rules for suggestions:
- Each must be a single question ending in "?"
- Keep each under 60 characters
- They must be natural follow-ups to the current answer, not repeats
- They must be answerable by you (educational, not asking for recommendations)
- Do NOT add bullets, numbers, or prefixes — just the raw question text
- Do NOT include the disclaimer in the suggestions block
- Do NOT wrap the delimiter in backticks or add other text before it`;

// ---------- Tool definitions ----------
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_stocks',
      description: 'Search DividendBro for dividend-paying stocks by ticker or company name. Returns up to 10 matches with symbol, name, current yield, and price. Does NOT work for categories like "banks" — use get_stocks_by_sector for those.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Ticker or company name (e.g. "Enbridge", "RY.TO", "Apple")' },
          market: { type: 'string', enum: ['us', 'ca', 'sg'], description: 'Market: us, ca (Canada/TSX), sg (Singapore/SGX). Default us.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_details',
      description: 'Get full dividend metrics for a specific stock: price, yield, dividend CAGR, streak in years, safety score, frequency, and the URL to its DividendBro page.',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Exact ticker symbol (e.g. "ENB.TO", "AAPL", "D05.SI")' },
          market: { type: 'string', enum: ['us', 'ca', 'sg'], description: 'Market of the symbol. Default us.' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_top_dividend_stocks',
      description: 'Get the highest-yielding dividend stocks in a market, ranked by yield. Use for discovery questions.',
      parameters: {
        type: 'object',
        properties: {
          market: { type: 'string', enum: ['us', 'ca', 'sg'] },
          count: { type: 'integer', description: 'Number of stocks (default 10, max 20)' },
        },
        required: ['market'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_upcoming_dividends',
      description: 'Get upcoming estimated ex-dividend dates for stocks in a market over the next N days.',
      parameters: {
        type: 'object',
        properties: {
          market: { type: 'string', enum: ['us', 'ca', 'sg'] },
          days: { type: 'integer', description: 'Days ahead (default 30, max 90)' },
        },
        required: ['market'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_stocks',
      description: 'Screen DividendBro stocks by payout frequency, asset type, and safety level.',
      parameters: {
        type: 'object',
        properties: {
          market: { type: 'string', enum: ['us', 'ca', 'sg'] },
          frequency: { type: 'string', enum: ['daily', 'weekly', 'bi-weekly', 'monthly', 'quarterly', 'semi-annual', 'annual'] },
          assetType: { type: 'string', enum: ['stock', 'reit', 'etf', 'bond-etf', 'preferred'] },
          safety: { type: 'string', enum: ['safe', 'moderate', 'caution'] },
          limit: { type: 'integer', description: 'Max results (default 15, max 30)' },
        },
        required: ['market'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stocks_by_sector',
      description: 'Get all DividendBro stocks in a specific sector/category for a market. USE THIS for "compare Canadian banks vs US banks", "show me energy stocks", "list REITs", or any question about a category of stocks rather than a specific ticker.',
      parameters: {
        type: 'object',
        properties: {
          sector: {
            type: 'string',
            enum: ['banks', 'energy', 'utilities', 'telecom', 'reits', 'tobacco', 'staples', 'healthcare', 'tech'],
            description: 'Sector/category to fetch',
          },
          market: { type: 'string', enum: ['us', 'ca', 'sg'] },
          limit: { type: 'integer', description: 'Max stocks to return (default 10, max 20)' },
        },
        required: ['sector', 'market'],
      },
    },
  },
];

// ---------- Upcoming ex-date estimation ----------
function computeUpcomingExDates(byYear, maxDays = 30) {
  if (!Array.isArray(byYear) || byYear.length === 0) return [];
  const allPayouts = [];
  for (const y of byYear) {
    if (Array.isArray(y.payouts)) {
      for (const p of y.payouts) allPayouts.push({ date: p.date, amount: p.amount });
    }
  }
  if (allPayouts.length < 4) return [];
  allPayouts.sort((a, b) => a.date.localeCompare(b.date));
  const recent = allPayouts.slice(-8);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    const d1 = new Date(recent[i - 1].date + 'T00:00:00Z').getTime();
    const d2 = new Date(recent[i].date + 'T00:00:00Z').getTime();
    const days = (d2 - d1) / 86400000;
    if (days > 5 && days < 400) gaps.push(days);
  }
  if (gaps.length === 0) return [];
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  const lastDate = new Date(recent[recent.length - 1].date + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const maxDate = new Date(today.getTime() + maxDays * 86400000);
  let cursor = new Date(lastDate);
  while (cursor < today) cursor = new Date(cursor.getTime() + medianGap * 86400000);
  const upcoming = [];
  while (cursor <= maxDate && upcoming.length < 4) {
    upcoming.push({ date: cursor.toISOString().slice(0, 10), daysFromNow: Math.round((cursor - today) / 86400000) });
    cursor = new Date(cursor.getTime() + medianGap * 86400000);
  }
  return upcoming;
}

// ---------- Tool executors ----------
async function executeTool(name, args) {
  const market = String(args?.market || 'us').toLowerCase();
  const safeMarket = ['us', 'ca', 'sg'].includes(market) ? market : 'us';

  try {
    switch (name) {
      case 'search_stocks': {
        const q = String(args?.query || '').trim();
        if (!q) return { error: 'query required' };
        const rows = await Stock.findAll({
          where: {
            market: safeMarket,
            [Op.or]: [
              { symbol: { [Op.iLike]: `%${q}%` } },
              { name: { [Op.iLike]: `%${q}%` } },
            ],
          },
          limit: 10,
          attributes: ['symbol', 'name', 'market', 'currentYield', 'currentPrice', 'safetyScore'],
          raw: true,
        });
        return {
          market: safeMarket,
          count: rows.length,
          results: rows.map(s => ({
            symbol: s.symbol,
            name: s.name,
            yieldPercent: parseFloat(s.currentYield) || 0,
            price: parseFloat(s.currentPrice) || 0,
            safety: s.safetyScore,
            url: `https://dividendbro.com/search?symbol=${encodeURIComponent(s.symbol)}`,
          })),
        };
      }

      case 'get_stock_details': {
        let symbol = String(args?.symbol || '').toUpperCase().trim();
        if (!symbol) return { error: 'symbol required' };
        if (safeMarket === 'sg' && !symbol.endsWith('.SI')) symbol += '.SI';
        const stock = await Stock.findByPk(symbol);
        if (!stock) {
          return { error: `No DividendBro data for ${symbol}. It may not be in our 672-ticker universe.` };
        }
        const data = stock.dividendData || {};
        const metrics = computeDividendMetrics(data.byYear || []);
        const freq = computeFrequency(data.byYear || []);
        return {
          symbol: stock.symbol,
          name: stock.name,
          market: stock.market,
          currency: data.currency || 'USD',
          price: parseFloat(stock.currentPrice) || null,
          yieldPercent: parseFloat(stock.currentYield) || null,
          dividendCAGRPercent: metrics.dividendCAGR,
          dividendStreakYears: metrics.dividendStreak,
          safety: stock.safetyScore,
          frequency: freq?.label || null,
          paymentsPerYear: freq?.paymentsPerYear || null,
          payoutCount: stock.payoutCount,
          lastExDate: stock.lastExDate,
          url: `https://dividendbro.com/search?symbol=${encodeURIComponent(stock.symbol)}`,
        };
      }

      case 'get_top_dividend_stocks': {
        const count = Math.min(Math.max(parseInt(args?.count) || 10, 1), 20);
        const rows = await Stock.findAll({
          where: { market: safeMarket },
          order: [['currentYield', 'DESC']],
          limit: count,
          attributes: ['symbol', 'name', 'currentYield', 'currentPrice', 'safetyScore'],
          raw: true,
        });
        return {
          market: safeMarket,
          count: rows.length,
          results: rows.map(s => ({
            symbol: s.symbol,
            name: s.name,
            yieldPercent: parseFloat(s.currentYield) || 0,
            price: parseFloat(s.currentPrice) || 0,
            safety: s.safetyScore,
            url: `https://dividendbro.com/search?symbol=${encodeURIComponent(s.symbol)}`,
          })),
        };
      }

      case 'get_upcoming_dividends': {
        const days = Math.min(Math.max(parseInt(args?.days) || 30, 7), 90);
        const rows = await Stock.findAll({ where: { market: safeMarket }, raw: false });
        const events = [];
        for (const s of rows) {
          const data = s.dividendData || {};
          const upcoming = computeUpcomingExDates(data.byYear, days);
          for (const u of upcoming) {
            events.push({
              symbol: s.symbol,
              name: s.name,
              exDate: u.date,
              daysFromNow: u.daysFromNow,
              yieldPercent: parseFloat(s.currentYield) || 0,
              url: `https://dividendbro.com/search?symbol=${encodeURIComponent(s.symbol)}`,
            });
          }
        }
        events.sort((a, b) => a.exDate.localeCompare(b.exDate));
        return {
          market: safeMarket,
          windowDays: days,
          totalEvents: events.length,
          events: events.slice(0, 25),
          note: 'Dates are estimated from historical payout patterns, not confirmed by issuers.',
          calendarUrl: 'https://dividendbro.com/calendar',
        };
      }

      case 'screen_stocks': {
        const limit = Math.min(Math.max(parseInt(args?.limit) || 15, 1), 30);
        const rows = await Stock.findAll({ where: { market: safeMarket } });
        const filtered = [];
        for (const s of rows) {
          const assetType = classifyAssetType(s.symbol, s.name, s.type);
          const freq = computeFrequency(s.dividendData?.byYear || []);
          const safety = s.safetyScore || 'Caution';

          if (args?.assetType && assetType.toLowerCase().replace(/\s+/g, '-') !== String(args.assetType).toLowerCase()) continue;
          if (args?.safety && safety.toLowerCase() !== String(args.safety).toLowerCase()) continue;
          if (args?.frequency && (!freq || freq.label.toLowerCase() !== String(args.frequency).toLowerCase())) continue;

          filtered.push({
            symbol: s.symbol,
            name: s.name,
            assetType,
            frequency: freq?.label || null,
            yieldPercent: parseFloat(s.currentYield) || 0,
            safety,
            url: `https://dividendbro.com/search?symbol=${encodeURIComponent(s.symbol)}`,
          });
          if (filtered.length >= limit * 2) break;
        }
        filtered.sort((a, b) => b.yieldPercent - a.yieldPercent);
        return {
          market: safeMarket,
          filters: {
            frequency: args?.frequency || 'any',
            assetType: args?.assetType || 'any',
            safety: args?.safety || 'any',
          },
          count: filtered.length,
          results: filtered.slice(0, limit),
          screenerUrl: `https://dividendbro.com/screener?market=${safeMarket}`,
        };
      }

      case 'get_stocks_by_sector': {
        const sector = String(args?.sector || '').toLowerCase().trim();
        const limit = Math.min(Math.max(parseInt(args?.limit) || 10, 1), 20);
        const tickers = SECTOR_MAP[safeMarket]?.[sector];
        if (!tickers || tickers.length === 0) {
          return {
            error: `No stocks in category "${sector}" for market "${safeMarket}". Available: ${Object.keys(SECTOR_MAP[safeMarket] || {}).join(', ')}`,
          };
        }
        const rows = await Stock.findAll({
          where: { symbol: { [Op.in]: tickers.slice(0, limit) } },
          attributes: ['symbol', 'name', 'currentYield', 'currentPrice', 'safetyScore'],
          raw: true,
        });
        const bySymbol = {};
        for (const r of rows) bySymbol[r.symbol] = r;
        const ordered = tickers.map(s => bySymbol[s]).filter(Boolean);
        return {
          market: safeMarket,
          sector,
          count: ordered.length,
          results: ordered.map(s => ({
            symbol: s.symbol,
            name: s.name,
            yieldPercent: parseFloat(s.currentYield) || 0,
            price: parseFloat(s.currentPrice) || 0,
            safety: s.safetyScore,
            url: `https://dividendbro.com/search?symbol=${encodeURIComponent(s.symbol)}`,
          })),
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    console.error(`[ai] tool ${name} failed:`, e.message);
    return { error: `Tool ${name} failed: ${e.message}` };
  }
}

// ---------- Rate limiter ----------
const userRateLimits = new Map();
function checkRateLimit(key) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const minute = now.toISOString().slice(0, 16);
  const record = userRateLimits.get(key) || { day: '', count: 0, minute: '', minuteCount: 0 };
  if (record.day !== day) { record.day = day; record.count = 0; }
  if (record.minute !== minute) { record.minute = minute; record.minuteCount = 0; }
  if (record.count >= DAILY_LIMIT) return { allowed: false, reason: `Daily limit of ${DAILY_LIMIT} messages reached.` };
  if (record.minuteCount >= MINUTE_LIMIT) return { allowed: false, reason: 'Slow down — too many messages in a minute.' };
  record.count += 1;
  record.minuteCount += 1;
  userRateLimits.set(key, record);
  return { allowed: true };
}

// ---------- Multi-turn streaming with tool calling ----------
async function* processChat(initialMessages, apiKey) {
  let currentMessages = [...initialMessages];
  const MAX_ROUNDS = 5;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`🤖 [ai] Round ${round}`);

    // ✅ Try each model. On 429, wait briefly and retry the SAME model once
    // before moving on — Groq's per-minute rate windows are often <1s.
    let upstream = null;
    let lastErr = null;
    let allRateLimited = true;
    let sawNonRateLimitError = false;

    for (const model of MODELS) {
      let res = null;
      let attemptErr = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              messages: currentMessages,
              tools: TOOLS,
              tool_choice: 'auto',
              max_tokens: 2000,
              temperature: 0.6,
              stream: true,
            }),
          });

          if (res.ok && res.body) {
            console.log(`✅ [ai] Using model: ${model} (attempt ${attempt})`);
            upstream = res;
            break;
          }

          const text = await res.text().catch(() => '');
          attemptErr = `HTTP ${res.status}: ${text.slice(0, 150)}`;

          // If it's a 429, wait and retry the same model once
          if (res.status === 429 && attempt === 1) {
            console.warn(`⏳ [ai] ${model} rate-limited — retrying in 1200ms`);
            await new Promise((r) => setTimeout(r, 1200));
            continue;
          }

          // Not a 429 or already retried — move to next model
          break;
        } catch (e) {
          attemptErr = e.message;
          break;
        }
      }

      if (upstream) break;

      lastErr = `${model} → ${attemptErr}`;
      console.warn(`❌ [ai] ${lastErr}`);

      // Track whether this was a rate-limit vs other error
      if (!attemptErr || !attemptErr.includes('429')) {
        allRateLimited = false;
        sawNonRateLimitError = true;
      }
    }

    if (!upstream || !upstream.body) {
      // If every failure was a 429, send back a friendly rate-limit message
      if (allRateLimited && !sawNonRateLimitError) {
        throw new Error('AI is briefly overloaded. Please wait 20-30 seconds and try again.');
      }
      throw new Error(lastErr || 'All Groq models failed');
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallsMap = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          yield { type: 'content', value: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = { id: tc.id || `call_${idx}`, name: '', arguments: '' };
            }
            if (tc.id) toolCallsMap[idx].id = tc.id;
            if (tc.function?.name) toolCallsMap[idx].name += tc.function.name;
            if (tc.function?.arguments) toolCallsMap[idx].arguments += tc.function.arguments;
          }
        }
      }
    }

    const toolCalls = Object.values(toolCallsMap).filter(tc => tc.name);

    if (toolCalls.length === 0) {
      console.log(`✅ [ai] Done in round ${round} (no tools)`);
      return;
    }

    console.log(`🔧 [ai] Executing ${toolCalls.length} tool call(s):`,
      toolCalls.map(t => t.name).join(', '));

    currentMessages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments || '{}' },
      })),
    });

    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.arguments || '{}'); } catch {}
      const result = await executeTool(tc.name, args);
      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.warn('⚠️ [ai] Max tool rounds reached');
}

// ---------- Route ----------
router.post('/chat', async (req, res) => {
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured' });

  const fullMessages = [
    { role: 'system', content: BASE_SYSTEM_PROMPT },
    ...messages.slice(-10).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content || '').slice(0, 3000),
    })),
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  try {
    for await (const event of processChat(fullMessages, apiKey)) {
      if (event.type === 'content') {
        res.write(`data: ${JSON.stringify({
          choices: [{ delta: { content: event.value } }],
        })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
  } catch (e) {
    console.error('[ai] error:', e.message);
    res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
  } finally {
    res.end();
  }
});

module.exports = router;