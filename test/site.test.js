const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const site = fs.existsSync(path.join(__dirname, '..', 'site')) ? path.join(__dirname, '..', 'site') : path.join(__dirname, '..');
const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(site, 'app.js'), 'utf8');

test('page basics: title, viewport, one h1, landmarks, live region', () => {
  assert.match(html, /<title>Dream Nests[^<]+<\/title>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  for (const tag of ['<header', '<nav', '<main', '<footer']) assert.ok(html.includes(tag), tag);
  assert.equal((html.match(/aria-live=/g) || []).length, 1, 'exactly one live region');
  assert.match(html, /id="announcer"[^>]*aria-live="polite"/);
});

test('accessibility rules from the build brief', () => {
  assert.ok(!/<dl[\s>]/.test(html), 'no dl');
  assert.ok(!/<table[\s>]/.test(html), 'no tables');
  assert.ok(!/aria-describedby/.test(html + js), 'no aria-describedby');
  assert.ok(!/autoplay/.test(html), 'no autoplay');
  assert.ok(!/Hasan|Alhasan|Altameemi|Looscid/i.test(html + js), 'no private names');
  assert.match(html, /Carter \(2three1y\)/);
});

test('local assets only, all present', () => {
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 3);
  for (const r of refs) assert.ok(fs.existsSync(path.join(site, r)), 'missing ' + r);
  assert.ok(!/<script[^>]+src="https?:/.test(html), 'no CDN scripts');
});

test('honesty and credits sections exist', () => {
  assert.match(html, /What works here, honestly/);
  assert.match(html, /listen-only/i);
  assert.match(html, /nbd-wtf\/nostr-tools/);
  assert.match(html, /nostrnests\/nests/);
  assert.match(html, /vicariousdrama\/cornychat/);
  assert.ok(!/lorem ipsum|TODO|FIXME/i.test(html));
});

test('room logic: sensitive filter, room types, live state', () => {
  const bundle = fs.readFileSync(path.join(site, 'vendor', 'nostr-tools.bundle.js'), 'utf8');
  const els = {};
  const fakeEl = () => ({ textContent: '', hidden: false, disabled: false, checked: false, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, appendChild() {}, focus() {}, contains() { return false; }, querySelector() { return null; }, pause() {}, load() {} });
  const sandbox = {
    console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { hash: '' },
    document: { getElementById: (id) => (els[id] = els[id] || fakeEl()), createElement: () => fakeEl(), createTextNode: () => ({}), addEventListener() {}, activeElement: null, hidden: false, title: '' },
    addEventListener() {}, crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, Promise, URL
  };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundle, sandbox);
  sandbox.NostrTools = vm.runInContext('NostrTools', sandbox);
  sandbox.NostrTools.SimplePool = function () { this.querySync = () => Promise.resolve([]); this.subscribeMany = () => ({ close() {} }); };
  vm.runInContext(js, sandbox);
  const DN = sandbox.DreamNests;
  const now = Math.floor(Date.now() / 1000);
  const pk = 'a'.repeat(64);
  const ev = (kind, tags, extra) => Object.assign({ kind, pubkey: pk, created_at: now - 60, content: '', tags }, extra || {});

  assert.ok(DN.isSensitive(ev(30311, [['d', 'x'], ['title', 'Live From Somewhere #NSFW']])));
  assert.ok(DN.isSensitive(ev(30311, [['d', 'x'], ['title', 'Chill'], ['content-warning', 'adult']])));
  assert.ok(DN.isSensitive(ev(30311, [['d', 'x'], ['title', 'Chill'], ['t', 'nsfw']])));
  assert.ok(!DN.isSensitive(ev(30311, [['d', 'x'], ['title', 'Essex radio talk']])));

  const nests = DN.describeRoom(ev(30312, [['d', 'r1'], ['title', 'Morning nest'], ['streaming', 'https://moq.example/relay'], ['p', 'b'.repeat(64), '', 'host']]), 3);
  assert.equal(nests.platform, 'Nests');
  assert.ok(nests.openUrl.startsWith('https://nostrnests.com/room/naddr1'));
  assert.equal(nests.hls, null);
  assert.equal(nests.hostPk, 'b'.repeat(64));
  assert.equal(nests.listeners, 3);
  assert.equal(DN.liveState(nests, true), 'live');

  const corny = DN.describeRoom(ev(30311, [['d', '1'], ['title', 'Corny'], ['service', 'https://cornychat.com/abc'], ['streaming', 'https://cornychat.com/abc'], ['l', 'audiospace', 'com.cornychat'], ['status', 'live'], ['ends', String(now + 3000)], ['current_participants', '4']]));
  assert.equal(corny.platform, 'Corny Chat');
  assert.equal(corny.audio, true);
  assert.equal(corny.openUrl, 'https://cornychat.com/abc');
  assert.equal(corny.listeners, 4);
  assert.equal(DN.liveState(corny, false), 'live');

  const stream = DN.describeRoom(ev(30311, [['d', 's'], ['title', 'Radio'], ['streaming', 'https://x.example/hls/live.m3u8'], ['status', 'live']], { created_at: now - 7200 }));
  assert.equal(stream.audio, false);
  assert.equal(stream.hls, 'https://x.example/hls/live.m3u8');
  assert.equal(DN.liveState(stream, false), 'ended', 'NIP-53: no update for an hour counts as ended');

  const ended = DN.describeRoom(ev(30312, [['d', 'r2'], ['title', 'Done'], ['status', 'ended']]));
  assert.equal(DN.liveState(ended, true), 'ended');
});
