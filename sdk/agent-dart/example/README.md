# callio_agent example

A minimal agent app on `callio_agent` (Android). It connects with an agent
token and lets the agent go available, then answer, decline, mute or hang up.
When the app isn't in front, calls ring on the phone's native call screen.

Get a token (on the Callio server):

```bash
npm run -s agent:token -- --consumer midlr-dev --tenant 103 --agent 110 --minutes 720
```

Run it on a connected phone (`flutter devices`):

```bash
flutter run --dart-define=CALLIO_URL=https://callio.pcg-ms.com --dart-define=CALLIO_TOKEN=eyJ...
```

Without `CALLIO_TOKEN` the app asks for the URL and token on its first
screen. `CALLIO_DEVICE_ID` sets the device id (default `android-example`).
