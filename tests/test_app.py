import os
import uuid
from datetime import date

os.environ["DATABASE_URL"] = "sqlite:///./test_campusflow.db"
os.environ["SECRET_KEY"] = "test-secret"

from fastapi.testclient import TestClient

from app.api.routes import study as study_routes
from app.db.session import normalize_database_url
from app.main import app
from app.services.schedule_import import parse_schedule_lines

client = TestClient(app)


def test_provider_postgres_urls_use_psycopg3():
    assert normalize_database_url("postgres://user:pass@host:5432/db") == (
        "postgresql+psycopg://user:pass@host:5432/db"
    )
    assert normalize_database_url("postgresql://user:pass@host:5432/db") == (
        "postgresql+psycopg://user:pass@host:5432/db"
    )


def register_and_login():
    email = f"student-{uuid.uuid4().hex[:8]}@example.com"
    client.post(
        "/api/auth/register",
        json={"email": email, "full_name": "Test Student", "password": "strongpass123"},
    )
    response = client.post(
        "/api/auth/login",
        json={"email": email, "password": "strongpass123"},
    )
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def make_text_pdf(page_count: int, target_page: int) -> bytes:
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b""]
    page_refs = b" ".join(f"{4 + 2 * index} 0 R".encode() for index in range(page_count))
    objects[1] = (
        b"<< /Type /Pages /Kids ["
        + page_refs
        + b"] /Count "
        + str(page_count).encode()
        + b" >>"
    )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for page_number in range(1, page_count + 1):
        page_object = 4 + 2 * (page_number - 1)
        content_object = page_object + 1
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {content_object} 0 R >>".encode()
        )
        page_text = f"Page {page_number}: material about biology and university study."
        if page_number == target_page:
            page_text += " Photosynthesis explains chlorophyll energy conversion in plants."
        stream = f"BT /F1 12 Tf 72 720 Td ({page_text}) Tj ET".encode()
        objects.append(
            b"<< /Length "
            + str(len(stream)).encode()
            + b" >>\nstream\n"
            + stream
            + b"\nendstream"
        )

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for object_number, obj in enumerate(objects, start=1):
        offsets.append(len(pdf))
        pdf.extend(f"{object_number} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF".encode()
    )
    return bytes(pdf)


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_register_login_and_course_flow():
    headers = register_and_login()
    course = client.post(
        "/api/courses",
        headers=headers,
        json={
            "code": "YBS101",
            "name": "Management Information Systems",
            "credits": 5,
            "target_grade": 75,
        },
    )
    assert course.status_code == 201
    course_id = course.json()["id"]

    grade = client.post(
        f"/api/courses/{course_id}/grades",
        headers=headers,
        json={"name": "Midterm", "score": 80, "weight": 40},
    )
    assert grade.status_code == 201

    task = client.post(
        "/api/tasks",
        headers=headers,
        json={"title": "Build portfolio project", "course_id": course_id, "priority": 5},
    )
    assert task.status_code == 201

    dashboard = client.get("/api/dashboard", headers=headers)
    assert dashboard.status_code == 200
    assert dashboard.json()["total_courses"] == 1
    assert dashboard.json()["total_tasks"] == 1
    assert dashboard.json()["average_grade"] == 80.0


def test_course_note_is_saved_and_shown_in_schedule_only_to_its_owner():
    headers = register_and_login()
    course = client.post(
        "/api/courses",
        headers=headers,
        json={"code": "YBS101", "name": "Yönetim Bilişim Sistemleri", "credits": 3},
    ).json()
    saved = client.put(
        f"/api/courses/{course['id']}/note",
        headers=headers,
        json={"course_note": "Veri tabanı normalizasyonunu tekrar et."},
    )
    assert saved.status_code == 200
    assert saved.json()["course_note"] == "Veri tabanı normalizasyonunu tekrar et."

    updated = client.put(
        "/api/schedule",
        headers=headers,
        json={
            "courses": [
                {
                    "code": "YBS101",
                    "name": "Yönetim Bilişim Sistemleri",
                    "meetings": [
                        {
                            "weekday": 0,
                            "start_time": "09:00",
                            "end_time": "10:50",
                            "room": "A-204",
                        }
                    ],
                }
            ]
        },
    )
    assert updated.status_code == 200
    schedule = client.get("/api/schedule", headers=headers)
    assert schedule.json()[0]["room"] == "A-204"
    assert schedule.json()[0]["course_note"] == "Veri tabanı normalizasyonunu tekrar et."

    other_user_headers = register_and_login()
    assert client.put(
        f"/api/courses/{course['id']}/note",
        headers=other_user_headers,
        json={"course_note": "Başka kullanıcı notu"},
    ).status_code == 404


