# Tesla ETA

A small self-hosted or cloud-hosted app for sharing a Tesla's live location and navigation ETA from TeslaMate. Node.js maintains one MQTT-over-WebSocket connection; viewers receive restricted snapshots over server-sent events (SSE). MQTT updates are coalesced over 150 ms, and a 15-second heartbeat refreshes stale-data status. The browser reconnects automatically. The admin list still refreshes every 15 seconds. No MQTT credentials reach the browser.

## Local live preview

Requires Node.js 22.13+ (Node 24 recommended).

```sh
cp .env.example .env
# Fill in your MQTT endpoint and service token in .env
# Set PUBLIC_ORIGIN=http://127.0.0.1:3000 for local preview
npm ci
npm run dev
```

Open http://127.0.0.1:3000/admin, create a link, then open its preview. Local preview uses your real MQTT data and SQLite database, disables admin authentication, and binds only to loopback. Never expose this mode through a tunnel or reverse proxy. There is no simulated-data mode.

## Production configuration

Copy `.env.example` to `.env`. Set these values:

- `PUBLIC_ORIGIN`: your public HTTPS origin, e.g. `https://eta.example.com`.
- `MQTT_URL`: the full broker WebSocket URL, e.g. `wss://mqtt.example.com/mqtt`. Use the actual path your broker exposes.
- `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`: the optional service token for the **MQTT Access application**, not your admin application. Omit both for brokers without Access.
- `MQTT_USERNAME` and `MQTT_PASSWORD`: separate broker credentials if required. Grant read-only access to `teslamate/cars/+/+`.
- `CF_ACCESS_TEAM_DOMAIN`: `https://your-team.cloudflareaccess.com`.
- `CF_ACCESS_ADMIN_AUD`: the audience tag of your **admin Access application**.
- `DATABASE_PATH`: persistent SQLite file; Docker uses `/data/eta.sqlite`.
- `LOCAL_PREVIEW=false`.

### Cloudflare Access

1. On the MQTT hostname, configure a **Service Auth** policy accepting the service token. The server opens a WSS connection using `new WebSocket(url, ['mqtt'], { headers: ... })`. This generates `Sec-WebSocket-Protocol: mqtt`, alongside `CF-Access-Client-Id` and `CF-Access-Client-Secret`. These are service-token credentials; a browser service worker cannot safely hold them.
2. On the ETA hostname, create a separate self-hosted Access application protecting **both `/admin` and `/admin/*`**, allowing only your identities. All admin pages, scripts, status, link creation/listing, and revocation are under that prefix.
3. Leave `/s/*` public so recipients can use their links without logging in. Avoid an Access rule covering the entire ETA hostname unless public shares are explicitly excluded.
4. The server verifies the Access JWT signature, issuer, audience, and expiration on every admin request. Missing configuration fails closed. Merely sending a forged Access header does not authenticate a user. Admin mutations also check the origin and a custom request header.
5. Disable caching for this app in any custom Cloudflare cache rules. Responses already include `Cache-Control: no-store`. Avoid logging `/s/` URLs in analytics or access logs because they contain bearer tokens.

### Option A: self-hosted Docker

```sh
cp .env.example .env
# Fill in .env, then:
docker compose up -d --build
```

The published port is loopback-only (`127.0.0.1:3000`). Point a host-based Cloudflare Tunnel or reverse proxy to `http://localhost:3000`. If cloudflared runs in Docker, attach it to the app's Docker network and target `http://tesla-eta:3000` instead. Apply the Access rules above. The named `eta-data` volume preserves links across restarts. Keep one application instance.

### Option B: cloud hosting

The included `render.yaml` deploys the same Docker app to a Render web service with a persistent disk. Push the repository to your Git provider, create a Render Blueprint from it, and fill in the prompted environment values. This configuration uses a paid service and disk; inspect the provider's cost before creating it. Add your custom domain through Render, put it behind Cloudflare, set `PUBLIC_ORIGIN` to that domain, and configure the Access application above. Keep a single instance and ensure the persistent disk is writable by the container's `node` user (UID 1000).

You can also run the Docker image on a VM or another always-on container host with a writable volume mounted at `/data`. Static hosting and request-only/serverless hosting are not suitable for this implementation's persistent MQTT connection and SQLite storage. No cloud resources are created by this repository.

## Sharing behavior

- Links use 256-bit random bearer tokens. SHA-256 hashes are used for public lookups. New tokens are also stored encrypted with AES-256-GCM so an authenticated admin can recover an active link using Copy link. The encryption key is saved beside the database as `eta.sqlite.key`; preserve it with the database volume and backups. Existing hash-only links continue working but cannot be recovered. Expired and revoked links cannot be recovered.
- Each link grants access to one car for 1 hour through 7 days. Revocation closes active SSE streams immediately; expiry is checked every second. Expired links remain in the admin list with a Remove action for 24 hours, then their database records are deleted automatically on startup or during the next minute. The viewer clears the tracking page when sharing ends. Data a recipient already saved cannot be withdrawn.
- Links follow the **vehicle**, including subsequent navigation destinations, until expiration or revocation. They do not automatically stop on arrival. Choose a short expiry for a single trip.
- Nothing exposes a public vehicle list or raw MQTT topic stream. Only the fields used for the trip snapshot are returned.
- No position history is stored. Links survive restarts; telemetry is restored from MQTT messages.
- Retained MQTT values have unknown source age and are marked as last-known. Live freshness uses server receipt time, not an unavailable Tesla source timestamp. Speed and route estimates are suppressed after two minutes without a non-retained update or when MQTT disconnects. Freshness thresholds may need tuning for your TeslaMate publishing interval.
- Arrival is anchored to the receipt time of the navigation update, not recalculated as “now plus minutes” on every refresh. Arrival is shown in the viewer's time zone. Traffic delay is displayed separately, not added again.
- No route line is drawn: TeslaMate does not provide the Tesla navigation route polyline in these fields.
- OpenStreetMap supplies map tiles, including attribution. Tile requests disclose the viewed map area to the tile provider. Use a suitable tile service for higher-volume deployments.

