/* Loopback-only preview of dist, with the same SPA fallback as the deployment. */
const http = require('node:http');
const path = require('node:path');
const { createReadStream } = require('node:fs');
const { access, realpath, stat } = require('node:fs/promises');

const root = path.join(path.dirname(require.resolve('../package.json')), 'dist');
const port = Number(process.argv[2] || 18087);
const target = process.env.DRIVEMATE_LOCAL_API_TARGET;
if (target && !['http://127.0.0.1:18085', 'http://127.0.0.1:18086'].includes(target)) {
  throw new Error('The optional local API target must be a supported loopback Spring port.');
}
const api = target ? new URL(target) : null;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function proxyApi(request, response, url) {
  const headers = { host: api.host, connection: 'close' };
  for (const name of ['authorization', 'content-type', 'content-length', 'accept', 'origin']) {
    if (request.headers[name]) headers[name] = request.headers[name];
  }
  const upstream = http.request(
    {
      hostname: api.hostname,
      port: api.port,
      method: request.method,
      path: url.pathname + url.search,
      headers,
    },
    (reply) => {
      const outgoing = { 'Cache-Control': 'no-store' };
      for (const name of [
        'content-type',
        'content-encoding',
        'content-security-policy',
        'referrer-policy',
        'x-frame-options',
        'location',
        'retry-after',
        'access-control-allow-origin',
        'access-control-allow-methods',
        'access-control-allow-headers',
        'vary',
        'x-content-type-options',
      ]) {
        if (reply.headers[name]) outgoing[name] = reply.headers[name];
      }
      response.writeHead(reply.statusCode || 502, outgoing);
      reply.on('error', () => response.destroy());
      reply.pipe(response);
    },
  );
  const timer = setTimeout(() => upstream.destroy(new Error('Local API timeout')), 130_000);
  upstream.on('close', () => clearTimeout(timer));
  upstream.on('error', () => {
    if (response.headersSent) response.destroy();
    else {
      response.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(
        JSON.stringify({
          error: {
            code: 'local_backend_unavailable',
            message: '로컬 Spring 서버 연결을 확인해 주세요.',
          },
        }),
      );
    }
  });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

async function handle(request, response) {
  let url;
  let pathname;
  try {
    url = new URL(request.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  if (api && pathname.startsWith('/api/v1/')) {
    proxyApi(request, response, url);
    return;
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405);
    response.end();
    return;
  }
  if (
    pathname.split('/').some((part) => part.startsWith('.')) ||
    pathname.includes('\\') ||
    pathname.includes('\0')
  ) {
    response.writeHead(404);
    response.end();
    return;
  }
  let target = path.resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    if (!(await stat(target)).isFile()) target = path.join(root, 'index.html');
  } catch {
    if (path.extname(pathname) || pathname.startsWith('/api/')) {
      response.writeHead(404);
      response.end();
      return;
    }
    target = path.join(root, 'index.html');
  }
  const resolved = await realpath(target);
  if (!resolved.startsWith(root + path.sep)) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': types[path.extname(resolved)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else
    createReadStream(resolved)
      .on('error', () => response.destroy())
      .pipe(response);
}

access(path.join(root, 'index.html'))
  .then(() => {
    const server = http.createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.on('error', (error) => {
      console.error(error.code || 'Preview failed');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1');
  })
  .catch(() => {
    console.error('Run npm run export:web before static browser verification.');
    process.exitCode = 1;
  });
