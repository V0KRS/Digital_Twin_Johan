# Enterprise twin expansion

## Current implementation boundaries

The browser remains a visualization and operator workstation. It never connects directly to Mosquitto. `gateway/gateway.py` is the integration boundary; its SQLite WAL database stores normalized samples and raw MQTT payloads before fan-out and retains an unsynced queue for InfluxDB v2. History requests use the WebSocket transport; the local REST service provides trend aggregates and heuristic health. Commands require a signed HS256 JWT with operator/admin role, issuer, expiry, and optional asset grants, then pass topic/action allow-lists and are recorded in the local audit ledger.

```text
PLC / OPC UA ─┐              ┌─ live telemetry ─ WebSocket ─ Vite / Three.js
              ├─ Mosquitto ─ Python gateway ─ SQLite edge queue ─ InfluxDB v2
Operator UI ──┘       ▲        └─ historian query / command receipt
                      └──────── factory/control/{asset}/{action}
```

## Local setup

1. Start Mosquitto using `docker compose -f docker-compose.simulator.yml up -d` or the installed Windows service.
2. Install gateway packages with `.venv\Scripts\pip install -r gateway\requirements.txt`. Set a long random `GATEWAY_JWT_SECRET` in the gateway process environment to enable command dispatch. Start `python gateway\gateway.py` from the repository root. SQLite is created at `gateway/data/edge.db`; REST listens on `127.0.0.1:8080`.
3. For a cloud historian, set `influx.url`, `org`, `bucket`, and `token` in `gateway/config.example.yaml`; the gateway sync loop retries while retaining local rows. Keep credentials outside source control for production.
4. Set `VITE_TELEMETRY_WS_URL=ws://localhost:8765`, `VITE_TELEMETRY_HISTORY_WS_URL=ws://localhost:8765`, `VITE_ANALYTICS_API_URL=http://localhost:8080/api/v1/trends`, `VITE_HEALTH_API_URL=http://localhost:8080/api/v1/health/estimate`, and `VITE_NOTES_API_URL=http://localhost:8080/api/v1/notes` in `.env.local`; start the UI with `npm run dev`.
5. MQTT input remains JSON `{ "tag": "...", "value": 23.4, "timestamp": "2026-10-18T04:00:00Z", "quality": "good" }`. Missing timestamp and quality are normalized by the gateway.

## Asset identity and template schema

Evolve `TwinMetadata` into versioned AAS-style submodels. `globalId` is assigned once by the asset registry, never derived from a mesh name; the same IRI is attached to the physical asset record, twin entity, and `Object3D.userData.assetId`. A template defines semantic property paths; an instance only supplies its immutable ID and MQTT namespace. Migration should retain the old `sourceTag` as a compatibility override until all existing projects are upgraded.

```json
{
  "modelType": "Centrifugal_Pump",
  "globalId": "https://plant.example.com/aas/pump/02",
  "submodels": [{ "idShort": "OperatingData", "properties": [
    { "idShort": "temperature", "semanticId": "urn:example:temperature", "type": "number", "unit": "Cel", "path": "temperature" },
    { "idShort": "pressure", "semanticId": "urn:example:pressure", "type": "number", "unit": "bar", "path": "pressure" },
    { "idShort": "vibration", "semanticId": "urn:example:vibration", "type": "number", "unit": "mm/s", "path": "vibration" }
  ]}],
  "telemetryNamespace": "factory/telemetry/pump02"
}
```

The current pump profile creates `factory/telemetry/{node-name}/{temperature,pressure,vibration}` signal bindings. It stores a generated immutable IRI in the local project manifest. Replace generated identifiers with the enterprise asset registry before syncing across sites. Add physical location, manufacturer, serial, parent asset, model version, and WoT `forms`/protocol metadata as separate semantic fields.

## Feature modules and rollout order

| Module | Implementation seam | Production completion |
| --- | --- | --- |
| Historian / DVR | SQLite WAL; history query; `HistoryBar` playback | Current playback sends bounded local SQLite range in one response. Add paging, retention/downsampling and timestamp-delta replay for large windows. |
| Trends / analytics | REST 1h/24h/7d queries with min/max/mean/stddev/outlier summary | Add query paging, downsampling and configurable anomaly policy for high-volume deployments. |
| Templates / AAS | Versioned typed signal metadata, generated URI and pump template | Add formal AASX/registry integration, global ID resolution, and migration for shared multi-user projects. |
| CEP alarms | Temperature/vibration warning/critical tiers, hysteresis, notification center, pulsing materials and camera focus | Persist alarm state/history centrally; add dwell times and compound rules for multi-signal conditions. |
| Actuation / RBAC | HS256 JWT verification, operator role/asset grants, MQTT topic/action allow-lists, SQLite audit | Use enterprise OIDC validation, TLS, broker ACLs, secure replicated ledger, command expiry/nonce, and correlated device acknowledgements. Broker receipt currently means accepted by Mosquitto only. |
| Scene / X-ray | Structure/plumbing/HVAC/equipment layer filters; surface pin placement; alarm focus and cloned transparent structural materials | Add explicit authored semantic layer metadata and smoothly animate orbit/pan transitions. |
| Notes / maintenance | Mesh-local anchors, ticket IDs, PDF data URLs, SQLite notes API and browser project persistence | Replace embedded PDFs with object storage and add authenticated authorship, thread comments, edit history and ticket system APIs for multi-user deployments. |
| Predictive health | Local heuristic plus REST estimate with score, hours, anomaly and confidence | Replace heuristic with validated model service, feature provenance, model versioning and calibrated confidence. |
| Edge / cloud | SQLite WAL queue, batch retry and InfluxDB v2 write sync | Add queue quotas, jittered backoff, disk watermark metrics, idempotency and deployment recovery operations. |

## Message contracts

History request: `{ "type":"history.query", "requestId":"uuid", "start":"UTC ISO-8601", "end":"UTC ISO-8601", "tags":["..." ] }`; response is `history.result` with ordered normalized events. Playback is client paced; production should use server paging rather than sending a large interval in one response.

Command request: `{ "type":"command", "command": { "token":"<signed JWT>", "assetId":"https://.../pump/02", "action":"shutdown", "topic":"factory/control/pump02/shutdown" } }`. The gateway derives user identity from JWT `sub`; non-admin tokens must also grant the IRI in `assets` and a matching topic prefix in `assetTopics[assetId]`, and may narrow permitted `actions`. The gateway creates command ID/time and waits up to five seconds for the MQTT QoS 1 broker acknowledgement. A device acknowledgement `{ "id":"<command-id>", "status":"confirmed" }` on the configured `factory/control/+/ack` topic updates the audit ledger.

Alarm rule shape for CEP migration: `{ "id":"...", "assetId":"...", "expression":{"all":[{"property":"temperature","gt":75},{"property":"vibration","gt":4}]}, "severity":"warning", "for":"30s", "clearBelow":72 }`. Use `warning` and `critical` states with hysteresis to avoid alarm chatter.

## Windows and deployment notes

Mosquitto on Windows may run as a Windows service or in Docker Desktop; the gateway uses `127.0.0.1:1883` for either when ports are forwarded. Do not expose anonymous development broker config beyond localhost. Store secrets in environment variables or a secret store, not YAML or `.env.local` committed to source control. For production, terminate WebSocket TLS at a trusted reverse proxy and keep the UI command surface disabled until gateway identity and device acknowledgement are implemented.
