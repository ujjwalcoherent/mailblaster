'use strict';
/**
 * Local dev server. Serves the static files from the project root and routes
 * /api/<name> to api/<name>.js — exactly how Vercel does it in production, so
 * the same code runs in both places with no build step.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith('/api/')) {
    const name = pathname.slice(5).replace(/[^a-z0-9_-]/gi, '');
    const file = path.join(ROOT, 'api', name + '.js');
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, error: 'No such endpoint' }));
    }
    req.query = Object.fromEntries(url.searchParams);
    try {
      await require(file)(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});

server.on('request', req => { req.setTimeout(0); });
server.listen(PORT, () => console.log('MailBlaster → http://localhost:' + PORT));
