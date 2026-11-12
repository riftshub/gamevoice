# Dead Air voice companion

A single Node.js service serving the microphone page and authenticated game relay. No third-party packages, audio recordings, transcription, database, or analytics are used. Only numeric volume events are retained temporarily in memory.

## Verified locally

Eight HTTP integration tests pass: pairing and delivery, game/device credential separation, single-use and replacement codes, short-noise preservation, game-server isolation, code/event expiry, malformed input rejection, and public-page credential isolation. Frontend JavaScript passes `node --check`.

The actual browser page passed nine checks in isolated headless Chrome using synthetic Web Audio input: pairing, capture graph setup, calibration, intensity delivery to the authenticated game-poll endpoint, numeric-only request bodies, mute, unmute, phone-width layout, and stopping capture tracks on disconnect. No physical microphone was used. A live microphone-to-Roblox test still requires deployment and experience-secret configuration. Evidence is in Relay-Browser-QA.json in the parent outputs directory.

## Run

Use Node.js 22 or 24. Set `RELAY_SHARED_KEY` to a random secret of at least 32 characters in your process environment, then run:

```text
npm start
```

The service listens on `PORT` (default 3000). `GET /health` returns `{ "ok": true }`.

```text
npm test
```

In an execution sandbox that disallows child-process spawning, the equivalent checked command is:

```text
node --test --test-isolation=none test/relay.test.mjs
```

## Deploy to Render

1. Put this directory at the root of a new private GitHub repository and push it. The files contain no real credentials.
2. Create a Blueprint from its `render.yaml`, or create a single Node web service with build command `npm test`, start command `npm start`, and health path `/health`.
3. The Blueprint selects a free web service and generates `RELAY_SHARED_KEY`. Review the plan before applying it. Keep one instance: session routing is in memory.
4. In Render's Environment page, obtain the generated `RELAY_SHARED_KEY` privately. Store the same value in the Roblox experience's secrets store under `DEAD_AIR_RELAY_KEY`, scoped to the relay hostname. Do not put the value in a Script, LocalScript, source file, screenshot, or chat.
5. Enable HTTP requests for the experience. Set the `RelayURL` attribute on `ServerScriptService.DeadAirMicrophoneBridge` to the deployed HTTPS origin, without a trailing path. Its `SecretName` attribute defaults to `DEAD_AIR_RELAY_KEY`.
6. Test in a published game server. Experience secrets are not available in a normal local Studio run; local-secret setup is a separate Studio configuration if desired.
7. Press **V** in the game, enter the private pairing code on the companion, enable the microphone, and calibrate in a quiet room. Browser microphone permission must be granted by the player.

Render connection is available and the user confirmed **Danielle's workspace** (`tea-dbgi6h7lk1mc73bvv2u0`). GitHub tools are now connected, but no repository-creation tool is available and there is no separate companion repository yet. Create a private repository and send its URL; source files can then be uploaded through the connected tools. No new repository or deployment has been created. Existing Render services `game` and `game1` were inspected read-only and were not changed.

References: [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Render free services](https://render.com/docs/free), [Roblox HttpService and GetSecret](https://create.roblox.com/docs/reference/engine/classes/HttpService).

## Behavior

- Codes expire after ten minutes and are single-use. Device tokens expire after two hours.
- Pairing codes are sent privately to the requesting Roblox player, not replicated as public Player attributes.
- The server-authentication secret is never delivered to the browser. Browser credentials can only post levels for their paired player.
- The game registers its player roster, then polls every two seconds. It resolves sound events to each player's current in-game position.
- Quiet heartbeats keep the link alive. A brief loud sound is retained at its peak until the next poll, so a silent heartbeat does not erase it.
- Events older than four seconds are discarded; repeated or reordered device sequence numbers are ignored.
- Pair attempts and device messages are rate-limited. Invalid and non-finite levels are rejected.
- Loud microphone events can expose a player hiding in a locker and reset the current transmission phase.
- When a link fails, the game continues to use footsteps and interactive-world noises. The browser reconnects or requests pairing again after an expired link.
- Restarting or redeploying this one-instance service loses its temporary pairings. The game re-registers; affected players need to pair again.

## API

Game routes require `Authorization: Bearer <RELAY_SHARED_KEY>`:

| Route | Request | Result |
|---|---|---|
| `POST /api/game/register` | `{serverId, users: [userId], rotateUserIds?: [userId]}` | `{pairs: [{userId, code, connected}]}` |
| `GET /api/game/events?serverId=...` | No body | Queued `{userId, intensity, timestamp}` events and link states |

Device routes:

| Route | Request | Result |
|---|---|---|
| `POST /api/pair` | `{code}` | `{deviceToken, expiresIn}` |
| `POST /api/level` | Bearer device token; `{intensity: 0..1, sequence: integer}` | `{ok: true}` |
