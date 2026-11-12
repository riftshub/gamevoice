import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOUR = 3_600_000;
const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const validUser = id => Number.isSafeInteger(id) && id > 0;
const validServer = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const cleanCode = code => typeof code === 'string' ? code.toUpperCase().replace(/[\s-]/g, '') : '';
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON required');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Object required');
  return value;
}
export function createRelay({ key = process.env.RELAY_SHARED_KEY, now = Date.now, trustProxy = process.env.RENDER === 'true' } = {}) {
  if (typeof key !== 'string' || key.length < 32) throw new Error('Set RELAY_SHARED_KEY to at least 32 random characters');
  const servers = new Map(), codes = new Map(), devices = new Map(), rates = new Map();
  const staticFiles = new Map([
    ['/', ['text/html; charset=utf-8', 'index.html']],
    ['/app.js', ['text/javascript; charset=utf-8', 'app.js']],
    ['/app.css', ['text/css; charset=utf-8', 'app.css']],
  ].map(([route, [type, name]]) => [route, { type, bytes: readFileSync(new URL(`./public/${name}`, import.meta.url)) }]));
  function rate(id, limit, period) {
    const time = now(); let record = rates.get(id);
    if (!record || record.until <= time) { record = { count: 0, until: time + period }; rates.set(id, record); }
    if (++record.count > limit) throw new HttpError(429, 'Too many requests; wait and try again');
  }
  function gameAuth(req) {
    if (!tokenEquals(req.headers.authorization, `Bearer ${key}`)) throw new HttpError(401, 'Unauthorized');
  }
  function dropSession(session) {
    codes.delete(session.code);
    if (session.token) devices.delete(session.token);
  }
  function makeSession(server, userId) {
    if (codes.size + devices.size > 5000) throw new HttpError(503, 'Relay capacity reached');
    let code;
    do { code = [...randomBytes(8)].map(x => alphabet[x % alphabet.length]).join(''); } while (codes.has(code));
    const session = { server, userId, code, codeExpires: now() + 10 * 60_000, expires: now() + 2 * HOUR, lastSeen: 0, sequence: -1, token: null };
    codes.set(code, session); return session;
  }
  function pairs(server) {
    return [...server.users.values()].map(s => ({ userId: s.userId, code: s.token ? '' : s.code, connected: !!s.token && now() - s.lastSeen < 8000 }));
  }
  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://relay.local');
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const file = staticFiles.get(url.pathname); res.writeHead(200, { 'Content-Type': file.type }); res.end(file.bytes); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') { reply(res, 200, { ok: true }); return; }
      if (url.pathname.startsWith('/api/game/')) {
        gameAuth(req);
        if (req.method === 'POST' && url.pathname === '/api/game/register') {
          const body = await jsonBody(req);
          if (!validServer(body.serverId) || !Array.isArray(body.users) || body.users.length > 100 || body.users.some(x => !validUser(x))) throw new HttpError(400, 'Invalid server roster');
          rate(`game:${body.serverId}`, 100, 60_000);
          let room = servers.get(body.serverId);
          if (!room) {
            if (servers.size >= 500) throw new HttpError(503, 'Relay capacity reached');
            room = { id: body.serverId, users: new Map(), events: new Map(), seen: now() }; servers.set(room.id, room);
          }
          const users = new Set(body.users), rotate = new Set(Array.isArray(body.rotateUserIds) ? body.rotateUserIds : []);
          for (const [id, s] of room.users) if (!users.has(id) || rotate.has(id) || s.expires <= now() || (!s.token && s.codeExpires <= now())) { dropSession(s); room.users.delete(id); room.events.delete(id); }
          for (const id of users) if (!room.users.has(id)) room.users.set(id, makeSession(room, id));
          room.seen = now(); reply(res, 200, { pairs: pairs(room) }); return;
        }
        if (req.method === 'GET' && url.pathname === '/api/game/events') {
          const id = url.searchParams.get('serverId'); if (!validServer(id)) throw new HttpError(400, 'Invalid server');
          rate(`poll:${id}`, 100, 60_000);
          const room = servers.get(id); if (!room) throw new HttpError(404, 'Register server first');
          room.seen = now(); const events = [...room.events.values()].filter(e => now() - e.timestamp * 1000 <= 4000); room.events.clear();
          reply(res, 200, { events, pairs: pairs(room) }); return;
        }
        throw new HttpError(404, 'Not found');
      }
      if (req.method === 'POST' && url.pathname === '/api/pair') {
        const ip = trustProxy ? String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',').at(-1).trim() : req.socket.remoteAddress;
        rate(`pair:${ip}`, 12, 60_000);
        const body = await jsonBody(req); const code = cleanCode(body.code);
        const session = codes.get(code);
        if (!/^[A-Z2-9]{8}$/.test(code) || !session || session.codeExpires <= now() || session.expires <= now() || session.token) throw new HttpError(400, 'Code expired or unavailable. Request a new code in the game.');
        const token = randomBytes(32).toString('base64url'); session.token = token; session.expires = now() + 2 * HOUR; session.lastSeen = now(); devices.set(token, session); codes.delete(code);
        reply(res, 200, { deviceToken: token, expiresIn: 7200 }); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/level') {
        const authorization = req.headers.authorization || ''; const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        const session = devices.get(token);
        if (!session || session.expires <= now() || now() - session.server.seen > 90_000) throw new HttpError(401, 'Link expired. Pair again.');
        rate(`device:${token}`, 12, 1000);
        const body = await jsonBody(req);
        if (!Number.isFinite(body.intensity) || body.intensity < 0 || body.intensity > 1 || !Number.isSafeInteger(body.sequence) || body.sequence < 0) throw new HttpError(400, 'Invalid level');
        if (body.sequence <= session.sequence) { reply(res, 200, { ok: true, duplicate: true }); return; }
        session.sequence = body.sequence; session.lastSeen = now();
        if (body.intensity > 0.05) {
          const previous = session.server.events.get(session.userId);
          if (!previous || body.intensity >= previous.intensity || now() - previous.timestamp * 1000 > 1500) session.server.events.set(session.userId, { userId: session.userId, intensity: body.intensity, timestamp: now() / 1000 });
        }
        reply(res, 200, { ok: true }); return;
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (!res.headersSent) reply(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Relay error' });
      else res.end();
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000;
  const cleanup = setInterval(() => {
    for (const [id, room] of servers) {
      if (now() - room.seen > 90_000) { for (const s of room.users.values()) dropSession(s); servers.delete(id); }
      else for (const [uid, s] of room.users) if (s.expires <= now()) { dropSession(s); room.users.delete(uid); }
    }
    for (const [id, value] of rates) if (value.until <= now()) rates.delete(id);
  }, 30_000); cleanup.unref(); server.on('close', () => clearInterval(cleanup));
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  const app = createRelay(); app.listen(port, '0.0.0.0', () => console.log(`Dead Air relay listening on port ${port}`));
}
