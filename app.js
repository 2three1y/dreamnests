/* Dream Nests — accessible live audio rooms on Nostr.
   Made by Carter (2three1y). MIT license.
   Room rules follow nostrnests/nests (MIT). Relay access via nostr-tools (Unlicense). */
(function () {
  'use strict';

  var NT = window.NostrTools;
  var DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://relay.ditto.pub'
  ];
  var ROOM_KIND = 30312;      // Nests audio room
  var LIVE_KIND = 30311;      // NIP-53 live activity (Corny Chat, zap.stream...)
  var PRESENCE_KIND = 10312;  // Nests presence (hand, mic)
  var CHAT_KIND = 1311;       // NIP-53 live chat
  var STALE_PRESENCE = 10 * 60;
  var STALE_LIVE = 60 * 60;   // NIP-53: live events not updated for 1 hour count as ended
  var SENSITIVE_RE = /(^|[^a-z0-9])(nsfw|porn\w*|xxx|onlyfans|18\+|adults? only|adult content|nude|nudes|nudity|sex|sexy|hentai|erotic\w*|fetish|lewd|r18)([^a-z0-9]|$)/i;

  var $ = function (id) { return document.getElementById(id); };
  var now = function () { return Math.floor(Date.now() / 1000); };

  /* ---------- settings ---------- */
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('dreamnests.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('dreamnests.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  };
  var settings = {
    earcons: store.get('earcons', true),
    chatTick: store.get('chatTick', false),
    streams: store.get('streams', true),
    sensitive: store.get('sensitive', false),
    chatMuted: store.get('chatMuted', false),
    relays: store.get('relays', DEFAULT_RELAYS.slice())
  };
  if (!Array.isArray(settings.relays) || !settings.relays.length) settings.relays = DEFAULT_RELAYS.slice();

  /* ---------- one polite live region, never spammed ---------- */
  var announceQueue = [];
  var announceTimer = null;
  var announcer = $('announcer');
  function announce(text, opts) {
    opts = opts || {};
    if (!text) return;
    if (opts.replace) announceQueue = [];
    if (announceQueue.length >= 4) {
      // Collapse a burst into one summary instead of reading everything.
      announceQueue = announceQueue.slice(0, 2);
      announceQueue.push('More activity. Check the chat and activity lists.');
      return;
    }
    announceQueue.push(text);
    if (!announceTimer) pump();
  }
  function pump() {
    var next = announceQueue.shift();
    if (next === undefined) { announceTimer = null; return; }
    announcer.textContent = '';
    setTimeout(function () { announcer.textContent = next; }, 60);
    announceTimer = setTimeout(pump, Math.min(6000, 1600 + next.length * 45));
  }

  /* ---------- earcons (Web Audio, created only after a press) ---------- */
  var actx = null;
  function audioCtx() {
    if (!actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      actx = new AC();
    }
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, start, dur, type, vol) {
    var c = actx; if (!c) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, c.currentTime + start);
    g.gain.setValueAtTime(0.0001, c.currentTime + start);
    g.gain.exponentialRampToValueAtTime(vol || 0.18, c.currentTime + start + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g); g.connect(c.destination);
    o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.05);
  }
  var EARCONS = {
    speak: function () { tone(523, 0, 0.12, 'sine', 0.16); tone(784, 0.11, 0.18, 'sine', 0.16); },          // rising pair: mic on
    hand: function () { tone(880, 0, 0.14, 'triangle', 0.2); tone(1175, 0.16, 0.14, 'triangle', 0.2); tone(1568, 0.32, 0.22, 'triangle', 0.18); }, // three bright dings
    ended: function () { tone(659, 0, 0.22, 'sine', 0.18); tone(494, 0.22, 0.22, 'sine', 0.18); tone(330, 0.44, 0.45, 'sine', 0.18); }, // falling three: room ended
    chat: function () { tone(1320, 0, 0.05, 'square', 0.04); }                                                // tiny tick
  };
  function earcon(name) {
    if (name === 'chat' ? !settings.chatTick : !settings.earcons) return;
    if (!actx) return; // never start audio before the person has pressed something
    if (actx.state === 'suspended') actx.resume();
    EARCONS[name]();
  }
  // Unlock audio on the first real press (VoiceOver double-tap sends a click). Nothing plays until an event happens.
  ['click', 'keydown', 'touchend'].forEach(function (t) { document.addEventListener(t, audioCtx, { passive: true }); });

  /* ---------- helpers ---------- */
  function tag(ev, name) { for (var i = 0; i < ev.tags.length; i++) if (ev.tags[i][0] === name) return ev.tags[i][1]; return undefined; }
  function tags(ev, name) { return ev.tags.filter(function (t) { return t[0] === name; }); }
  function addrKey(ev) { return ev.kind + ':' + ev.pubkey + ':' + (tag(ev, 'd') || ''); }
  function isHttps(u) { return typeof u === 'string' && /^https:\/\/[^\s]+$/i.test(u); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function ago(ts) {
    var s = Math.max(0, now() - ts);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' minutes ago';
    if (s < 86400) return plural(Math.round(s / 3600), 'hour', 'hours') + ' ago';
    return plural(Math.round(s / 86400), 'day', 'days') + ' ago';
  }
  function until(ts) {
    var s = ts - now();
    if (s < 3600) return 'in ' + Math.max(1, Math.round(s / 60)) + ' minutes';
    if (s < 86400) return 'in ' + plural(Math.round(s / 3600), 'hour', 'hours');
    return new Date(ts * 1000).toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
  }
  function el(name, attrs, text) {
    var e = document.createElement(name);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function isSensitive(ev) {
    if (tags(ev, 'content-warning').length) return true;
    if (ev.tags.some(function (t) { return (t[0] === 'l' || t[0] === 'L') && /content-warning|nsfw/i.test((t[1] || '') + ' ' + (t[2] || '')); })) return true;
    var hay = [tag(ev, 'title'), tag(ev, 'summary'), ev.kind === CHAT_KIND ? ev.content : ''].concat(tags(ev, 't').map(function (t) { return t[1]; })).join(' \n ');
    return SENSITIVE_RE.test(hay);
  }

  /* ---------- profiles ---------- */
  var profiles = {};
  var profileWaiting = {};
  var profileTimer = null;
  function shortKey(pk) { return 'someone (key ending ' + pk.slice(-4) + ')'; }
  function nameOf(pk) {
    var p = profiles[pk];
    var n = p && (p.display_name || p.displayName || p.name);
    if (n && typeof n === 'string') return n.replace(/\s+/g, ' ').trim().slice(0, 60) || shortKey(pk);
    return shortKey(pk);
  }
  function wantProfiles(pks, cb) {
    pks.forEach(function (pk) { if (!(pk in profiles) && /^[0-9a-f]{64}$/.test(pk)) profileWaiting[pk] = true; });
    if (cb) profileCallbacks.push(cb);
    if (!profileTimer) profileTimer = setTimeout(loadProfiles, 250);
  }
  var profileCallbacks = [];
  function loadProfiles() {
    profileTimer = null;
    var authors = Object.keys(profileWaiting).slice(0, 150);
    authors.forEach(function (a) { delete profileWaiting[a]; profiles[a] = profiles[a] || null; });
    var cbs = profileCallbacks; profileCallbacks = [];
    if (!authors.length) { cbs.forEach(function (f) { f(); }); return; }
    pool.querySync(settings.relays, { kinds: [0], authors: authors }, { maxWait: 4000 }).then(function (evs) {
      var newest = {};
      evs.forEach(function (e) { if (!newest[e.pubkey] || newest[e.pubkey].created_at < e.created_at) newest[e.pubkey] = e; });
      Object.keys(newest).forEach(function (pk) { try { profiles[pk] = JSON.parse(newest[pk].content); } catch (e) { /* bad json */ } });
    }).catch(function () {}).then(function () {
      cbs.forEach(function (f) { f(); });
      if (Object.keys(profileWaiting).length) profileTimer = setTimeout(loadProfiles, 250);
    });
  }

  /* ---------- room model ---------- */
  function describeRoom(ev, presenceCount) {
    var service = tag(ev, 'service');
    var streaming = tags(ev, 'streaming').map(function (t) { return t[1]; });
    var hls = streaming.filter(function (u) { return isHttps(u) && /\.m3u8(\?|$)/i.test(u); })[0] || null;
    var labels = ev.tags.filter(function (t) { return t[0] === 'l'; }).map(function (t) { return t[1]; });
    var naddr = NT.nip19.naddrEncode({ kind: ev.kind, pubkey: ev.pubkey, identifier: tag(ev, 'd') || '', relays: settings.relays.slice(0, 2) });
    var r = {
      ev: ev, key: addrKey(ev), naddr: naddr, kind: ev.kind,
      title: (tag(ev, 'title') || '').trim() || 'Untitled room',
      summary: (tag(ev, 'summary') || '').trim(),
      status: (tag(ev, 'status') || 'live').toLowerCase(),
      starts: parseInt(tag(ev, 'starts') || '0', 10) || ev.created_at,
      ends: parseInt(tag(ev, 'ends') || '0', 10) || 0,
      hls: hls, audio: false, platform: '', openUrl: '', openLabel: '', hostPk: null, listeners: null
    };
    var hostTag = ev.tags.filter(function (t) { return t[0] === 'p' && /^host$/i.test(t[3] || ''); })[0];
    if (ev.kind === ROOM_KIND) {
      r.audio = true;
      if (isHttps(service) && /hivetalk/i.test(service)) { r.platform = 'HiveTalk'; r.openUrl = service; }
      else { r.platform = 'Nests'; r.openUrl = 'https://nostrnests.com/room/' + naddr; }
      r.hostPk = hostTag ? hostTag[1] : ev.pubkey;
      r.listeners = presenceCount || 0;
    } else {
      var corny = labels.indexOf('audiospace') >= 0 || (isHttps(service) && /cornychat/i.test(service)) || labels.some(function (l) { return /cornychat/i.test(l || ''); });
      var cp = parseInt(tag(ev, 'current_participants') || '', 10);
      r.listeners = isNaN(cp) ? null : cp;
      if (corny) {
        r.audio = true; r.platform = 'Corny Chat';
        r.openUrl = isHttps(service) ? service : (isHttps(streaming[0]) ? streaming[0] : 'https://cornychat.com/');
        r.hostPk = hostTag ? hostTag[1] : null;
      } else {
        r.platform = 'live stream';
        r.openUrl = 'https://zap.stream/' + naddr;
        r.hostPk = hostTag ? hostTag[1] : ev.pubkey;
      }
    }
    return r;
  }
  function liveState(r, hasPresence) {
    var t = now();
    if (r.status === 'ended' || r.status === 'closed') return 'ended';
    if (r.status === 'planned') return (r.starts > t - 3600 && r.starts < t + 30 * 86400) ? 'planned' : 'gone';
    if (r.status === 'private') return 'private';
    if (r.kind === ROOM_KIND) return (hasPresence || r.ev.created_at >= t - STALE_PRESENCE) ? 'live' : 'ended';
    if (r.ends && r.ends > t) return 'live';
    return r.ev.created_at >= t - STALE_LIVE ? 'live' : 'ended';
  }
  function canPlayHls() {
    var a = document.createElement('audio');
    return !!(a.canPlayType && a.canPlayType('application/vnd.apple.mpegurl'));
  }

  /* ---------- relays ---------- */
  var pool = new NT.SimplePool();
  if (pool.trackRelays !== undefined) pool.trackRelays = false;

  /* ---------- lobby ---------- */
  var rooms = {};
  var lobbyLoading = false;
  var hiddenCount = 0;

  function loadLobby(userAsked) {
    if (lobbyLoading) return;
    lobbyLoading = true;
    $('refresh').disabled = true;
    $('lobby-status').textContent = 'Checking ' + plural(settings.relays.length, 'relay', 'relays') + ' for live rooms.';
    if (userAsked) announce('Checking relays.');
    var t = now();
    var p1 = pool.querySync(settings.relays, { kinds: [ROOM_KIND, LIVE_KIND], since: t - 7 * 86400, limit: 400 }, { maxWait: 6000 });
    var p2 = pool.querySync(settings.relays, { kinds: [PRESENCE_KIND], since: t - STALE_PRESENCE, limit: 500 }, { maxWait: 6000 });
    Promise.all([p1.catch(function () { return []; }), p2.catch(function () { return []; })]).then(function (res) {
      var latest = {};
      res[0].forEach(function (e) {
        if (e.kind !== ROOM_KIND && e.kind !== LIVE_KIND) return;
        var k = addrKey(e);
        if (!latest[k] || latest[k].created_at < e.created_at) latest[k] = e;
      });
      var presence = {};
      res[1].forEach(function (p) {
        var a = tag(p, 'a'); if (!a) return;
        (presence[a] = presence[a] || {})[p.pubkey] = true;
      });
      rooms = {};
      hiddenCount = 0;
      Object.keys(latest).forEach(function (k) {
        var e = latest[k];
        if (!tag(e, 'title') && !tag(e, 'streaming') && !tag(e, 'service')) return; // not a room
        if (!settings.sensitive && isSensitive(e)) { hiddenCount++; return; }
        var pc = presence[k] ? Object.keys(presence[k]).length : 0;
        var r = describeRoom(e, pc);
        r.state = liveState(r, pc > 0);
        // private rooms are link-only and can't be joined from a list; untitled ended rooms are just noise
        if (r.state === 'gone' || r.state === 'private') return;
        if (r.state === 'ended' && r.title === 'Untitled room') return;
        rooms[k] = r;
      });
      renderLobby();
      var hosts = Object.keys(rooms).map(function (k) { return rooms[k].hostPk; }).filter(Boolean);
      wantProfiles(hosts, renderLobby);
    }).catch(function (err) {
      $('lobby-status').textContent = 'Could not reach the relays. Check your connection, or the relay list in Settings, then press Check again.';
      announce('Could not reach the relays.');
      if (window.console) console.warn(err);
    }).then(function () {
      lobbyLoading = false;
      $('refresh').disabled = false;
    });
  }

  function roomItem(r) {
    var li = el('li');
    var h = el('h4');
    var a = el('a', { href: '#/room/' + r.naddr }, r.title);
    h.appendChild(a);
    li.appendChild(h);
    var bits = [];
    if (r.state === 'live') bits.push('Live');
    else if (r.state === 'planned') bits.push('Starts ' + until(r.starts));
    else if (r.state === 'private') bits.push('Private room');
    else bits.push('Ended');
    bits.push(r.audio ? r.platform + ' audio room' : 'Live stream');
    if (r.hostPk) bits.push('Hosted by ' + nameOf(r.hostPk));
    if (r.state === 'live' && r.listeners !== null) bits.push(plural(r.listeners, 'person', 'people') + (r.audio ? ' in the room' : ' tuned in'));
    var how = r.hls ? 'Plays here, listen-only' : 'Opens in ' + (r.audio ? r.platform : 'its own app');
    if (r.state === 'live') bits.push(how);
    li.appendChild(el('p', null, bits.join('. ') + '.'));
    return li;
  }

  function renderLobby() {
    var all = Object.keys(rooms).map(function (k) { return rooms[k]; });
    var byListeners = function (a, b) { return (b.listeners || 0) - (a.listeners || 0) || b.ev.created_at - a.ev.created_at; };
    var audio = all.filter(function (r) { return r.audio && r.state === 'live'; }).sort(byListeners);
    var streams = all.filter(function (r) { return !r.audio && r.state === 'live'; }).sort(byListeners);
    var planned = all.filter(function (r) { return r.state === 'planned'; }).sort(function (a, b) { return a.starts - b.starts; });
    var ended = all.filter(function (r) { return r.state === 'ended' && r.audio; }).sort(function (a, b) { return b.ev.created_at - a.ev.created_at; }).slice(0, 10);
    fill('audio-list', 'audio-empty', audio);
    fill('streams-list', 'streams-empty', streams.slice(0, 40));
    fill('planned-list', 'planned-empty', planned.slice(0, 10));
    if (!$('ended-list').contains(document.activeElement)) {
      var endedList = $('ended-list'); endedList.textContent = '';
      ended.forEach(function (r) { endedList.appendChild(roomItem(r)); });
    }
    $('ended-block').hidden = !ended.length;
    $('streams-block').hidden = !settings.streams;
    var msg = audio.length ? plural(audio.length, 'live audio room', 'live audio rooms') : 'No live audio rooms right now';
    if (settings.streams) msg += ', ' + plural(streams.length, 'other live stream', 'other live streams');
    msg += '. Updated ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.';
    $('lobby-status').textContent = msg;
    var fn = $('filtered-note');
    fn.hidden = !hiddenCount;
    fn.textContent = hiddenCount ? plural(hiddenCount, 'room was', 'rooms were') + ' hidden because ' + (hiddenCount === 1 ? 'it is' : 'they are') + ' marked sensitive or NSFW. You can change this in Settings.' : '';
    if (!renderLobby.announced && !currentRoom) { renderLobby.announced = true; announce(msg); }
  }
  // Update lists without yanking focus: a screen reader user sitting on a room link keeps their place.
  var deferredRender = false;
  function fillItem(li, r) {
    li.dataset.key = r.key;
    var fresh = roomItem(r);
    var a = li.querySelector('h4 a'), p = li.querySelector('p');
    var fa = fresh.querySelector('h4 a'), fp = fresh.querySelector('p');
    if (a.textContent !== fa.textContent) a.textContent = fa.textContent;
    if (a.getAttribute('href') !== fa.getAttribute('href')) a.setAttribute('href', fa.getAttribute('href'));
    if (p.textContent !== fp.textContent) p.textContent = fp.textContent;
  }
  function fill(listId, emptyId, items) {
    var ul = $(listId);
    var have = Array.prototype.map.call(ul.children, function (li) { return li.dataset.key; });
    var want = items.map(function (r) { return r.key; });
    var focusInside = ul.contains(document.activeElement);
    if (have.join('|') === want.join('|') || focusInside) {
      var byKey = {};
      items.forEach(function (r) { byKey[r.key] = r; });
      Array.prototype.forEach.call(ul.children, function (li) { if (byKey[li.dataset.key]) fillItem(li, byKey[li.dataset.key]); });
      if (have.join('|') !== want.join('|')) deferredRender = true;
    } else {
      ul.textContent = '';
      items.forEach(function (r) { var li = roomItem(r); li.dataset.key = r.key; ul.appendChild(li); });
    }
    $(emptyId).hidden = items.length > 0;
  }
  $('lobby-lists').addEventListener('focusout', function (e) {
    if (deferredRender && !$('lobby-lists').contains(e.relatedTarget)) { deferredRender = false; setTimeout(renderLobby, 0); }
  });

  /* ---------- room view ---------- */
  var currentRoom = null;
  var roomSubs = [];
  var roomReady = false;
  var roomAllowed = false;
  var roomBlocked = false;
  var presenceState = {};
  var seenChat = {};
  var chatCount = 0;
  var hiddenChat = 0;

  function closeRoomSubs() {
    roomSubs.forEach(function (s) { try { s.close(); } catch (e) { /* closed */ } });
    roomSubs = [];
  }

  function openRoom(naddr) {
    var decoded;
    try { decoded = NT.nip19.decode(naddr); } catch (e) { decoded = null; }
    if (!decoded || decoded.type !== 'naddr' || (decoded.data.kind !== ROOM_KIND && decoded.data.kind !== LIVE_KIND)) {
      showView('lobby'); announce('That room link is not valid.'); return;
    }
    var d = decoded.data;
    var key = d.kind + ':' + d.pubkey + ':' + d.identifier;
    stopPlayer();
    closeRoomSubs();
    roomReady = false; roomAllowed = false; roomBlocked = false; $('room-live').hidden = true; presenceState = {}; seenChat = {}; chatCount = 0; hiddenChat = 0;
    $('chat-list').textContent = ''; $('activity-list').textContent = '';
    $('chat-status').textContent = 'Loading chat.';
    currentRoom = rooms[key] || null;
    showView('room');
    if (currentRoom) { allowRoom(); renderRoom(true); }
    else {
      $('room-title').textContent = 'Loading room';
      $('room-meta').textContent = ''; $('room-summary').textContent = '';
      $('listen-btn').hidden = true; $('open-link').hidden = true; $('join-note').textContent = '';
      $('room-title').focus();
    }
    var relays = dedupe(settings.relays.concat((d.relays || []).filter(function (u) { return /^wss:\/\//.test(u); }).slice(0, 3)));

    // Room event (and any update, e.g. status changing to ended)
    var gotRoom = false;
    roomSubs.push(pool.subscribeMany(relays, { kinds: [d.kind], authors: [d.pubkey], '#d': [d.identifier] }, {
      onevent: function (e) {
        if (currentRoom && currentRoom.ev.created_at >= e.created_at) return;
        if (!settings.sensitive && isSensitive(e)) {
          blockRoom();
          $('room-title').textContent = 'Room hidden';
          $('room-meta').textContent = 'This room is marked sensitive or NSFW, so Dream Nests hides it. You can change this in Settings.';
          $('room-summary').textContent = ''; $('listen-btn').hidden = true; $('open-link').hidden = true; $('join-note').textContent = '';
          return;
        }
        var wasLive = currentRoom && currentRoom.state === 'live';
        var r = describeRoom(e, currentRoom ? currentRoom.listeners : 0);
        r.state = liveState(r, currentRoom && currentRoom.listeners > 0);
        if (roomBlocked) return;
        var first = !gotRoom && !currentRoom;
        gotRoom = true;
        allowRoom();
        currentRoom = r; rooms[key] = r;
        renderRoom(first);
        if (wasLive && (r.status === 'ended' || r.status === 'closed')) {
          earcon('ended');
          addActivity('The room ended.');
          announce('The room ended.');
        }
        if (r.hostPk) wantProfiles([r.hostPk], function () { renderRoom(false); });
      },
      oneose: function () {
        if (!gotRoom && !currentRoom && !roomBlocked) {
          $('room-title').textContent = 'Room not found';
          $('room-meta').textContent = 'None of your relays has this room. It may have been deleted, or it lives on a relay not in your list.';
          announce('Room not found.');
        }
      }
    }));

    var aTag = key;
    // Live chat
    roomSubs.push(pool.subscribeMany(relays, { kinds: [CHAT_KIND], '#a': [aTag], since: now() - 6 * 3600, limit: 60 }, {
      onevent: onChat,
      oneose: function () {
        roomReady = true;
        $('chat-status').textContent = chatCount ? '' : 'No chat messages yet. New ones appear here as they arrive.';
        if (hiddenChat) noteHiddenChat();
      }
    }));
    // Presence (Nests rooms publish hand and mic state)
    if (d.kind === ROOM_KIND) {
      roomSubs.push(pool.subscribeMany(relays, { kinds: [PRESENCE_KIND], '#a': [aTag], since: now() - STALE_PRESENCE }, {
        onevent: onPresence
      }));
      // periodically drop people whose presence went stale, to keep the count honest
      roomSubs.push((function () {
        var iv = setInterval(function () { recountPresence(); }, 60000);
        return { close: function () { clearInterval(iv); } };
      })());
    }
  }

  function allowRoom() {
    if (roomBlocked) return;
    roomAllowed = true;
    $('room-live').hidden = false;
  }
  function blockRoom() {
    roomBlocked = true; roomAllowed = false;
    closeRoomSubs();
    stopPlayer();
    $('room-live').hidden = true;
    $('chat-list').textContent = ''; $('activity-list').textContent = '';
    currentRoom = null;
    announce('This room is hidden because it is marked sensitive.', { replace: true });
  }

  function dedupe(list) { var s = {}; return list.filter(function (x) { if (s[x]) return false; s[x] = true; return true; }); }

  function renderRoom(moveFocus) {
    var r = currentRoom; if (!r) return;
    $('room-title').textContent = r.title;
    document.title = r.title + ' · Dream Nests';
    var bits = [];
    bits.push(r.state === 'live' ? 'Live' : r.state === 'planned' ? 'Starts ' + until(r.starts) : r.state === 'private' ? 'Private room' : 'Ended');
    bits.push(r.audio ? r.platform + ' audio room' : 'Live stream');
    if (r.hostPk) bits.push('Hosted by ' + nameOf(r.hostPk));
    if (r.listeners !== null && r.state === 'live') bits.push(plural(r.listeners, 'person', 'people') + (r.audio ? ' in the room' : ' tuned in'));
    if (r.state === 'live') bits.push('Started ' + ago(r.starts));
    $('room-meta').textContent = bits.join('. ') + '.';
    $('room-summary').textContent = r.summary;
    $('room-summary').hidden = !r.summary;

    var listen = $('listen-btn'), open = $('open-link'), note = $('join-note');
    var playable = r.hls && r.state === 'live' && canPlayHls();
    listen.hidden = !playable;
    open.hidden = false;
    open.href = r.openUrl;
    if (playable) {
      open.textContent = r.audio ? 'Open in ' + r.platform + ' to talk' : 'Open the stream page';
      open.classList.add('secondary');
      note.textContent = 'Listen here is listen-only. ' + (r.audio ? 'To speak or raise your hand, open the room in ' + r.platform + ' and sign in there.' : 'This is a one-way stream, so there is no speaking.');
    } else {
      open.textContent = r.state === 'live' ? 'Listen in ' + (r.audio ? r.platform : 'the stream page') : 'Open room page';
      open.classList.remove('secondary');
      if (r.hls && r.state === 'live') note.textContent = 'This stream can\'t play directly in this browser, so the button opens its own page. Safari and browsers on iPhone can play it here.';
      else if (r.platform === 'Nests') note.textContent = 'Nests rooms stream with technology only the Nests app can play, so this opens the room on nostrnests.com in a new tab. Speaking there needs a Nostr login.';
      else if (r.audio) note.textContent = 'This opens the room on ' + r.platform + ' in a new tab. Listening and speaking happen there.';
      else note.textContent = 'This stream has no public audio link we can play, so this opens its page in a new tab.';
    }
    if (moveFocus) $('room-title').focus();
  }

  /* player */
  var player = $('player');
  $('listen-btn').addEventListener('click', function () {
    audioCtx();
    var r = currentRoom; if (!r || !r.hls) return;
    if (!player.paused) { player.pause(); return; }
    if (player.getAttribute('src') !== r.hls) player.setAttribute('src', r.hls);
    player.hidden = false;
    announce('Connecting to the stream.', { replace: true });
    var p = player.play();
    if (p && p.catch) p.catch(function () { playFailed(); });
  });
  player.addEventListener('playing', function () { setListen(true); announce('Playing. Listen-only.'); });
  player.addEventListener('pause', function () { setListen(false); if (currentRoom && player.getAttribute('src')) announce('Paused.'); });
  player.addEventListener('error', function () { if (player.getAttribute('src')) playFailed(); });
  function playFailed() {
    setListen(false);
    $('join-note').textContent = 'The stream did not start. It may have ended, or this browser cannot play it. Try the room\'s own page instead.';
    announce('The stream did not start. Try the room\'s own page.', { replace: true });
  }
  function setListen(on) {
    var b = $('listen-btn');
    b.textContent = on ? 'Pause' : 'Listen here';
    b.classList.toggle('playing', on);
  }
  function stopPlayer() {
    try { player.pause(); } catch (e) { /* none */ }
    player.removeAttribute('src');
    try { player.load(); } catch (e) { /* none */ }
    player.hidden = true;
    setListen(false);
  }

  /* chat */
  function onChat(e) {
    if (seenChat[e.id]) return;
    seenChat[e.id] = true;
    if (!settings.sensitive && isSensitive(e)) { hiddenChat++; if (roomReady) noteHiddenChat(); return; }
    var text = (e.content || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!text) return;
    chatCount++;
    $('chat-status').textContent = '';
    var li = el('li');
    li.dataset.ts = e.created_at;
    var who = el('span', { 'class': 'who' }, nameOf(e.pubkey));
    li.appendChild(who);
    li.appendChild(document.createTextNode(': ' + text));
    insertSorted($('chat-list'), li, e.created_at);
    trim($('chat-list'), 150);
    if (!(e.pubkey in profiles)) wantProfiles([e.pubkey], function () { who.textContent = nameOf(e.pubkey); });
    if (roomReady && roomAllowed) {
      earcon('chat');
      if (!settings.chatMuted) {
        // short delay so the name has a chance to load before it's spoken
        setTimeout(function () { announce(nameOf(e.pubkey) + ' says: ' + text.slice(0, 220)); }, e.pubkey in profiles ? 0 : 700);
      }
    }
  }
  function noteHiddenChat() {
    $('chat-status').textContent = plural(hiddenChat, 'message was', 'messages were') + ' hidden because ' + (hiddenChat === 1 ? 'it was' : 'they were') + ' marked sensitive.';
  }
  function insertSorted(list, li, ts) {
    // newest at the bottom, like a chat
    var kids = list.children;
    for (var i = kids.length - 1; i >= 0; i--) {
      if (+kids[i].dataset.ts <= ts) { list.insertBefore(li, kids[i].nextSibling); return; }
    }
    list.insertBefore(li, list.firstChild);
  }
  function trim(list, max) { while (list.children.length > max) list.removeChild(list.firstChild); }

  /* presence: hand raised + mic on */
  function onPresence(e) {
    var prev = presenceState[e.pubkey];
    if (prev && prev.created_at >= e.created_at) return;
    var s = {
      created_at: e.created_at,
      hand: tag(e, 'hand') === '1',
      micOn: tag(e, 'publishing') === '1' && tag(e, 'muted') !== '1',
      onstage: tag(e, 'onstage') === '1'
    };
    presenceState[e.pubkey] = s;
    recountPresence();
    if (!roomReady || !roomAllowed || !prev) {
      if (!prev && roomReady && roomAllowed && e.created_at > now() - 120) addActivity(nameOf(e.pubkey) + ' joined.');
      return;
    }
    wantProfiles([e.pubkey], function () {
      var who = nameOf(e.pubkey);
      if (s.hand && !prev.hand) { earcon('hand'); addActivity(who + ' raised their hand.'); announce(who + ' raised their hand.'); }
      if (!s.hand && prev.hand) addActivity(who + ' lowered their hand.');
      if (s.micOn && !prev.micOn) { earcon('speak'); addActivity(who + ' turned their mic on.'); announce(who + ' turned their mic on.'); }
      if (!s.micOn && prev.micOn) addActivity(who + ' muted.');
    });
  }
  function recountPresence() {
    if (!currentRoom || currentRoom.kind !== ROOM_KIND) return;
    var cutoff = now() - STALE_PRESENCE;
    var n = Object.keys(presenceState).filter(function (pk) { return presenceState[pk].created_at >= cutoff; }).length;
    if (n !== currentRoom.listeners) {
      currentRoom.listeners = n;
      if (currentRoom.state !== 'live' && n > 0 && currentRoom.status === 'live') currentRoom.state = 'live';
      renderRoom(false);
    }
  }
  function addActivity(text) {
    var li = el('li', null, new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + ': ' + text);
    var list = $('activity-list');
    list.insertBefore(li, list.firstChild);
    trim2(list, 60);
  }
  function trim2(list, max) { while (list.children.length > max) list.removeChild(list.lastChild); }

  $('chat-mute').addEventListener('click', function () {
    settings.chatMuted = !settings.chatMuted; store.set('chatMuted', settings.chatMuted);
    syncMute();
    announce(settings.chatMuted ? 'Chat announcements muted. Messages still appear in the list.' : 'Chat announcements on.', { replace: true });
  });
  function syncMute() { $('chat-mute').setAttribute('aria-pressed', settings.chatMuted ? 'true' : 'false'); }

  /* ---------- routing ---------- */
  function showView(which) {
    $('lobby').hidden = which !== 'lobby';
    $('room').hidden = which !== 'room';
  }
  function route() {
    var h = location.hash || '';
    var m = h.match(/^#\/room\/(naddr1[0-9a-z]+)$/);
    if (m) { openRoom(m[1]); return; }
    if (h === '' || h === '#/' || h === '#') {
      var wasRoom = !!currentRoom || !$('room').hidden;
      currentRoom = null; closeRoomSubs(); stopPlayer();
      showView('lobby');
      document.title = 'Dream Nests: live Nostr audio rooms that work with VoiceOver';
      if (wasRoom) { $('lobby-heading').focus(); renderLobby(); }
      return;
    }
    // in-page anchors (#settings-heading etc.) keep the current view
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !$('room').hidden) {
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      location.hash = '#/';
    }
  });

  /* ---------- settings UI ---------- */
  function bindCheck(id, key, after) {
    var box = $(id);
    box.checked = !!settings[key];
    box.addEventListener('change', function () {
      settings[key] = box.checked; store.set(key, box.checked);
      if (after) after();
    });
  }
  bindCheck('opt-earcons', 'earcons');
  bindCheck('opt-chat-tick', 'chatTick');
  bindCheck('opt-streams', 'streams', function () { renderLobby(); });
  bindCheck('opt-sensitive', 'sensitive', function () { loadLobby(false); });
  $('test-earcons').addEventListener('click', function () {
    audioCtx();
    var was = settings.earcons; settings.earcons = true;
    var wasTick = settings.chatTick; settings.chatTick = true;
    announce('Mic on.', { replace: true }); EARCONS.speak();
    setTimeout(function () { announce('Hand raised.'); EARCONS.hand(); }, 1700);
    setTimeout(function () { announce('Room ended.'); EARCONS.ended(); }, 3600);
    setTimeout(function () { announce('Chat tick.'); EARCONS.chat(); }, 5600);
    settings.earcons = was; settings.chatTick = wasTick;
  });

  function renderRelays() {
    var ul = $('relay-list'); ul.textContent = '';
    settings.relays.forEach(function (u) {
      var li = el('li', null, u + ' ');
      var b = el('button', { type: 'button', 'class': 'btn', 'aria-label': 'Remove ' + u }, 'Remove');
      b.addEventListener('click', function () {
        if (settings.relays.length <= 1) { announce('Keep at least one relay.', { replace: true }); return; }
        settings.relays = settings.relays.filter(function (x) { return x !== u; });
        store.set('relays', settings.relays); renderRelays();
        announce('Removed ' + u + '.', { replace: true });
        $('relay-input').focus();
      });
      li.appendChild(b); ul.appendChild(li);
    });
  }
  $('relay-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('relay-input').value.trim().replace(/\/+$/, '');
    if (!/^wss:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(v)) { announce('That is not a relay address. It should start with wss://', { replace: true }); return; }
    if (settings.relays.indexOf(v) < 0) settings.relays.push(v);
    store.set('relays', settings.relays); renderRelays();
    $('relay-input').value = '';
    announce('Added ' + v + '. Press Check again to search it.', { replace: true });
  });
  $('relay-reset').addEventListener('click', function () {
    settings.relays = DEFAULT_RELAYS.slice(); store.set('relays', settings.relays); renderRelays();
    announce('Relays reset to the safe default list.', { replace: true });
  });
  $('refresh').addEventListener('click', function () { loadLobby(true); });

  /* ---------- start ---------- */
  if (!NT || !NT.SimplePool) {
    $('lobby-status').textContent = 'Dream Nests could not load its Nostr library. Try reloading the page.';
    return;
  }
  syncMute();
  renderRelays();
  loadLobby(false);
  route();
  setInterval(function () { if (!$('lobby').hidden && !document.hidden) loadLobby(false); }, 60000);

  // exposed for tests only
  window.DreamNests = { isSensitive: isSensitive, describeRoom: describeRoom, liveState: liveState };
})();
