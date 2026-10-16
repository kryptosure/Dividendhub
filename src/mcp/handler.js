// backend/src/mcp/handler.js
const { createMcpServer } = require('./server');

let _nodeHandler = null;
let _initPromise = null;

/**
 * Lazily initializes the MCP Node adapter on first request.
 * The SDK is ESM-only so we use dynamic import.
 */
async function getNodeHandler() {
  if (_nodeHandler) return _nodeHandler;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const { createMcpHandler } = await import('@modelcontextprotocol/server');
    const { toNodeHandler } = await import('@modelcontextprotocol/node');

    const handler = createMcpHandler(() => createMcpServer());
    _nodeHandler = toNodeHandler(handler);
    console.log('✅ MCP handler initialized');
    return _nodeHandler;
  })();

  return _initPromise;
}

module.exports = { getNodeHandler };