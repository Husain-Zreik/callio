# Callio

Standalone WhatsApp WebRTC call-center service — the calls infrastructure
extracted from the `WhatsappCommunicationSystem` monorepo's `node/` app into
its own repo.

Handles: WhatsApp Business Calling API webhook ingress, agent assignment/
queueing, WebRTC signaling and media bridging (`wrtc`), IVR, call recording,
and push notifications for incoming calls (FCM/OneSignal/APNs VoIP). Chat,
orders, templates, activities, and tickets stayed behind in the monorepo —
this repo only ever imported the call + device Socket.IO namespaces from it.

## Start here

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the original developer guide for
  this codebase (folder structure, call flows, architectural patterns). It
  was written while this code still lived inside the monorepo, so it still
  has some prose references to the chat/orders/templates/activities/ticket
  namespaces that no longer exist here — those are now stale/out of scope,
  not fixed in this pass (low value relative to editing a 31KB doc by hand;
  flagged here as a known follow-up).
- [`TABLE_OWNERSHIP.md`](./TABLE_OWNERSHIP.md) — the contract for which
  service owns which MySQL table. **Important**: this service does not have
  its own database. It connects to the same MySQL instance the
  `WhatsappCommunicationSystem` Laravel backend uses, and reads/writes the
  same tables under the ownership rules that doc describes. Point this
  service's `.env` at that same database.

## Setup

```
cp .env.example .env   # fill in real values — DB/Redis point at the shared
                        # instance the main app uses; INTERNAL_API_KEY must
                        # match the main app's NODE_INTERNAL_API_KEY exactly
npm install
npm run dev             # or: pm2 start ecosystem.config.cjs
```

`storage/apple/` and `storage/firebase/` are gitignored — place the real
`AuthKey.p8` (APNs) and `google-services.json` (Firebase) credentials there
yourself; they are never committed.
