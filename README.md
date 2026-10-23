# Dream Nests

Live audio rooms on Nostr, made to work with VoiceOver and TalkBack. Think Twitter Spaces that a screen reader can actually use.

Open it: https://2three1y.github.io/dream-nests/

Made by Carter (2three1y).

## What it does

- Lists live audio rooms from Nostr relays: Nests rooms (kind 30312) and NIP-53 live activities (kind 30311) such as Corny Chat rooms and radio streams.
- Each room is a heading with its status, host, how many people are in it, and whether it plays here or opens its own app.
- Opening a room gives one big button. If the room publishes a public HLS stream (an .m3u8 link), it plays right in the page, listen-only. Otherwise the button opens the room in Nests, Corny Chat, HiveTalk or zap.stream.
- Live chat (kind 1311) is read out through one polite live region, with a Mute chat announcements button.
- Earcons: mic on and hand raised (from Nests presence events, kind 10312) and room ended.
- Rooms and messages marked sensitive or NSFW are hidden by default. Links and images in chat are never loaded.
- Read-only: no login, no keys, nothing is ever posted.

## What is listen-only and what is full speaking

### Plays here, listen-only
- Live streams with a public HLS link. Safari and every browser on iPhone play these. Chrome on a computer usually does too. Some browsers can't, and then the button opens the stream's own page.

### Opens the room's own app
- Nests rooms use Media over QUIC, which only the Nests app can play. Dream Nests opens the room on nostrnests.com.
- Corny Chat and HiveTalk rooms open on their own sites.

### Full speaking
- Talking, raising your own hand and posting chat happen in the room's own app with a Nostr login. Dream Nests never speaks for you.

### About the earcons
- Mic on means a speaker unmuted, as published in Nests presence events. It is not voice detection.
- Corny Chat rooms and streams don't publish hand or mic events, so only room ended and chat work there.

## Keyboard and screen readers
- Everything is a normal link, button or checkbox.
- Each room is a heading, so heading navigation jumps room to room.
- Escape goes back to the room list from inside a room.
- The room list updates every minute without moving your focus.

## Settings
- Earcons on or off, an optional soft tick for each chat message, and a Play all earcons button.
- Show or hide other live streams, and show or hide sensitive rooms (hidden by default).
- Relay list. The default is a short list of large, well-known relays: relay.damus.io, nos.lol, relay.primal.net, relay.snort.social and relay.ditto.pub.

## Credits
Built only from repos starred by 2three1y. Each one is listed below with its license and what it does here.

### nostr-tools
- Repo: https://github.com/nbd-wtf/nostr-tools
- Author: fiatjaf and contributors
- License: Unlicense
- Used for: connecting to relays, reading and verifying events, naddr links. The browser bundle (2.25.2) is in vendor/ unchanged.
- Notice: none required. Full text in licenses/nostr-tools.txt

### Nostr Nests
- Repo: https://github.com/nostrnests/nests
- Author: Nostr Nests
- License: MIT
- Used for: the room format, presence with hand and mic state, live chat, live-room rules and room links, re-written in plain JavaScript.
- Notice: Copyright (c) 2024 Nostr Nests. Full text in licenses/nests.txt

### Corny Chat
- Repo: https://github.com/vicariousdrama/cornychat
- Author: vicariousdrama
- License: AGPL-3.0
- Used for: reference only. Dream Nests reads the public events Corny Chat publishes and links to its rooms. No code is copied, so this project stays MIT.

Earcons are made live with the Web Audio API, so there are no sound files.

## Tests
`node --test test/` checks the page structure, accessibility rules, credits and the room logic (sensitive filter, room types, live or ended).

## License
MIT. See LICENSE and NOTICE.
