import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette import status

from app.core.config import get_settings
from app.core.security import decode_subject
from app.db.session import SessionLocal
from app.models import User
from app.services.realtime import realtime_manager

router = APIRouter()


def _ice_servers() -> list[dict[str, object]]:
    settings = get_settings()
    servers: list[dict[str, object]] = [{"urls": ["stun:stun.l.google.com:19302"]}]
    turn_urls = [url.strip() for url in settings.webrtc_turn_urls.split(",") if url.strip()]
    if turn_urls and settings.webrtc_turn_username and settings.webrtc_turn_credential:
        servers.append({
            "urls": turn_urls,
            "username": settings.webrtc_turn_username,
            "credential": settings.webrtc_turn_credential,
        })
    return servers


@router.websocket("/api/realtime")
async def realtime_socket(websocket: WebSocket):
    await websocket.accept()
    registered = False
    user: User | None = None
    try:
        first = await websocket.receive_json()
        if not isinstance(first, dict) or first.get("type") != "auth":
            await websocket.close(code=4401, reason="Authentication required")
            return
        subject = decode_subject(str(first.get("token", "")))
        if not subject or not subject.isdigit():
            await websocket.close(code=4401, reason="Invalid token")
            return
        with SessionLocal() as db:
            user = db.get(User, int(subject))
            if not user:
                await websocket.close(code=4401, reason="User not found")
                return
            user_id, full_name, email = user.id, user.full_name, user.email
        await realtime_manager.register(websocket, user_id, full_name, email)
        registered = True
        await realtime_manager.touch(websocket, first.get("page"))
        await websocket.send_json({"type": "ready", "user_id": user_id, "ice_servers": _ice_servers()})
        while True:
            event = await websocket.receive_json()
            if not isinstance(event, dict) or len(json.dumps(event, ensure_ascii=False)) > 96000:
                await websocket.close(code=1009, reason="Message too large")
                break
            event_type = event.get("type")
            if event_type == "heartbeat":
                await realtime_manager.touch(websocket, event.get("page"))
            elif event_type == "call_start":
                target_id = event.get("to_user_id")
                if isinstance(target_id, int) and user:
                    _, error = await realtime_manager.start_call(websocket, user_id, full_name, target_id, event.get("media"))
                    if error:
                        await websocket.send_json({"type": "call_error", "message": error})
                else:
                    await websocket.send_json({"type": "call_error", "message": "Aranacak kullanıcı seçilemedi."})
            elif event_type == "call_accept":
                _, error = await realtime_manager.accept_call(websocket, user_id, str(event.get("call_id", "")))
                if error:
                    await websocket.send_json({"type": "call_error", "message": error})
            elif event_type in {"call_reject", "call_end"}:
                _, error = await realtime_manager.finish_call(user_id, str(event.get("call_id", "")), event_type)
                if error:
                    await websocket.send_json({"type": "call_error", "message": error})
            elif event_type in {"rtc_offer", "rtc_answer", "rtc_ice"}:
                error = await realtime_manager.relay(user_id, str(event.get("call_id", "")), event_type, event.get("payload"))
                if error:
                    await websocket.send_json({"type": "call_error", "message": error})
            else:
                await websocket.send_json({"type": "error", "message": "Bilinmeyen canlı etkinlik."})
    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        except Exception:
            pass
    finally:
        if registered:
            await realtime_manager.unregister(websocket)
