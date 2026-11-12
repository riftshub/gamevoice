import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../server.mjs';
const key = 'fixture-game-key-not-a-real-credential-0123456789';
async function fixture(t) {
  let time = 1_800_000_000_000;
  const server = createRelay({ key, now: () => time });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body, token, method = body ? 'POST' : 'GET') {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function register(serverId = 'game-one', users = [101], rotateUserIds = []) {
    const response = await request('/api/game/register', { serverId, users, rotateUserIds }, key); assert.equal(response.status, 200); return response.body;
  }
  async function pair(code) { const r = await request('/api/pair', { code }); assert.equal(r.status, 200); return r.body.deviceToken; }
  return { base, request, register, pair, advance: value => { time += value; } };
}
test('authenticated pairing carries numeric volume to the correct game user', async t => {
  const f = await fixture(t); const roster = await f.register(); const token = await f.pair(roster.pairs[0].code);
  const post = await f.request('/api/level', { intensity: .67, sequence: 1 }, token); assert.equal(post.status, 200);
  const events = await f.request('/api/game/events?serverId=game-one', undefined, key);
  assert.equal(events.status, 200); assert.equal(events.body.events.length, 1); assert.equal(events.body.events[0].userId, 101); assert.equal(events.body.events[0].intensity, .67);
  assert.deepEqual(Object.keys(events.body.events[0]).sort(), ['intensity', 'timestamp', 'userId']); assert.equal(events.body.pairs[0].connected, true);
  const second = await f.request('/api/game/events?serverId=game-one', undefined, key); assert.equal(second.body.events.length, 0);
});
test('device credentials cannot poll game events or register players', async t => {
  const f = await fixture(t); assert.equal((await f.request('/api/game/register', { serverId: 'forged', users: [999] })).status, 401);
  const roster = await f.register(); const token = await f.pair(roster.pairs[0].code);
  assert.equal((await f.request('/api/game/events?serverId=game-one', undefined, token)).status, 401);
  assert.equal((await f.request('/api/level', { intensity: 1, sequence: 1 }, key)).status, 401);
});
test('pairing codes are single-use, and replacement codes revoke the old device', async t => {
  const f = await fixture(t); const roster = await f.register(); const code = roster.pairs[0].code; const token = await f.pair(code);
  assert.equal((await f.request('/api/pair', { code })).status, 400);
  const replacement = await f.register('game-one', [101], [101]); assert.notEqual(replacement.pairs[0].code, code);
  assert.equal((await f.request('/api/level', { intensity: .6, sequence: 1 }, token)).status, 401);
});
test('silence and reordered packets do not erase a brief loud sound', async t => {
  const f = await fixture(t); const token = await f.pair((await f.register()).pairs[0].code);
  await f.request('/api/level', { intensity: .9, sequence: 2 }, token);
  await f.request('/api/level', { intensity: 0, sequence: 3 }, token);
  const replay = await f.request('/api/level', { intensity: .2, sequence: 1 }, token); assert.equal(replay.body.duplicate, true);
  const result = await f.request('/api/game/events?serverId=game-one', undefined, key); assert.equal(result.body.events[0].intensity, .9);
});
test('different servers remain isolated and departing users lose access', async t => {
  const f = await fixture(t); const first = await f.register('game-one', [101]); const second = await f.register('game-two', [202]);
  const token = await f.pair(first.pairs[0].code); await f.request('/api/level', { intensity: .6, sequence: 1 }, token);
  const isolated = await f.request('/api/game/events?serverId=game-two', undefined, key); assert.equal(isolated.body.events.length, 0); assert.equal(isolated.body.pairs[0].userId, second.pairs[0].userId);
  await f.register('game-one', []); assert.equal((await f.request('/api/level', { intensity: .6, sequence: 2 }, token)).status, 401);
});
test('expired codes and stale sounds are rejected without replaying', async t => {
  const f = await fixture(t); const first = await f.register(); f.advance(601_000);
  assert.equal((await f.request('/api/pair', { code: first.pairs[0].code })).status, 400);
  const replacement = await f.register(); const token = await f.pair(replacement.pairs[0].code);
  await f.request('/api/level', { intensity: .8, sequence: 1 }, token); f.advance(5000);
  const result = await f.request('/api/game/events?serverId=game-one', undefined, key); assert.equal(result.body.events.length, 0);
});
test('invalid levels, indices and invalid user rosters do not enter the queue', async t => {
  const f = await fixture(t); assert.equal((await f.request('/api/game/register', { serverId: 'x', users: ['101'] }, key)).status, 400);
  const token = await f.pair((await f.register()).pairs[0].code);
  for (const body of [{ intensity: 2, sequence: 1 }, { intensity: -1, sequence: 1 }, { intensity: 'audio', sequence: 1 }, { intensity: .5, sequence: 1.5 }]) assert.equal((await f.request('/api/level', body, token)).status, 400);
  assert.equal((await f.request('/api/game/events?serverId=game-one', undefined, key)).body.events.length, 0);
});
test('the public page does not expose the shared game credential', async t => {
  const f = await fixture(t); const response = await fetch(f.base); const html = await response.text();
  assert.equal(response.status, 200); assert.ok(html.includes('VOICE LINK')); assert.ok(!html.includes(key)); assert.match(response.headers.get('permissions-policy'), /microphone=\(self\)/);
});
