from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.secret_store import decrypt_secret
from app.models import AISettings, AIUsageEvent, User
from app.services.ai import AIProviderError, unload_local_model


def get_or_create_settings(db: Session, owner_id: int) -> AISettings:
    row = db.scalar(select(AISettings).where(AISettings.owner_id == owner_id))
    if row:
        # The previous default loaded a 14B model with a 32K context, which can
        # consume most of a student's RAM. Move only that legacy default to the
        # lightweight preset; any other model the user selected is preserved.
        if row.local_model == "qwen2.5:14b":
            row.local_model = "qwen2.5:3b"
            db.commit()
            db.refresh(row)
            try:
                unload_local_model("qwen2.5:14b")
            except AIProviderError:
                # The user's saved preference is migrated even when Ollama is offline.
                pass
        return row
    row = AISettings(owner_id=owner_id)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def provider_config(row: AISettings) -> tuple[str, str, str | None]:
    provider = row.provider
    model = row.local_model if provider == "local" else row.cloud_model
    api_key = decrypt_secret(row.cloud_api_key_encrypted) if provider == "cloud" else None
    return provider, model, api_key


def log_usage(
    db: Session,
    user: User,
    provider: str,
    model: str,
    action: str,
    input_characters: int,
    output_characters: int,
) -> None:
    db.add(
        AIUsageEvent(
            owner_id=user.id,
            provider=provider,
            model=model,
            action=action,
            input_characters=min(input_characters, 1_000_000),
            output_characters=min(output_characters, 100_000),
            created_at=datetime.utcnow(),
        )
    )
    db.commit()