def test_schedule_parser_distinguishes_course_code_and_classroom_per_meeting():
    courses, _ = parse_schedule_lines(
        [
            "YBS-101 Yönetim Bilişim Sistemleri",
            "Pazartesi 09:00 - 10:50 Derslik: A-204",
            "Salı 11:00 - 12:50 Derslik: B-105",
        ]
    )
    assert len(courses) == 1
    course = courses[0]
    assert course["code"] == "YBS-101"
    assert "YBS-101" not in course["name"]
    assert [(meeting["weekday"], meeting["room"]) for meeting in course["meetings"]] == [
        (0, "A-204"),
        (1, "B-105"),
    ]

    inline_courses, _ = parse_schedule_lines(
        ["YBS-101 Yönetim Bilişim Sistemleri Pazartesi 09:00 - 10:50 Derslik: C-306"]
    )
    assert len(inline_courses) == 1
    assert inline_courses[0]["meetings"][0]["room"] == "C-306"


def test_private_endpoint_requires_auth():
    assert client.get("/api/courses").status_code == 401


def test_focus_goal_sessions_and_attendance_are_private_and_persistent():
    headers = register_and_login()
    course = client.post(
        "/api/courses",
        headers=headers,
        json={"code": "YBS777", "name": "Study Skills", "credits": 3},
    ).json()
    today = date.today().isoformat()

    initial = client.get("/api/routine/overview", headers=headers)
    assert initial.status_code == 200
    assert initial.json()["weekly_goal_minutes"] == 300
    assert initial.json()["week_minutes"] == 0

    goal = client.put(
        "/api/routine/goal", headers=headers, json={"weekly_goal_minutes": 480}
    )
    assert goal.status_code == 200
    assert goal.json()["weekly_goal_minutes"] == 480
    assert client.put(
        "/api/routine/goal", headers=headers, json={"weekly_goal_minutes": 20}
    ).status_code == 422

    session = client.post(
        "/api/routine/sessions",
        headers=headers,
        json={"duration_minutes": 35, "course_id": course["id"], "note": "Tekrar"},
    )
    assert session.status_code == 201
    overview = client.get("/api/routine/overview", headers=headers).json()
    assert overview["week_minutes"] == 35
    assert overview["today_minutes"] == 35
    assert overview["sessions"][0]["course_name"] == "Study Skills"

    attendance = client.post(
        "/api/routine/attendance",
        headers=headers,
        json={
            "course_id": course["id"],
            "session_date": today,
            "status": "absent",
            "allowed_absences": 1,
            "note": "Hastalık",
        },
    )
    assert attendance.status_code == 201
    record_id = attendance.json()["id"]
    warning = client.get("/api/routine/overview", headers=headers).json()
    assert warning["attendance_by_course"][0]["risk"] is True
    update = client.post(
        "/api/routine/attendance",
        headers=headers,
        json={
            "course_id": course["id"],
            "session_date": today,
            "status": "attended",
            "allowed_absences": 2,
        },
    )
    assert update.status_code == 201
    assert update.json()["id"] == record_id
    summary = client.get("/api/routine/overview", headers=headers).json()
    course_attendance = summary["attendance_by_course"][0]
    assert course_attendance["attended"] == 1
    assert course_attendance["absent"] == 0
    assert course_attendance["allowed_absences"] == 2
    assert len(summary["attendance_records"]) == 1

    other_user_headers = register_and_login()
    assert client.get("/api/routine/overview", headers=other_user_headers).json()["week_minutes"] == 0
    assert client.delete(
        f"/api/routine/attendance/{record_id}", headers=other_user_headers
    ).status_code == 404
    assert client.delete(f"/api/routine/attendance/{record_id}", headers=headers).status_code == 204
    assert client.post(
        "/api/routine/sessions",
        headers=headers,
        json={"duration_minutes": 20, "course_id": course["id"] + 99999},
    ).status_code == 404


