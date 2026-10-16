// backend/src/mcp/server.js
const z = require('zod/v4');

const API_BASE = process.env.API_BASE_URL || 'https://dividendhub-api.onrender.com';

/**
 * Factory that creates a fresh MCP server instance.
 * Called once per incoming MCP request.
 */
async function createMcpServer() {
  // Dynamic import because the MCP v2 SDK is ESM-only
  const { McpServer } = await import('@modelcontextprotocol/server');

  const server = new McpServer({
    name: 'dividendbro',
    version: '1.0.0',
  });

  /* ─────────── TOOLS ─────────── */

  server.registerTool(
    'search_dividend_stocks',
    {
      description: 'Search for dividend-paying stocks by ticker or company name across US, SGX, and TSX markets.',
      inputSchema: z.object({
        query: z.string().describe('Ticker or company name, e.g. "DBS" or "Realty Income"'),
        market: z.enum(['us', 'sg', 'ca', 'both']).default('both'),
      }),
    },
    async ({ query, market }) => {
      const res = await fetch(
        `${API_BASE}/api/stocks/search?q=${encodeURIComponent(query)}&market=${market}`
      );
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'get_stock_dividends',
    {
      description: 'Get full dividend history, current yield, payout schedule, safety score, and dividend CAGR for a specific stock.',
      inputSchema: z.object({
        symbol: z.string().describe('Stock ticker, e.g. "D05.SI" for DBS or "O" for Realty Income'),
        market: z.enum(['us', 'sg', 'ca']).default('us'),
      }),
    },
    async ({ symbol, market }) => {
      const res = await fetch(
        `${API_BASE}/api/stocks/${encodeURIComponent(symbol)}?market=${market}`
      );
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'screen_dividend_stocks',
    {
      description: 'Screen dividend stocks by market, payout frequency, asset type, safety score, or yield.',
      inputSchema: z.object({
        market: z.enum(['us', 'sg', 'ca', 'both']).default('both'),
        frequency: z.enum(['all', 'daily', 'weekly', 'monthly', 'quarterly', 'semi-annual', 'annual']).default('all'),
        assetType: z.enum(['all', 'stock', 'reit', 'etf', 'bond-etf', 'preferred']).default('all'),
        safety: z.enum(['all', 'safe', 'moderate', 'caution']).default('all'),
        sort: z.enum(['yield-desc', 'yield-asc', 'cagr-desc', 'safety-asc', 'name-asc']).default('yield-desc'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    },
    async (params) => {
      const qs = new URLSearchParams(params).toString();
      const res = await fetch(`${API_BASE}/api/stocks/screener?${qs}`);
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'get_top_dividend_stocks',
    {
      description: 'Get the highest-yielding dividend stocks or ETFs in a given market, ranked by regular yield.',
      inputSchema: z.object({
        market: z.enum(['us', 'sg', 'ca']).default('sg'),
        type: z.enum(['stock', 'etf']).default('stock'),
      }),
    },
    async ({ market, type }) => {
      const res = await fetch(`${API_BASE}/api/stocks/top/${market}?type=${type}`);
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.registerTool(
    'get_upcoming_dividends',
    {
      description: 'Get upcoming ex-dividend dates and estimated payout amounts within the next N days.',
      inputSchema: z.object({
        market: z.enum(['us', 'sg', 'ca', 'both']).default('both'),
        days: z.number().int().min(7).max(120).default(60),
      }),
    },
    async ({ market, days }) => {
      const res = await fetch(
        `${API_BASE}/api/stocks/upcoming-dividends?market=${market}&days=${days}`
      );
      const data = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
  );

  /* ─────────── RESOURCES ─────────── */

  server.registerResource(
    'methodology',
    'dividendbro://methodology',
    {
      name: 'DividendBro Methodology',
      description: 'How DividendBro calculates yield, CAGR, safety score, and special dividends.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: 'dividendbro://methodology',
          mimeType: 'text/markdown',
          text: `# DividendBro Methodology

## Dividend Yield
Trailing 12-month dividends divided by current price. Special dividends are excluded from the "regular yield" figure and reported separately.

## Dividend CAGR
Computed from complete fiscal years only: (endYear_total / startYear_total) ^ (1/years) - 1.

## Safety Score
Asset-type aware:
- **Stocks/REITs**: dividend streak, coefficient of variation (last 10 years), payout ratio.
- **ETFs/Bond ETFs**: distribution history, consistency, issuer reputation, yield sanity.
- **Preferred Stocks**: capped at Moderate due to crypto-treasury backing.

## Special Dividend Detection
Year-over-year comparison. Each trailing payment is compared to its closest prior-year equivalent. Excess above baseline is flagged as special.
`,
        },
      ],
    })
  );

  /* ─────────── PROMPTS ─────────── */

  server.registerPrompt(
    'analyze-dividend-stock',
    {
      description: 'Analyze a dividend stock and summarize its income potential.',
      arguments: [{ name: 'symbol', description: 'Ticker, e.g. "D05.SI"', required: true }],
    },
    ({ symbol }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze the dividend stock ${symbol} using DividendBro tools:
1. Get full dividend history and current yield.
2. Summarize payout schedule (frequency, recent amounts).
3. Note 5-year dividend CAGR and safety score.
4. Calculate capital needed for S$500/month income.
5. Flag risks (payout ratio, special dividends, streak breaks).`,
          },
        },
      ],
    })
  );

  return server;
}

module.exports = { createMcpServer };