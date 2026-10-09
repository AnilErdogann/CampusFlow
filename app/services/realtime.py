import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

from fastapi import WebSocket


@dataclass
class Client:
    websocket: WebSocket
    user_id: int
    name: str
    email: str
    page: str = "homePage"
    last_seen: datetime | None = None


class RealtimeManager:
    """In-memory presence and WebRTC signaling for a single app process."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._clients: dict[int, dict[WebSocket, Client]] = {}
        self._calls: dict[str, dict[str, Any]] = {}
        self._user_calls: dict[int, str] = {}

    async def register(self, websocket: WebSocket, user_id: int, name: str, email: str) -> None:
        async with self._lock:
            client = Client(websocket, user_id, name, email, last_seen=datetime.now(UTC))
            self._clients.setdefault(user_id, {})[websocket] = client

    async def touch(self, websocket: WebSocket, page: str | None = None) -> None:
        async with self._lock:
            for sessions in self._clients.values():
                client = sessions.get(websocket)
                if client:
                    if page in {"homePage", "routinePage", "studyPage", "notesPage", "messagesPage", "aiSettingsPage", "adminPage"}:
                        client.page = page
                    client.last_seen = datetime.now(UTC)
                    return

    async def unregister(self, websocket: WebSocket) -> tuple[int | None, dict[str, Any] | None]:
        ended_call = None
        disconnected_user = None
        async with self._lock:
            for user_id, sessions in list(self._clients.items()):
                if websocket in sessions:
                    del sessions[websocket]
                    disconnected_user = user_id if not sessions else None
                    if not sessions:
                        del self._clients[user_id]
                    break
            for call_id, call in list(self._calls.items()):
                participant_disconnected = disconnected_user in {call["caller_id"], call["callee_id"]}
                call_socket_disconnected = websocket in {call.get("caller_socket"), call.get("callee_socket")}
                if participant_disconnected or call_socket_disconnected:
                    ended_call = self._calls.pop(call_id)
                    self._user_calls.pop(call["caller_id"], None)
                    self._user_calls.pop(call["callee_id"], None)
                    break
        if ended_call:
            other_id = ended_call["callee_id"] if ended_call["caller_id"] == disconnected_user else ended_call["caller_id"]
            await self.send_user(other_id, {"type": "call_ended", "call_id": ended_call["id"], "reason": "connection_lost"})
        return disconnected_user, ended_call

    async def send_user(self, user_id: int, payload: dict[str, Any]) -> bool:
        async with self._lock:
            sockets = list(self._clients.get(user_id, {}).keys())
        if not sockets:
            return False
        results = await asyncio.gather(*(self._safe_send(socket, payload) for socket in sockets))
        return any(results)

    @staticmethod
    async def _safe_send(websocket: WebSocket, payload: dict[str, Any]) -> bool:
        try:
            await websocket.send_json(payload)
            return True
        except Exception:
            return False

    async def online_user(self, user_id: int) -> bool:
        async with self._lock:
            return bool(self._clients.get(user_id))

    async def snapshot(self) -> list[dict[str, Any]]:
        async with self._lock:
            rows = []
            for user_id, sessions in self._clients.items():
                latest = max(sessions.values(), key=lambda client: client.last_seen or datetime.min.replace(tzinfo=UTC))
                if not latest.last_seen or latest.last_seen < datetime.now(UTC) - timedelta(seconds=60):
                    continue
                rows.append({
                    "user_id": user_id,
                    "full_name": latest.name,
                    "email": latest.email,
                    "page": latest.page,
                    "last_seen": latest.last_seen.isoformat() if latest.last_seen else None,
                    "session_count": len(sessions),
                })
        return sorted(rows, key=lambda row: row["full_name"].casefold())

    async def send_socket(self, websocket: WebSocket, payload: dict[str, Any]) -> bool:
        return await self._safe_send(websocket, payload)

    async def start_call(self, websocket: WebSocket, caller_id: int, caller_name: str, target_id: int, media: str) -> tuple[dict[str, Any] | None, str | None]:
        if media not in {"audio", "video"}:
            return None, "Geçersiz arama türü."
        async with self._lock:
            target_sessions = self._clients.get(target_id, {})
            caller_sessions = self._clients.get(caller_id, {})
            if not target_sessions:
                return None, "Kullanıcı şu anda çevrimiçi değil."
            if caller_id == target_id:
                return None, "Kendini arayamazsın."
            if caller_id in self._user_calls or target_id in self._user_calls:
                return None, "Kullanıcılardan biri başka bir aramada."
            call_id = uuid4().hex
            caller = caller_sessions.get(websocket)
            if caller is None:
                return None, "Canlı bağlantı yenilenmeli."
            call = {"id": call_id, "caller_id": caller_id, "callee_id": target_id, "media": media, "status": "ringing", "caller_socket": websocket}
            self._calls[call_id] = call
            self._user_calls[caller_id] = call_id
            self._user_calls[target_id] = call_id
            caller_info = {"user_id": caller_id, "full_name": caller_name, "email": caller.email}
            callee_info = {"user_id": target_id}
        await self.send_socket(websocket, {"type": "call_ringing", "call_id": call_id, "media": media, "callee": callee_info})
        await self.send_user(target_id, {"type": "call_incoming", "call_id": call_id, "media": media, "caller": caller_info})
        return call, None

    async def accept_call(self, websocket: WebSocket, user_id: int, call_id: str) -> tuple[dict[str, Any] | None, str | None]:
        async with self._lock:
            call = self._calls.get(call_id)
            if not call or call["callee_id"] != user_id or call["status"] != "ringing":
                return None, "Bu arama artık geçerli değil."
            call["status"] = "active"
            call["callee_socket"] = websocket
            result = dict(call)
        await self.send_socket(result["caller_socket"], {"type": "call_accepted", "call_id": call_id, "media": result["media"]})
        await self.send_user(user_id, {"type": "call_accepted", "call_id": call_id, "media": result["media"]})
        return result, None

    async def finish_call(self, user_id: int, call_id: str, action: str) -> tuple[dict[str, Any] | None, str | None]:
        async with self._lock:
            call = self._calls.get(call_id)
            if not call or user_id not in {call["caller_id"], call["callee_id"]}:
                return None, "Arama bulunamadı."
            if action == "call_reject" and call["callee_id"] != user_id:
                return None, "Aramayı yalnızca aranan kişi reddedebilir."
            self._calls.pop(call_id, None)
            self._user_calls.pop(call["caller_id"], None)
            self._user_calls.pop(call["callee_id"], None)
            result = dict(call)
        other_id = result["callee_id"] if user_id == result["caller_id"] else result["caller_id"]
        event = "call_rejected" if action == "call_reject" else "call_ended"
        if user_id == result["caller_id"]:
            other_socket = result.get("callee_socket")
            if other_socket:
                await self.send_socket(other_socket, {"type": event, "call_id": call_id, "reason": "declined" if action == "call_reject" else "ended"})
            else:
                await self.send_user(other_id, {"type": event, "call_id": call_id, "reason": "declined" if action == "call_reject" else "ended"})
        else:
            await self.send_socket(result["caller_socket"], {"type": event, "call_id": call_id, "reason": "declined" if action == "call_reject" else "ended"})
        await self.send_user(user_id, {"type": "call_ended", "call_id": call_id, "reason": "declined" if action == "call_reject" else "ended"})
        return result, None

    async def relay(self, user_id: int, call_id: str, event_type: str, payload: Any) -> str | None:
        if event_type not in {"rtc_offer", "rtc_answer", "rtc_ice"}:
            return "Bilinmeyen arama sinyali."
        if not isinstance(payload, (dict, list, str)) or len(str(payload)) > 64000:
            return "Arama sinyali geçersiz."
        async with self._lock:
            call = self._calls.get(call_id)
            if not call or call["status"] != "active" or user_id not in {call["caller_id"], call["callee_id"]}:
                return "Bu arama için sinyal gönderilemiyor."
            other_id = call["callee_id"] if user_id == call["caller_id"] else call["caller_id"]
        await self.send_user(other_id, {"type": event_type, "call_id": call_id, "payload": payload})
        return None


realtime_manager = RealtimeManager()