## Fields

Uses TeslaMate's current JSON `location` and `active_route` topics rather than deprecated separate coordinates. Also reads `speed` (km/h), `heading`, `display_name`, `state`, `healthy`, and `battery_level`. The viewer shows destination, location, speed, minutes remaining, arrival time, distance remaining, estimated arrival battery, traffic delay, and freshness. It displays an original red navigation arrow styled similarly to Tesla's directional marker.

Useful optional future additions are a user-selectable vehicle nickname and automatic trip-end expiry. Door/lock state, VIN, odometer, and home geofence labels are unnecessary for recipients and are not shared.

## Verification

```sh
npm test
```

Tests cover expiry/revocation, token hashing, per-car isolation, protected admin routes, cross-origin mutation rejection, retained data, stale ETA, malformed coordinates, and route clearing. The local live preview lets you exercise create/copy/open/revoke. Real Cloudflare/MQTT integration needs your own credentials and endpoint. Run Docker/cloud deployment checks in the destination environment.

## References

- [TeslaMate MQTT fields](https://docs.teslamate.org/docs/integrations/mqtt/)
- [MQTT.js WebSocket options](https://github.com/mqttjs/MQTT.js)
- [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Cloudflare JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Render Blueprint configuration](https://render.com/docs/blueprint-spec)

## Read-only MQTT

The app only subscribes; it never calls MQTT publish and configures no last will. An application guard rejects both publish methods and rejects any last-will configuration. CONNECT, SUBSCRIBE, PINGREQ, and DISCONNECT are protocol control packets, not topic publications. For independent enforcement, give its MQTT account read-only ACLs for `teslamate/cars/+/+` and deny topic writes. Cloudflare service tokens authenticate the WebSocket handshake, not MQTT topic permissions.

The map automatically fits the vehicle and destination until the viewer pans or zooms. Recenter resumes tracking. The viewer fits desktop and phone viewports; extremely small screens and enlarged text can scroll to preserve access to controls.
The icon controls in the header select automatic, light, or dark appearance. Automatic is the default and follows the device setting; a manual choice is remembered in that browser. The viewer's unit selector is beside them.

## MQTT settings in the admin page

Open **MQTT connection** under `/admin`. Enter the broker URL; its protocol automatically selects regular MQTT (`mqtt://` or `mqtts://`) or WebSocket (`ws://` or `wss://`), and optionally add broker credentials. HTTPS/HTTP URLs entered for WebSocket are converted to WSS/WS. Cloudflare service tokens are optional and require WSS. The form accepts either token values or `CF-Access-Client-Id: value` and `CF-Access-Client-Secret: value`; known header prefixes and surrounding whitespace are removed. Multiline values are rejected.

Saved settings override environment defaults and reconnect immediately. They are encrypted in SQLite using the same persisted key as recovered sharing links. Secret values are never returned to the browser: blank fields keep saved secrets, the clear-password checkbox removes the broker password, and disabling Cloudflare removes its service token. Switching brokers clears cached telemetry; existing links select the same numeric car IDs on the new broker, so revoke existing links before switching to an unrelated fleet.

For reverse proxies, disable SSE buffering and retain connections longer than the 15-second heartbeat. Nginx should use `proxy_buffering off` and an appropriate `proxy_read_timeout` on `/s/*/events`. The application sends `X-Accel-Buffering: no` and `Cache-Control: no-store, no-transform`.

The admin dashboard shows live viewer counts for each link via a protected SSE endpoint under `/admin`. Counts represent active viewing tabs (not unique people) and drop when their streams close, links expire, or links are revoked. Lost network connections may remain counted until the server detects the disconnect. Counts are in-memory and reset on restart, then rebuild as viewers reconnect.

## Public sharing URL

Set the public origin in **Admin → Settings → Sharing URL**. It is persisted in SQLite and takes effect immediately for created and recovered links. Saving does not configure DNS or hosting. Existing tokens are unchanged. `PUBLIC_ORIGIN` remains the production app/admin origin used for request-origin validation and the initial default for sharing links; changing the dashboard sharing URL does not change that security setting. Public sharing URLs require HTTPS; loopback HTTP is accepted in local preview.

Other environment settings are `PORT`, `DATABASE_PATH`, `LOCAL_PREVIEW`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_ADMIN_AUD`. MQTT URL, broker credentials, and MQTT Cloudflare service-token variables are startup defaults overridden by the dashboard’s saved MQTT configuration. The Cloudflare admin audience and team domain remain environment-only to avoid changing admin authentication through the UI.
