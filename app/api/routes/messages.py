import mimetypes
import re
from datetime import UTC, datetime
from pathlib import PurePath
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import DirectMessage, User
from app.schemas.schemas import MessageContactOut, MessageOut

router = APIRouter()
MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
ALLOWED_EXTENSIONS = {
    ".pdf", ".png", ".jpg", ".jpeg", ".webp", ".txt", ".docx", ".pptx", ".xlsx",
    ".webm", ".m4a", ".mp3", ".ogg", ".wav", ".aac",
}
AUDIO_EXTENSIONS = {".webm", ".m4a", ".mp3", ".ogg", ".wav", ".aac"}
AUDIO_MIME_TYPES = {
    ".webm": "audio/webm", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg", ".wav": "audio/wav", ".aac": "audio/aac",
}


def _message_out(message: DirectMessage) -> MessageOut:
    return MessageOut(
        id=message.id,
        sender_id=message.sender_id,
        sender_name=message.sender.full_name,
        sender_email=message.sender.email,
        recipient_id=message.recipient_id,
        recipient_name=message.recipient.full_name,
        recipient_email=message.recipient.email,
        body=message.body,
        attachment_name=message.attachment_name,
        created_at=message.created_at,
        read_at=message.read_at,
    )


@router.get("/lookup")
def lookup_contact(email: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    normalized_email = email.strip().lower()
    if normalized_email == user.email.strip().lower():
        raise HTTPException(status_code=400, detail="Kendini arayamazsın.")
    partner = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
    if not partner:
        raise HTTPException(status_code=404, detail="Bu e-posta ile kayıtlı CampusFlow hesabı bulunamadı.")
    return {"user_id": partner.id, "full_name": partner.full_name, "email": partner.email}


@router.get("/contacts", response_model=list[MessageContactOut])
def list_contacts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.scalars(
        select(DirectMessage)
        .where(or_(DirectMessage.sender_id == user.id, DirectMessage.recipient_id == user.id))
        .order_by(DirectMessage.created_at.desc(), DirectMessage.id.desc())
        .limit(300)
    ).all()
    unread_rows = db.execute(
        select(DirectMessage.sender_id, func.count(DirectMessage.id))
        .where(DirectMessage.recipient_id == user.id, DirectMessage.read_at.is_(None))
        .group_by(DirectMessage.sender_id)
    ).all()
    unread_by_sender = {sender_id: count for sender_id, count in unread_rows}
    seen: set[int] = set()
    contacts = []
    for message in rows:
        partner_id = message.recipient_id if message.sender_id == user.id else message.sender_id
        if partner_id in seen:
            continue
        seen.add(partner_id)
        partner = message.recipient if message.recipient_id == partner_id else message.sender
        contacts.append(
            MessageContactOut(
                user_id=partner.id,
                full_name=partner.full_name,
                email=partner.email,
                last_message=message.body
                or (
                    f"Dosya: {message.attachment_name}" if message.attachment_name else "Dosya eki"
                ),
                created_at=message.created_at,
                unread_count=unread_by_sender.get(partner.id, 0),
            )
        )
    return contacts


@router.get("/conversation", response_model=list[MessageOut])
def get_conversation(
    email: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    normalized_email = email.strip().lower()
    if normalized_email == user.email.lower():
        raise HTTPException(status_code=400, detail="Kendine mesaj gönderemezsin.")
    partner = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
    if not partner:
        raise HTTPException(
            status_code=404, detail="Bu e-posta ile kayıtlı bir CampusFlow hesabı bulunamadı."
        )
    db.execute(
        update(DirectMessage)
        .where(
            DirectMessage.sender_id == partner.id,
            DirectMessage.recipient_id == user.id,
            DirectMessage.read_at.is_(None),
        )
        .values(read_at=datetime.now(UTC).replace(tzinfo=None))
    )
    db.commit()
    rows = db.scalars(
        select(DirectMessage)
        .where(
            or_(
                (DirectMessage.sender_id == user.id) & (DirectMessage.recipient_id == partner.id),
                (DirectMessage.sender_id == partner.id) & (DirectMessage.recipient_id == user.id),
            )
        )
        .order_by(DirectMessage.created_at, DirectMessage.id)
        .limit(500)
    ).all()
    return [_message_out(row) for row in rows]


@router.post("", response_model=MessageOut, status_code=status.HTTP_201_CREATED)
async def send_message(
    recipient_email: str = Form(..., max_length=255),
    body: str = Form(default="", max_length=4000),
    file: UploadFile | None = File(default=None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    normalized_email = recipient_email.strip().lower()
    if normalized_email == user.email.lower():
        raise HTTPException(status_code=400, detail="Kendine mesaj gönderemezsin.")
    recipient = db.scalar(select(User).where(func.lower(User.email) == normalized_email))
    if not recipient:
        raise HTTPException(
            status_code=404, detail="Bu e-posta ile kayıtlı bir CampusFlow hesabı bulunamadı."
        )

    clean_body = body.strip()
    attachment_data = None
    attachment_name = None
    attachment_mime = None
    if file and file.filename:
        attachment_name = PurePath(file.filename.replace("\\", "/")).name
        extension = PurePath(attachment_name).suffix.lower()
        if extension not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=400, detail="PDF, görsel, ses, metin veya Office belgesi ekleyebilirsin."
            )
        attachment_data = await file.read(MAX_ATTACHMENT_BYTES + 1)
        if len(attachment_data) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(status_code=413, detail="Dosya eki 12 MB sınırını aşıyor.")
        if extension == ".pdf" and not attachment_data.startswith(b"%PDF"):
            raise HTTPException(status_code=400, detail="PDF eki geçerli görünmüyor.")
        if extension in {".jpg", ".jpeg"} and not attachment_data.startswith(b"\xff\xd8\xff"):
            raise HTTPException(status_code=400, detail="JPG eki geçerli görünmüyor.")
        if extension == ".png" and not attachment_data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise HTTPException(status_code=400, detail="PNG eki geçerli görünmüyor.")
        if extension == ".webp" and not (
            attachment_data.startswith(b"RIFF") and attachment_data[8:12] == b"WEBP"
        ):
            raise HTTPException(status_code=400, detail="WebP eki geçerli görünmüyor.")
        if extension in {".docx", ".pptx", ".xlsx"} and not attachment_data.startswith(b"PK"):
            raise HTTPException(status_code=400, detail="Office eki geçerli görünmüyor.")
        if extension in AUDIO_EXTENSIONS:
            valid_audio = {
                ".webm": attachment_data.startswith(b"\x1aE\xdf\xa3"),
                ".m4a": b"ftyp" in attachment_data[4:16],
                ".mp3": attachment_data.startswith(b"ID3") or (len(attachment_data) > 1 and attachment_data[0] == 0xFF and attachment_data[1] & 0xE0 == 0xE0),
                ".ogg": attachment_data.startswith(b"OggS"),
                ".wav": attachment_data.startswith(b"RIFF") and attachment_data[8:12] == b"WAVE",
                ".aac": len(attachment_data) > 1 and attachment_data[0] == 0xFF and attachment_data[1] & 0xF6 == 0xF0,
            }[extension]
            if not valid_audio:
                raise HTTPException(status_code=400, detail="Ses kaydı geçerli görünmüyor.")
        attachment_name = re.sub(r"[\x00-\x1f\x7f]", "", attachment_name)[:255]
        attachment_mime = AUDIO_MIME_TYPES.get(extension) or mimetypes.guess_type(attachment_name)[0] or "application/octet-stream"
    if not clean_body and not attachment_data:
        raise HTTPException(status_code=422, detail="Mesaj yaz veya dosya ekle.")

    message = DirectMessage(
        sender_id=user.id,
        recipient_id=recipient.id,
        body=clean_body,
        attachment_name=attachment_name,
        attachment_mime=attachment_mime,
        attachment_data=attachment_data,
    )
    db.add(message)
    db.commit()
    db.refresh(message)
    return _message_out(message)


@router.get("/{message_id}/attachment")
def download_attachment(
    message_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    message = db.scalar(
        select(DirectMessage).where(
            DirectMessage.id == message_id,
            or_(DirectMessage.sender_id == user.id, DirectMessage.recipient_id == user.id),
        )
    )
    if not message or not message.attachment_data or not message.attachment_name:
        raise HTTPException(status_code=404, detail="Dosya eki bulunamadı.")
    return Response(
        content=message.attachment_data,
        media_type=message.attachment_mime or "application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(message.attachment_name)}",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/{message_id}/audio")
def play_audio_message(
    message_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    message = db.scalar(
        select(DirectMessage).where(
            DirectMessage.id == message_id,
            or_(DirectMessage.sender_id == user.id, DirectMessage.recipient_id == user.id),
        )
    )
    extension = PurePath(message.attachment_name).suffix.lower() if message and message.attachment_name else ""
    if not message or not message.attachment_data or extension not in AUDIO_EXTENSIONS:
        raise HTTPException(status_code=404, detail="Sesli mesaj bulunamadı.")
    return Response(
        content=message.attachment_data,
        media_type=AUDIO_MIME_TYPES[extension],
        headers={
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, no-store",
        },
    )
