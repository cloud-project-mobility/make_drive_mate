const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
const root = __dirname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const privateFiles = [
  /(?:^|[/\\])\.env(?:\.[^/\\]*)?(?:$|[/\\])/,
  new RegExp(
    `^${root}[/\\\\](?:backend|backend-spring|docs|notebooks|\\.tools|\\.git)(?:[/\\\\]|$)`,
  ),
];
const previous = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(previous) ? previous : previous ? [previous] : []),
  ...privateFiles,
];

// The resolver excludes private files from all dependency graphs. Also reject direct
// development HTTP requests before Metro can return source-code error frames.
const previousMiddleware = config.server.enhanceMiddleware;
config.server.enhanceMiddleware = (middleware, server) => {
  const next = previousMiddleware ? previousMiddleware(middleware, server) : middleware;
  return (request, response, nextHandler) => {
    let requestPath;
    try {
      requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const resolved = path.resolve(__dirname, `.${requestPath}`);
    if (
      /\/\.env(?:[./]|$)/.test(requestPath) ||
      privateFiles.some((pattern) => pattern.test(resolved))
    ) {
      response.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }
    return next(request, response, nextHandler);
  };
};
module.exports = config;
