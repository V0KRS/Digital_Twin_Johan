"""Small development gateway: OPC UA and MQTT input -> normalized JSON WebSocket events."""
import asyncio
import json
import logging
import os
import statistics
from urllib.parse import parse_qs, urlparse
from datetime import datetime, timezone
from pathlib import Path

import yaml
import websockets
from gateway_services import EdgeStore, estimate_health, influx_write, normalize_timestamp, utc_now, validate_command

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("water-twin-gateway")
CONFIG = yaml.safe_load(Path(__file__).with_name("config.example.yaml").read_text(encoding="utf-8"))
CONFIG.setdefault("auth", {})["jwt_secret"] = os.environ.get("GATEWAY_JWT_SECRET", CONFIG.get("auth", {}).get("jwt_secret", ""))
CLIENTS = set()
STORE = EdgeStore(CONFIG.get("storage", {}).get("sqlite_path", "gateway/data/edge.db"))
MQTT_CLIENT = None


async def publish(event):
    # Persist first so WebSocket/database outages cannot create an edge data gap.
    event["timestamp"] = normalize_timestamp(event.get("timestamp", utc_now()))
    STORE.record(event)
    await broadcast(event)


async def broadcast(event):
    message = json.dumps(event, default=str)
    for client in tuple(CLIENTS):
        try:
            await client.send(message)
        except Exception:
            CLIENTS.discard(client)


async def handle_message(socket, raw):
    global MQTT_CLIENT
    try:
        request = json.loads(raw)
        if request.get("type") == "history.query":
            events = STORE.range(request["start"], request["end"], request.get("tags"))
            await socket.send(json.dumps({"type": "history.result", "requestId": request.get("requestId"), "events": events}))
        elif request.get("type") == "health.estimate":
            result = estimate_health(request.get("features", {}))
            await socket.send(json.dumps({"type": "health.result", "requestId": request.get("requestId"), **result}))
        elif request.get("type") == "command":
            command = validate_command(request.get("command"), {**CONFIG.get("commands", {}), **CONFIG.get("auth", {})})
            STORE.audit(command, "pending")
            if not MQTT_CLIENT:
                STORE.audit(command, "rejected", "MQTT command publisher unavailable")
                raise ValueError("MQTT command publisher unavailable")
            result = MQTT_CLIENT.publish(command["topic"], json.dumps(command), qos=1)
            if result.rc == 0:
                await asyncio.to_thread(result.wait_for_publish, 5)
            status = "broker-confirmed" if result.rc == 0 and result.is_published() else "rejected" if result.rc else "broker-timeout"
            receipt = str(result.rc)
            STORE.audit(command, status, receipt)
            await socket.send(json.dumps({"type": "command.receipt", "id": command["id"], "status": status, "receipt": receipt}))
    except Exception as exc:
        await socket.send(json.dumps({"type": "error", "message": str(exc)}))


async def websocket_client(socket):
    CLIENTS.add(socket)
    try:
        async for raw in socket:
            await handle_message(socket, raw)
    finally:
        CLIENTS.discard(socket)


async def opcua_source(config):
    from asyncua import Client
    while True:
        try:
            client = Client(url=config["endpoint"])
            if config.get("username"):
                client.set_user(config["username"])
                client.set_password(config.get("password", ""))
            async with client:
                nodes = [client.get_node(node_id) for node_id in config.get("node_ids", [])]

                class Handler:
                    async def datachange_notification(self, node, value, _data):
                        await publish({"tag": str(node.nodeid.Identifier), "value": value, "timestamp": datetime.now(timezone.utc).isoformat(), "quality": "good"})

                subscription = await client.create_subscription(250, Handler())
                await subscription.subscribe_data_change(nodes)
                log.info("OPC UA subscribed to %d nodes", len(nodes))
                while True:
                    await asyncio.sleep(60)
        except Exception:
            log.exception("OPC UA disconnected; retrying in 5 seconds")
            await asyncio.sleep(5)


def mqtt_source(config, loop):
    import paho.mqtt.client as mqtt
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=config.get("client_id", "water-twin-gateway"))
    if config.get("username"):
        client.username_pw_set(config["username"], config.get("password"))

    def on_connect(client, _userdata, _flags, reason_code, _properties):
        log.info("MQTT connected: %s", reason_code)
        client.subscribe(config.get("topic", "factory/telemetry/#"), qos=1)
        if config.get("command_ack_topic"):
            client.subscribe(config["command_ack_topic"], qos=1)

    def on_message(_client, _userdata, message):
        try:
            raw_payload = message.payload.decode("utf-8")
            event = json.loads(raw_payload)
            ack_filter = config.get("command_ack_topic", "")
            topic_parts, filter_parts = message.topic.split("/"), ack_filter.split("/")
            ack_match = bool(ack_filter) and (len(topic_parts) == len(filter_parts) or filter_parts[-1] == "#" and len(topic_parts) >= len(filter_parts) - 1) and all(expected in ("+", "#") or expected == actual for actual, expected in zip(topic_parts, filter_parts))
            if ack_match:
                command_id = event.get("id")
                if command_id:
                    receipt = str(event.get("receipt", event.get("status", "device acknowledged")))
                    STORE.confirm_command(command_id, "confirmed" if event.get("status") == "confirmed" else "device-rejected", receipt)
                    asyncio.run_coroutine_threadsafe(broadcast({"type": "command.deviceReceipt", "id": command_id, "status": event.get("status"), "receipt": receipt, "timestamp": utc_now()}), loop)
                return
            if not isinstance(event, dict) or "tag" not in event or "value" not in event:
                raise ValueError("expected JSON object with tag and value")
            event.setdefault("timestamp", utc_now())
            event.setdefault("quality", "good")
            event["rawPayload"] = raw_payload
            asyncio.run_coroutine_threadsafe(publish(event), loop)
        except Exception:
            log.exception("Ignoring invalid MQTT message on %s", message.topic)

    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(config.get("host", "127.0.0.1"), int(config.get("port", 1883)), 30)
    client.loop_start()
    return client


