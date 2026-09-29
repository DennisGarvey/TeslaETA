# [Tesla ETA](https://dennisgarvey.github.io/TeslaETA/)

Share a TeslaMate vehicle's location and navigation ETA through time-limited links. The app subscribes to TeslaMate's MQTT topics, serves the admin dashboard and viewer pages, and stores sharing links in SQLite.

## Set up access

Use an HTTPS hostname for the app. In Cloudflare Access, protect **both `/admin` and `/admin/*`** with a self-hosted application for your administrators; [the wildcard does not cover the parent path](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). Leave `/s/*` accessible to link recipients. Set these environment variables for the app:

```dotenv
PUBLIC_ORIGIN=https://eta.example.com
CF_ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com
CF_ACCESS_ADMIN_AUD=your-admin-application-audience-tag
```

`PUBLIC_ORIGIN` must be the hostname used to open the admin page. Use the Access application's Audience (AUD) tag for `CF_ACCESS_ADMIN_AUD`. The app verifies the Access JWT using the team domain and audience tag; both values are required in production. The origin also supplies the initial address for sharing links. You can change the sharing address later under **Admin → Settings**, provided that address routes to this app.

## Standalone Docker install

The included [compose.yaml](compose.yaml) builds the app, binds it to `127.0.0.1:3000`, and keeps the database in the `eta-data` volume:

```sh
cp .env.example .env
# Set the three production values above in .env
docker compose up -d --build
```

Point your reverse proxy or Cloudflare Tunnel at `http://127.0.0.1:3000`. If the tunnel runs in Docker on the same network, target `http://tesla-eta:3000` instead.

## Alongside a TeslaMate Compose stack

Clone this repository as `teslaeta` beside your TeslaMate `docker-compose.yml`. Add this service under `services:` and the volume under the existing top-level `volumes:`:

```yaml
services:
  tesla-eta:
    build: ./teslaeta
    restart: unless-stopped
    environment:
      PUBLIC_ORIGIN: https://eta.example.com
      CF_ACCESS_TEAM_DOMAIN: https://your-team.cloudflareaccess.com
      CF_ACCESS_ADMIN_AUD: your-admin-application-audience-tag
      DATABASE_PATH: /data/eta.sqlite
    ports:
      - "127.0.0.1:3001:3000"
    volumes:
      - eta-data:/data

volumes:
  eta-data:
```

Use your own hostname and Access values, then run `docker compose up -d --build tesla-eta` from the TeslaMate directory. Point the proxy or tunnel at `http://127.0.0.1:3001`; a tunnel container on the same Compose network can use `http://tesla-eta:3000`. In **Admin → MQTT connection**, use `mqtt://mosquitto:1883` if the broker service is named `mosquitto`.

For either install, keep one app instance and preserve the `/data` volume during upgrades and backups; it contains `eta.sqlite` and its encryption key. If using Nginx, disable buffering for the viewer and admin event streams.

## Connect TeslaMate

Open **`/admin` → MQTT connection** and enter the broker URL:

- `mqtt://` or `mqtts://` for MQTT; `ws://` or `wss://` for MQTT over WebSocket. Include the broker's WebSocket path when it has one. The URL selects the transport.
- Broker username and password are optional. For an account dedicated to this app, allow subscription to `teslamate/cars/+/+` and deny publication.
- If the WebSocket endpoint is behind Cloudflare Access, create a Service Auth policy for the MQTT hostname, then enable its service token in the dashboard and enter the client ID and secret. This requires `wss://` and is separate from the Access application protecting `/admin`.

**Save and connect** applies the settings immediately. A saved connection takes precedence over the optional MQTT environment variables below. Blank secret fields keep their saved values.

On **Sharing**, choose a vehicle and an expiry, then create a link. Treat the link as a secret: anyone with it can view that vehicle until it expires or is revoked. It continues to follow later destinations. The sharing address defaults to `PUBLIC_ORIGIN`; change it under **Settings** if recipients use another hostname that routes to the same app.

## Environment options

- `PUBLIC_ORIGIN` — required HTTPS origin for the app and admin requests; initial sharing-link origin.
- `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_ADMIN_AUD` — required production admin authentication settings.
- `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` — optional starting broker settings. Dashboard settings override them once saved.
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` — optional MQTT WebSocket service token used with `MQTT_URL`.
- `DATABASE_PATH` — SQLite file location. Docker sets `/data/eta.sqlite`.
- `PORT` — HTTP port, default `3000`.
- `LOCAL_PREVIEW` — set to `true` only for local development. It binds to loopback and skips admin authentication.

For local development, copy `.env.example` to `.env`, set `PUBLIC_ORIGIN=http://127.0.0.1:3000`, then run `npm ci` and `npm run dev`. Node.js 22.13 or later is required. Run the test suite with `npm test`.

[TeslaMate MQTT topics](https://docs.teslamate.org/docs/integrations/mqtt/) · [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
