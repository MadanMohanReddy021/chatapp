# Simple Messenger

Android-first one-to-one messaging MVP using Expo development builds, React Native, SQLite on the device, and a Node.js + Socket.IO relay. Chat bodies are never written to a server database. When the recipient is offline, the relay holds messages in a bounded in-memory queue that disappears when the server restarts.

## Requirements

- Node.js 20.19 or newer and npm
- Android Studio with an Android SDK and an emulator, or an Android phone with USB debugging enabled
- A development build (Expo Go cannot load the WebRTC native module included for the later voice/video phases)

## Install

From this folder:

```sh
npm install
```

## Run the server

```sh
npm run dev:server
```

The server listens on port 3000 by default. For a phone or emulator, set `EXPO_PUBLIC_SERVER_URL` in `apps/mobile/.env` to an address reachable from the device. Use `http://10.0.2.2:3000` for the Android emulator, or the computer's LAN IP for a physical phone. `localhost` on a phone points to the phone itself.

Example `apps/mobile/.env`:

```env
EXPO_PUBLIC_SERVER_URL=http://10.0.2.2:3000
```

## Host the relay on Render

The repository includes `render.yaml` for a single-instance Render web service. Connect this project to a Git provider, select the repository containing this folder, and create a Blueprint from `render.yaml`. Render will install the npm workspaces, start the Socket.IO relay, and check `/health`. After deployment, copy the service's `https://<service-name>.onrender.com` URL into `apps/mobile/.env` as `EXPO_PUBLIC_SERVER_URL` (the app converts HTTPS to secure WebSocket connections automatically), then rebuild the Android app so the hosted URL is included.

The free Render service may sleep while idle. When it restarts, its temporary offline-message queue, call sessions, and push-token registrations are cleared. Keep the service at one instance because the relay state is in memory. This is suitable for testing; persistent queues and multi-instance scaling need shared storage, which this project intentionally does not use.

## Build and run the Android development client

```sh
npm run android -w @simple-messenger/mobile
```

This generates the Android native project, compiles the custom development client, installs it on the connected emulator/device, and starts Metro. The first build needs Android Studio/SDK setup and may take several minutes. For later JS-only edits, run `npm run start -w @simple-messenger/mobile` and open the project in the installed development client. Rebuild after native dependency or app-config changes.

## Test messaging on Android and the laptop browser

Install the web dependencies with `npm install` after pulling or copying this project. Set `EXPO_PUBLIC_SERVER_URL` in `apps/mobile/.env` to the laptop's LAN address so both the phone and laptop browser can reach the same relay. Keep the server running with `npm run dev:server` from this folder.

From `apps/mobile`, run `npx expo start`. Scan the QR code with the installed Android development build. In that same Expo terminal, press **W** to open the web client on the laptop. The browser client uses its own local browser identity and SQLite database, so copy its ID into the phone (or vice versa) to start a chat. Opening `http://localhost:8081` directly shows Metro's manifest; use **W** to open the app itself.

Web SQLite requires the included Metro WebAssembly and cross-origin isolation configuration. Browser storage is local to that browser profile and is separate from Android's secure identity and SQLite database. Voice and video calls are available in the browser and native Android app; use HTTPS or localhost for browser camera/microphone permissions. The initial WebRTC setup uses a public STUN server, so calls may need a TURN relay to work across restrictive networks.

## Use the text MVP

Each install creates and securely stores a random UUID the first time the app opens. Share that ID with another user, enter their ID, connect to the relay, and send text. Messages are saved in the sender's and recipient's local SQLite databases. A recipient who is temporarily offline can receive messages after reconnecting while the server process and its in-memory queue remain alive. The app deduplicates messages by message ID and acknowledges receipt only after the SQLite insert succeeds.

The UUID is an address, not an account credential: the current MVP has no signup, authentication, or identity recovery. A relay operator can also read messages while routing them; end-to-end encryption is not implemented.

## Project layout

- `apps/mobile`: Expo app, local identity, SQLite message store, and Socket.IO client
- `apps/server`: Node.js Socket.IO relay, validation, acknowledgements, deduplication, and volatile offline queue
- `packages/protocol`: shared typed Socket.IO contracts and Zod payload schemas

## Contacts, calls, and notifications

Contacts (display names and peer IDs) are stored only in each client's local SQLite database. Select a contact on the Chats screen to open the conversation. The chat header includes voice and video call actions. Call signaling is validated and relayed over Socket.IO; call sessions and push tokens are held in server memory only, alongside the temporary offline message queue.

For Android push notifications, create/configure an Expo EAS project, set `EXPO_PUBLIC_EAS_PROJECT_ID` in `apps/mobile/.env`, configure Android FCM v1 credentials for that project, and rebuild/reinstall the development client after installing the notifications module (`npm run android -w @simple-messenger/mobile`). Then tap **Enable message and call notifications** in the app. Push tokens are volatile on the relay and register again when a client reconnects. In the browser, grant notification permission in the app; browser notifications appear for messages received while that tab is hidden. Expo Go is not supported for push notifications or WebRTC; use the installed development build.

Calls use a public STUN server for prototype connectivity. A TURN service is needed for reliable calls across many mobile carriers, NATs, and firewalls. Signaling and temporary push-token storage are not persistent; calls stop and registrations are lost when the server restarts.
