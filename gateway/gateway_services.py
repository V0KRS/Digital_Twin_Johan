"""Edge persistence, historian adapters, alarm evaluation, and command validation."""
import json
import math
import os
import sqlite3
import time
import uuid
import base64
import hashlib
import hmac
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("telemetry timestamp must include a UTC offset")
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


class EdgeStore:
    """SQLite is the durable edge queue and local historian; safe to use offline."""
    def __init__(self, filename):
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(filename, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS telemetry(id INTEGER PRIMARY KEY, tag TEXT, value_json TEXT, raw_payload TEXT, timestamp TEXT, quality TEXT, synced INTEGER DEFAULT 0);
          CREATE INDEX IF NOT EXISTS telemetry_time ON telemetry(timestamp);
          CREATE TABLE IF NOT EXISTS command_audit(id TEXT PRIMARY KEY, user_id TEXT, action TEXT, asset_id TEXT, topic TEXT, timestamp TEXT, status TEXT, receipt TEXT);
          CREATE TABLE IF NOT EXISTS maintenance_notes(id TEXT PRIMARY KEY, asset_id TEXT, payload TEXT, created_at TEXT);
          CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, project_id TEXT, payload TEXT, updated_at TEXT);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(telemetry)")}
        if "raw_payload" not in columns:
            self.db.execute("ALTER TABLE telemetry ADD COLUMN raw_payload TEXT")
        self.db.commit()

    def record(self, event):
        self.db.execute("INSERT INTO telemetry(tag,value_json,raw_payload,timestamp,quality) VALUES(?,?,?,?,?)",
          (event["tag"], json.dumps(event["value"]), event.get("rawPayload", json.dumps(event)), event["timestamp"], event.get("quality", "good")))
        self.db.commit()

    def range(self, start, end, tags=None):
        sql = "SELECT tag,value_json,timestamp,quality FROM telemetry WHERE timestamp>=? AND timestamp<=?"
        args = [start, end]
        if tags:
            sql += " AND tag IN (" + ",".join("?" for _ in tags) + ")"
            args.extend(tags)
        sql += " ORDER BY timestamp"
        return [{"tag": r[0], "value": json.loads(r[1]), "timestamp": r[2], "quality": r[3]} for r in self.db.execute(sql, args)]

    def pending(self, limit=500):
        return self.db.execute("SELECT id,tag,value_json,timestamp,quality FROM telemetry WHERE synced=0 ORDER BY id LIMIT ?", (limit,)).fetchall()

    def mark_synced(self, ids):
        if ids:
            self.db.executemany("UPDATE telemetry SET synced=1 WHERE id=?", [(i,) for i in ids]); self.db.commit()

    def audit(self, command, status, receipt=""):
        self.db.execute("INSERT INTO command_audit VALUES(?,?,?,?,?,?,?,?)", (command["id"], command["userId"], command["action"], command["assetId"], command["topic"], command["timestamp"], status, receipt)); self.db.commit()

    def confirm_command(self, command_id, status, receipt):
        self.db.execute("UPDATE command_audit SET status=?,receipt=? WHERE id=?", (status, receipt, command_id)); self.db.commit()

    def notes(self, asset_id):
        return [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM maintenance_notes WHERE asset_id=? ORDER BY created_at", (asset_id,))]

    def save_note(self, note):
        self.db.execute("INSERT OR REPLACE INTO maintenance_notes(id,asset_id,payload,created_at) VALUES(?,?,?,?)", (note["id"], note["assetId"], json.dumps(note), note["createdAt"])); self.db.commit()

    def notifications(self, project_id):
        return [json.loads(row[0]) for row in self.db.execute("SELECT payload FROM notifications WHERE project_id=? ORDER BY updated_at DESC LIMIT 200", (project_id,))]

    def save_notification(self, project_id, event):
        self.db.execute("INSERT OR REPLACE INTO notifications(id,project_id,payload,updated_at) VALUES(?,?,?,?)", (event["id"], project_id, json.dumps(event), event.get("clearedAt", event["raisedAt"]))); self.db.commit()


async def influx_write(config, rows):
    """Batch line protocol into InfluxDB v2. Empty URL disables the cloud sink."""
    if not config.get("url") or not rows:
        return False
    import urllib.request
    from urllib.parse import urlencode
    lines = []
    for _id, tag, raw, timestamp, quality in rows:
        value = json.loads(raw)
        if isinstance(value, bool): field = f"value={str(value).lower()}"
        elif isinstance(value, (int, float)) and math.isfinite(value): field = f"value={value}"
        else: field = "value_json=" + json.dumps(json.dumps(value))
        safe_tag = tag.replace("\\", "\\\\").replace(" ", "\\ ").replace(",", "\\,")
        ts = int(datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp() * 1_000_000_000)
        lines.append(f'telemetry,tag={safe_tag},quality={quality} {field} {ts}')
    query = urlencode({"org": config["org"], "bucket": config["bucket"], "precision": "ns"})
    req = urllib.request.Request(config["url"].rstrip("/") + "/api/v2/write?" + query, data="\n".join(lines).encode(), method="POST", headers={"Authorization": "Token " + config["token"], "Content-Type": "text/plain"})
    await __import__("asyncio").to_thread(lambda: urllib.request.urlopen(req, timeout=5).read())
    return True


def validate_command(command, config):
    """Verify HS256 bearer JWT and require an operator role before write-back."""
    if not isinstance(command, dict) or not all(command.get(k) for k in ("assetId", "action", "topic", "token")):
        raise ValueError("command requires assetId, action, topic and signed operator token")
    secret = config.get("jwt_secret", "")
    if not secret:
        raise ValueError("command dispatch is disabled until GATEWAY_JWT_SECRET is configured")
    parts = command.pop("token").split(".")
    if len(parts) != 3:
        raise ValueError("invalid operator token")
    signing_input = f"{parts[0]}.{parts[1]}".encode()
    expected = base64.urlsafe_b64encode(hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()).decode().rstrip("=")
    if not hmac.compare_digest(expected, parts[2]):
        raise ValueError("invalid operator token signature")
    header = json.loads(base64.urlsafe_b64decode(parts[0] + "=" * (-len(parts[0]) % 4)))
    if header.get("alg") != "HS256":
        raise ValueError("only HS256 operator tokens are accepted")
    claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    now = time.time()
    if claims.get("exp", 0) <= now or claims.get("nbf", 0) > now or claims.get("iss") != config.get("issuer", "water-twin"):
        raise ValueError("expired or untrusted operator token")
    roles = claims.get("roles", [])
    if "operator" not in roles and "admin" not in roles:
        raise ValueError("operator role required")
    if claims.get("actions") and command["action"] not in claims["actions"] and "admin" not in roles:
        raise ValueError("operator is not authorized for this action")
    command["userId"] = claims.get("sub")
    if not command["userId"]:
        raise ValueError("operator token has no subject")
    allowed_assets = claims.get("assets", ["*"])
    if "*" not in allowed_assets and command["assetId"] not in allowed_assets:
        raise ValueError("operator is not authorized for this asset")
    if "admin" not in roles:
        topic_grants = claims.get("assetTopics", {})
        prefixes = topic_grants.get(command["assetId"], [])
        if not prefixes or not any(command["topic"].startswith(prefix) for prefix in prefixes):
            raise ValueError("operator token has no command topic grant for this asset")
    allowed = config.get("allowed_topics", [])
    if any(token in command["topic"] for token in ("+", "#")):
        raise ValueError("wildcards are not valid command topic names")
    if not allowed or not any(command["topic"].startswith(prefix) for prefix in allowed):
        raise ValueError("command topic is not allow-listed")
    if command["action"] not in config.get("allowed_actions", ["shutdown", "start", "setpoint"]):
        raise ValueError("command action is not allow-listed")
    command["id"] = str(uuid.uuid4()); command["timestamp"] = utc_now()
    return command


def estimate_health(features):
    temperature = float(features.get("temperature", 25))
    vibration = float(features.get("vibration", 0))
    pressure = float(features.get("pressure", 0))
    if not all(math.isfinite(value) for value in (temperature, vibration, pressure)):
        raise ValueError("health features must be finite numbers")
    score = max(0, min(100, round(100 - max(0, temperature - 60) * 2.5 - max(0, vibration - 1) * 12 - max(0, pressure - 20) * 1.5)))
    severity = max(0.01, (100 - score) / 100)
    return {"score": score, "remainingHours": round(500 * (1 - severity) / severity), "anomalyScore": round(1 - score / 100, 3), "model": "heuristic-v1", "updatedAt": utc_now(), "confidence": 0.35}