def test_messages_are_persisted_delivered_and_marked_read():
    sender_headers = register_and_login()
    sender = client.get("/api/auth/me", headers=sender_headers).json()
    recipient_email = f"recipient-{uuid.uuid4().hex[:8]}@example.com"
    client.post(
        "/api/auth/register",
        json={
            "email": recipient_email,
            "full_name": "Recipient Student",
            "password": "strongpass123",
        },
    )
    recipient_headers = {
        "Authorization": "Bearer "
        + client.post(
            "/api/auth/login",
            json={"email": recipient_email, "password": "strongpass123"},
        ).json()["access_token"]
    }

    sent = client.post(
        "/api/messages",
        headers=sender_headers,
        data={"recipient_email": recipient_email, "body": "Proje dosyası hazır."},
    )
    assert sent.status_code == 201
    assert sent.json()["read_at"] is None

    inbox = client.get("/api/messages/contacts", headers=recipient_headers)
    assert inbox.status_code == 200
    assert inbox.json()[0]["unread_count"] == 1

    conversation = client.get(
        "/api/messages/conversation",
        headers=recipient_headers,
        params={"email": sender["email"]},
    )
    assert conversation.status_code == 200
    assert conversation.json()[0]["body"] == "Proje dosyası hazır."
    assert conversation.json()[0]["read_at"] is not None

    sender_view = client.get(
        "/api/messages/conversation",
        headers=sender_headers,
        params={"email": recipient_email},
    )
    assert sender_view.json()[0]["read_at"] is not None


def test_pwa_shell_routes():
    assert client.get("/sw.js").headers["service-worker-allowed"] == "/"
    assert client.get("/static/manifest.webmanifest").status_code == 200
    assert client.get("/download").status_code == 200
    download_status = client.get("/api/downloads/windows")
    assert download_status.status_code == 200
    assert isinstance(download_status.json()["available"], bool)


def test_assistant_finds_and_opens_matching_pdf_page(monkeypatch):
    headers = register_and_login()
    pdf = make_text_pdf(page_count=100, target_page=55)
    uploaded = client.post(
        "/api/study/documents",
        headers=headers,
        data={"title": "Biology handout"},
        files={"file": ("biology.pdf", pdf, "application/pdf")},
    )
    assert uploaded.status_code == 201
    document_id = uploaded.json()["id"]

    page_info = client.get(f"/api/study/documents/{document_id}/pages", headers=headers)
    assert page_info.status_code == 200
    assert page_info.json()["page_count"] == 100
    page = client.get(f"/api/study/documents/{document_id}/pages/55", headers=headers)
    assert page.status_code == 200
    assert page.headers["content-type"] == "image/png"
    assert page.content.startswith(b"\x89PNG")

    captured = {}
    monkeypatch.setattr(
        study_routes,
        "connection_status",
        lambda *args: {"available": True, "model_ready": True, "message": "ready"},
    )

    def generate_text(**kwargs):
        captured["prompt"] = kwargs["user_prompt"]
        return "Photosynthesis converts light energy. [PDF 1]"

    monkeypatch.setattr(study_routes, "generate_text", generate_text)
    answer = client.post(
        "/api/study/assistant/ask",
        headers=headers,
        json={"question": "Explain photosynthesis chlorophyll"},
    )
    assert answer.status_code == 200
    assert answer.json()["sources"][0]["document_id"] == document_id
    assert answer.json()["sources"][0]["page_number"] == 55
    assert "[PDF 1 | Biology handout | sayfa 55]" in captured["prompt"]


def create_account(email: str):
    registered = client.post(
        "/api/auth/register",
        json={"email": email, "full_name": "Realtime Test", "password": "strongpass123"},
    )
    assert registered.status_code == 201
    login = client.post("/api/auth/login", json={"email": email, "password": "strongpass123"})
    assert login.status_code == 200
    token = login.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}, token


