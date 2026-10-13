# [Tesla ETA](https://dennisgarvey.github.io/TeslaETA/)

Share a TeslaMate vehicle's location and navigation ETA through time-limited links. The app subscribes to TeslaMate's MQTT topics, serves the admin dashboard and viewer pages, and stores sharing links in SQLite.

## Admin access

Set `PUBLIC_ORIGIN` to the HTTPS origin used to open the app. Leave `/s/*` accessible to link recipients and protect both `/admin` and `/admin/*`.

By default, the app verifies Cloudflare Access JWTs. Create a self-hosted Access application for both admin paths; [the wildcard does not cover `/admin` itself](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/). Use its Audience (AUD) tag for `CF_ACCESS_ADMIN_AUD` in the Compose example below.

If your reverse proxy handles admin authentication, set `ADMIN_AUTH_MODE=external` instead and omit those two Cloudflare settings. The app then trusts the proxy for `/admin` requests, so the app port must not be reachable around it.

## Docker Compose

Example service configuration:

```yaml
services:
  tesla-eta:
    image: ghcr.io/dennisgarvey/teslaeta:latest
    restart: unless-stopped
    environment:
      PUBLIC_ORIGIN: https://eta.example.com
      PORT: 3001
      ADMIN_AUTH_MODE: cloudflare
      CF_ACCESS_TEAM_DOMAIN: https://your-team.cloudflareaccess.com
      CF_ACCESS_ADMIN_AUD: your-admin-application-audience-tag
      DATABASE_PATH: /data/eta.sqlite
    ports:
      - "127.0.0.1:3001:3001"
    volumes:
      - eta-data:/data

volumes:
  eta-data:
```

Replace the example hostname and Access values. The HTTP endpoint is `http://127.0.0.1:3001` on the host or `http://tesla-eta:3001` on the Compose network. If your TeslaMate broker service is named `mosquitto`, enter `mqtt://mosquitto:1883` under **Admin → MQTT connection**.

Run one app instance and preserve `/data` during upgrades and backups; it contains the SQLite database and its encryption key. If using Nginx, disable buffering for the viewer and admin event streams.

## Connect TeslaMate

Open **`/admin` → MQTT connection** and enter the broker URL:

- `mqtt://` or `mqtts://` for MQTT; `ws://` or `wss://` for MQTT over WebSocket. Include the broker's WebSocket path when it has one. The URL selects the transport.
- Broker username and password are optional. For an account dedicated to this app, allow subscription to `teslamate/cars/+/+` and deny publication.
- If the WebSocket endpoint is behind Cloudflare Access, create a Service Auth policy for the MQTT hostname, then enable its service token in the dashboard and enter the client ID and secret. This requires `wss://` and is separate from the Access application protecting `/admin`.

**Save and connect** applies the settings immediately. A saved connection takes precedence over the optional MQTT environment variables below. Blank secret fields keep their saved values.

On **Sharing**, choose a vehicle and an expiry, then create a link. Treat the link as a secret: anyone with it can view that vehicle until it expires or is revoked. It continues to follow later destinations. The sharing address defaults to `PUBLIC_ORIGIN`; change it under **Settings** if recipients use another hostname that routes to the same app.

## Environment options

- `PUBLIC_ORIGIN` — required HTTPS origin for the app and admin requests; initial sharing-link origin.
- `ADMIN_AUTH_MODE` — `cloudflare` (default) verifies Cloudflare Access JWTs; `external` trusts authentication enforced by your proxy on `/admin` and `/admin/*`.
- `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_ADMIN_AUD` — required only with `ADMIN_AUTH_MODE=cloudflare`.
- `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` — optional starting broker settings. Dashboard settings override them once saved.
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` — optional MQTT WebSocket service token used with `MQTT_URL`.
- `DATABASE_PATH` — SQLite file location. Docker sets `/data/eta.sqlite`.
- `PORT` — HTTP port, default `3001`.

[TeslaMate MQTT topics](https://docs.teslamate.org/docs/integrations/mqtt/) · [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