async def main():
    global MQTT_CLIENT
    server = await websockets.serve(websocket_client, CONFIG["websocket"]["host"], int(CONFIG["websocket"]["port"]))
    log.info("WebSocket stream listening on port %s", CONFIG["websocket"]["port"])
    tasks = []
    if CONFIG.get("http", {}).get("enabled", True):
        tasks.append(asyncio.create_task(run_health_http(CONFIG.get("http", {}))))
    if CONFIG.get("opcua", {}).get("enabled"):
        tasks.append(asyncio.create_task(opcua_source(CONFIG["opcua"])))
    loop = asyncio.get_running_loop()
    mqtt = mqtt_source(CONFIG["mqtt"], loop) if CONFIG.get("mqtt", {}).get("enabled") else None
    MQTT_CLIENT = mqtt
    try:
        async def sync_loop():
            while True:
                try:
                    rows = STORE.pending()
                    if rows and await influx_write(CONFIG.get("influx", {}), rows): STORE.mark_synced([row[0] for row in rows])
                except Exception: log.exception("Historian sync failed; retaining edge queue")
                await asyncio.sleep(2)
        tasks.append(asyncio.create_task(sync_loop()))
        await asyncio.gather(*tasks, server.wait_closed())
    finally:
        if mqtt:
            mqtt.loop_stop(); mqtt.disconnect()


async def run_health_http(config):
    async def handle(reader, writer):
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            request_line = headers.split(b"\r\n", 1)[0].decode()
            method, target, _ = request_line.split(" ", 2)
            parsed_target = urlparse(target)
            path = parsed_target.path
            length = 0
            for line in headers.split(b"\r\n")[1:]:
                if line.lower().startswith(b"content-length:"): length = int(line.split(b":", 1)[1].strip())
            body = await reader.readexactly(min(length, 20_000_000)) if length else b"{}"
            if method == "GET" and path == "/api/v1/trends":
                query = parse_qs(parsed_target.query)
                try:
                    tag, start, end = query["tag"][0], query["start"][0], query["end"][0]
                    values = [event for event in STORE.range(start, end, [tag]) if isinstance(event["value"], (int, float)) and not isinstance(event["value"], bool)]
                    numbers = [float(event["value"]) for event in values]
                    mean = statistics.fmean(numbers) if numbers else 0
                    deviation = statistics.pstdev(numbers) if len(numbers) > 1 else 0
                    status, result = "200 OK", {"events": values, "statistics": {"count": len(numbers), "min": min(numbers) if numbers else None, "max": max(numbers) if numbers else None, "mean": mean if numbers else None, "standardDeviation": deviation, "outliers": sum(abs(value - mean) > 3 * deviation for value in numbers) if deviation else 0}}
                except (KeyError, IndexError, ValueError) as exc: status, result = "400 Bad Request", {"error": str(exc)}
            elif method == "GET" and path == "/api/v1/notes":
                asset_id = parse_qs(parsed_target.query).get("assetId", [""])[0]
                status, result = ("200 OK", {"notes": STORE.notes(asset_id)}) if asset_id else ("400 Bad Request", {"error": "assetId is required"})
            elif method == "GET" and path == "/api/v1/notifications":
                project_id = parse_qs(parsed_target.query).get("projectId", [""])[0]
                status, result = ("200 OK", {"notifications": STORE.notifications(project_id)}) if project_id else ("400 Bad Request", {"error": "projectId is required"})
            elif method == "POST" and path == "/api/v1/notes":
                try:
                    note = json.loads(body)
                    if not all(note.get(key) for key in ("id", "assetId", "nodeId", "text", "createdAt")): raise ValueError("note requires id, assetId, nodeId, text and createdAt")
                    STORE.save_note(note); status, result = "201 Created", {"note": note}
                except (ValueError, TypeError, json.JSONDecodeError) as exc: status, result = "400 Bad Request", {"error": str(exc)}
            elif method == "POST" and path == "/api/v1/notifications":
                try:
                    notification = json.loads(body)
                    project_id = notification.pop("projectId")
                    if not all(notification.get(key) for key in ("id", "ruleId", "signalId", "severity", "state", "raisedAt")): raise ValueError("invalid notification event")
                    STORE.save_notification(project_id, notification); status, result = "200 OK", {"ok": True}
                except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc: status, result = "400 Bad Request", {"error": str(exc)}
            elif method == "POST" and path == "/api/v1/health/estimate":
                try: status, result = "200 OK", estimate_health(json.loads(body))
                except (ValueError, TypeError, json.JSONDecodeError) as exc: status, result = "400 Bad Request", {"error": str(exc)}
            elif method == "OPTIONS":
                status, result = "204 No Content", {}
            else:
                status, result = "404 Not Found", {"error": "unknown endpoint"}
            encoded = json.dumps(result).encode()
            writer.write(f"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: {config.get('cors_origin', 'http://localhost:5173')}\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\nContent-Length: {len(encoded)}\r\nConnection: close\r\n\r\n".encode() + encoded)
            await writer.drain()
        except Exception as exc: log.warning("Health API request error: %s", exc)
        finally: writer.close(); await writer.wait_closed()
    server = await asyncio.start_server(handle, config.get("host", "127.0.0.1"), int(config.get("port", 8080)))
    log.info("Health API listening on %s", server.sockets[0].getsockname())
    async with server: await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
