# Flux Works — Industrial Twin Studio

A browser based industrial digital twin workbench. Telemetry is expected from external industrial sources; there is no generated telemetry loop and no connection is made to plant equipment by the frontend.

## Start the workbench

```sh
npm install
copy .env.example .env.local
npm run dev
```

Set `VITE_TELEMETRY_WS_URL` to the gateway WebSocket endpoint. An optional `VITE_TELEMETRY_REST_URL` enables REST polling and is used as a fallback if the WebSocket disconnects. REST endpoints must return a JSON event or array of events in this shape:

```json
{"tag":"FactoryFloor.Line1.Pump02.Temperature","value":23.4,"timestamp":"2026-10-18T04:00:00Z","quality":"good"}
```

The UI accepts `good`, `uncertain`, and `bad` quality. Numeric and boolean values are converted using the configured signal data type. Unknown tags and invalid values are ignored. For production, terminate TLS at a trusted reverse proxy, authenticate/authorize clients, and keep industrial protocol credentials on the gateway side.

## Step 1: Configure twin assets and mappings

Import a model and assign equipment profiles to scene nodes. A profile creates metadata only; it does not create values. Each signal has a `sourceTag` field. Edit the saved project manifest (or metadata in `src/twinRuntime.ts`) to match the exact incoming tag path, for example `FactoryFloor.Line1.Pump02.Temperature`. The gateway broadcasts `{tag,value,timestamp,quality}` events; `src/liveData.ts` maps `tag` to a signal `sourceTag` and emits signal snapshots keyed by the twin signal ID.

For example, a mapping may connect `FactoryFloor.Line1.Pump02.Temperature` to the Temperature signal on the scene asset Pump02. The tree asset and tag mapping are independent, so the source tag need not resemble the display name.

## Step 2: Run the gateway

The gateway is a separate Python process because OPC UA and MQTT clients should not run in a browser. It subscribes to configured sources and forwards normalized events to browser WebSocket clients on port 8765.

```sh
python -m venv .venv
# Windows: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r gateway/requirements.txt
python gateway/gateway.py
```

Edit `gateway/config.example.yaml` before starting. Enable OPC UA and set `endpoint` plus the server NodeIds for a Prosys Simulation Server or another OPC UA server. Enable MQTT to subscribe to a broker and topic filter. The MQTT adapter accepts JSON events with `tag` and `value` fields. Sparkplug B deployments should use an edge/SCADA Sparkplug decoder or broker bridge to publish normalized JSON events; raw Sparkplug protobuf payloads are not decoded by this starter gateway.

## Step 3: Test with a local MQTT broker

Start Mosquitto:

```sh
docker compose -f docker-compose.simulator.yml up -d
```

Set the gateway MQTT host to `127.0.0.1`, port `1883`, enable MQTT, and set the subscription topic. For an OPC UA simulation test, configure the endpoint and NodeIds exposed by Prosys (the example URL and namespace are placeholders and vary by server configuration). Set the frontend WebSocket URL to `ws://localhost:8765`, then start the gateway and Vite app.

Publish a JSON MQTT message to the configured topic with `mosquitto_pub`:

```sh
mosquitto_pub -h localhost -t factory/telemetry/pump02 -m '{"tag":"FactoryFloor.Line1.Pump02.Temperature","value":23.4,"quality":"good"}'
```

Map a signal's `sourceTag` to the same exact string. On receipt, the live signals table, trend history, and configured alarm rules update immediately. The local Mosquitto compose file allows anonymous connections and is for isolated development only.

## Data path

- `src/model.ts` — project, asset, signal, mapping, alarm, and snapshot types.
- `src/twinRuntime.ts` — metadata-only equipment profiles, alarm evaluation, and bounded trend history.
- `src/liveData.ts` — browser WebSocket/REST clients, validation, and raw-tag mapping.
- `gateway/gateway.py` — OPC UA subscription and MQTT-to-WebSocket gateway.
- `gateway/config.example.yaml` — protocol connection settings and subscription examples.
- `src/TelemetryDock.tsx` — live values, connection state, alarms, and trends.

## Enterprise modules

The gateway now writes every normalized sample and original MQTT JSON payload to its SQLite WAL edge historian, and can flush batches to an optional InfluxDB v2 bucket. It exposes historical playback over WebSocket and local trend/health endpoints on `127.0.0.1:8080`. Set `VITE_ANALYTICS_API_URL` and `VITE_HEALTH_API_URL` in `.env.local` to enable the 1h/24h/7d trend query and health estimate panels.

Pump profiles generate AAS-style immutable IRIs and typed temperature, pressure, and vibration paths under `factory/telemetry/{asset}/...`. Warning/critical rules include hysteresis; active alarms appear in the notification center, pulse the asset material, focus the camera, and make structural meshes transparent. The scene tree has type filters, and double-clicking a mesh surface lets operators add a project-local spatial note, ticket ID, and optional PDF attachment.

The gateway supports MQTT write-back with topic/action allow-lists and a local SQLite audit ledger. Dispatch remains disabled until `GATEWAY_JWT_SECRET` is set. Commands require an HS256 JWT signed with that secret, issuer `water-twin`, unexpired `exp`, and `operator` or `admin` role. Optional JWT claims `assets` and `actions` narrow access. A successful receipt means the broker accepted the message, not that the physical device acted. Configure TLS, broker ACLs, enterprise identity validation, and correlated device acknowledgements before connecting to operational equipment.

The health estimate is a transparent starter heuristic and is not a validated Remaining Useful Life model. Notes sync to the gateway's local SQLite service and are also retained in the browser-local project; PDF data URLs are embedded in those records. The collaboration API suits a single gateway, but needs authenticated authorship, threaded comments, and object storage for multi-user or large-file use. Device receipt messages should be published to `factory/control/{asset}/ack` as `{"id":"<command-id>","status":"confirmed","receipt":"..."}`. See [ARCHITECTURE.md](ARCHITECTURE.md) for schemas, setup, and production rollout details. The local Mosquitto compose config allows anonymous connections and is for isolated development only.