def test_voice_message_is_playable_only_by_conversation_participants():
    sender_email = f"voice-sender-{uuid.uuid4().hex[:8]}@example.com"
    recipient_email = f"voice-recipient-{uuid.uuid4().hex[:8]}@example.com"
    outsider_email = f"voice-outsider-{uuid.uuid4().hex[:8]}@example.com"
    sender_headers, _ = create_account(sender_email)
    recipient_headers, _ = create_account(recipient_email)
    outsider_headers, _ = create_account(outsider_email)

    sent = client.post(
        "/api/messages",
        headers=sender_headers,
        data={"recipient_email": recipient_email, "body": ""},
        files={"file": ("sesli-mesaj.webm", b"\x1aE\xdf\xa3audio-payload", "audio/webm")},
    )
    assert sent.status_code == 201
    message_id = sent.json()["id"]

    sender_audio = client.get(f"/api/messages/{message_id}/audio", headers=sender_headers)
    recipient_audio = client.get(f"/api/messages/{message_id}/audio", headers=recipient_headers)
    assert sender_audio.status_code == recipient_audio.status_code == 200
    assert sender_audio.headers["content-type"] == "audio/webm"
    assert sender_audio.content.startswith(b"\x1aE\xdf\xa3")
    assert client.get(f"/api/messages/{message_id}/audio", headers=outsider_headers).status_code == 404

    invalid = client.post(
        "/api/messages",
        headers=sender_headers,
        data={"recipient_email": recipient_email, "body": ""},
        files={"file": ("bad.webm", b"not a webm", "audio/webm")},
    )
    assert invalid.status_code == 400


def test_admin_presence_is_restricted_to_configured_email(monkeypatch):
    from types import SimpleNamespace

    from app.api import deps
    from app.core import config

    admin_email = f"presence-admin-{uuid.uuid4().hex[:8]}@example.com"
    settings = SimpleNamespace(
        admin_email=admin_email,
        webrtc_turn_urls="",
        webrtc_turn_username="",
        webrtc_turn_credential="",
    )
    monkeypatch.setattr(deps, "get_settings", lambda: settings)
    monkeypatch.setattr(config, "get_settings", lambda: settings)
    admin_headers, _ = create_account(admin_email)
    student_headers, student_token = create_account(f"presence-student-{uuid.uuid4().hex[:8]}@example.com")

    assert client.get("/api/admin/status", headers=admin_headers).json() == {"is_admin": True}
    assert client.get("/api/admin/status", headers=student_headers).json() == {"is_admin": False}
    assert client.get("/api/admin/active-users", headers=student_headers).status_code == 403

    with client.websocket_connect("/api/realtime") as websocket:
        websocket.send_json({"type": "auth", "token": student_token, "page": "messagesPage"})
        assert websocket.receive_json()["type"] == "ready"
        presence = client.get("/api/admin/active-users", headers=admin_headers)
        assert presence.status_code == 200
        assert presence.json()["online_count"] == 1
        assert presence.json()["users"][0]["email"].startswith("presence-student-")
        assert presence.json()["users"][0]["page"] == "messagesPage"


def test_authenticated_websocket_call_signaling_reaches_only_call_participants():
    caller_headers, caller_token = create_account(f"call-caller-{uuid.uuid4().hex[:8]}@example.com")
    callee_headers, callee_token = create_account(f"call-callee-{uuid.uuid4().hex[:8]}@example.com")
    caller_id = client.get("/api/auth/me", headers=caller_headers).json()["id"]
    callee_id = client.get("/api/auth/me", headers=callee_headers).json()["id"]

    with client.websocket_connect("/api/realtime") as caller, client.websocket_connect("/api/realtime") as callee:
        caller.send_json({"type": "auth", "token": caller_token, "page": "messagesPage"})
        callee.send_json({"type": "auth", "token": callee_token, "page": "messagesPage"})
        assert caller.receive_json()["type"] == "ready"
        assert callee.receive_json()["type"] == "ready"

        caller.send_json({"type": "call_start", "to_user_id": callee_id, "media": "audio"})
        incoming = callee.receive_json()
        ringing = caller.receive_json()
        assert incoming["type"] == "call_incoming"
        assert incoming["caller"]["user_id"] == caller_id
        assert ringing["type"] == "call_ringing"
        call_id = incoming["call_id"]

        callee.send_json({"type": "call_accept", "call_id": call_id})
        assert caller.receive_json()["type"] == "call_accepted"
        assert callee.receive_json()["type"] == "call_accepted"

        caller.send_json({"type": "rtc_offer", "call_id": call_id, "payload": {"sdp": "offer"}})
        relayed = callee.receive_json()
        assert relayed["type"] == "rtc_offer"
        assert relayed["payload"]["sdp"] == "offer"

        callee.send_json({"type": "call_end", "call_id": call_id})
        assert caller.receive_json()["type"] == "call_ended"
        assert callee.receive_json()["type"] == "call_ended"
