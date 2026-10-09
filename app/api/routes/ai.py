from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.core.secret_store import decrypt_secret, encrypt_secret
from app.db.session import get_db
from app.models import AISettings, AIUsageEvent, User
from app.schemas.schemas import AISettingsOut, AISettingsUpdate
from app.services.ai import AIProviderError, connection_status, generate_text, local_models
from app.services.ai_config import get_or_create_settings, log_usage, provider_config

router = APIRouter()


def _settings_out(row: AISettings) -> AISettingsOut:
    key = decrypt_secret(row.cloud_api_key_encrypted)
    return AISettingsOut(
        provider=row.provider,
        local_model=row.local_model,
        cloud_model=row.cloud_model,
        cloud_api_key_set=bool(key),
        cloud_api_key_hint=f"••••{key[-4:]}" if key else None,
        response_length=row.response_length,
        temperature=row.temperature,
        share_materials_cloud=row.share_materials_cloud,
        include_sources=row.include_sources,
    )


def current_provider(row: AISettings) -> tuple[str, str, str | None]:
    provider, model, api_key = provider_config(row)
    if provider == "cloud" and not api_key:
        raise HTTPException(
            status_code=400, detail="Bulut AI için API anahtarını Ayarlar bölümüne ekle."
        )
    return provider, model, api_key


@router.get("/settings", response_model=AISettingsOut)
def read_settings(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _settings_out(get_or_create_settings(db, user.id))


@router.put("/settings", response_model=AISettingsOut)
def update_settings(
    payload: AISettingsUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    row = get_or_create_settings(db, user.id)
    row.provider = payload.provider
    row.local_model = payload.local_model
    row.cloud_model = payload.cloud_model
    row.response_length = payload.response_length
    row.temperature = payload.temperature
    row.share_materials_cloud = payload.share_materials_cloud
    row.include_sources = payload.include_sources
    if payload.clear_cloud_api_key:
        row.cloud_api_key_encrypted = None
    elif payload.cloud_api_key and payload.cloud_api_key.strip():
        row.cloud_api_key_encrypted = encrypt_secret(payload.cloud_api_key.strip())
    db.commit()
    db.refresh(row)
    return _settings_out(row)


@router.get("/status")
async def read_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = get_or_create_settings(db, user.id)
    provider, model, key = provider_config(row)
    result = await run_in_threadpool(connection_status, provider, model, key)
    return result


@router.get("/local/models")
async def list_local_models(user: User = Depends(get_current_user)):
    del user
    try:
        models = await run_in_threadpool(local_models)
    except AIProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"models": models}


@router.post("/test")
async def test_current_provider(
    user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    row = get_or_create_settings(db, user.id)
    provider, model, key = current_provider(row)
    try:
        answer = await run_in_threadpool(
            generate_text,
            provider=provider,
            model=model,
            api_key=key,
            system_prompt="Yanıtın yalnızca Türkçe olsun.",
            user_prompt="Yalnızca şu cümleyi yaz: CampusFlow AI bağlantısı çalışıyor.",
            response_length="concise",
            temperature=0,
            max_output_tokens=256,
        )
    except AIProviderError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    log_usage(db, user, provider, model, "connection_test", 84, len(answer))
    return {
        "ok": True,
        "provider": provider,
        "model": model,
        "message": "Bağlantı başarılı.",
        "answer": answer,
    }


@router.get("/usage")
def read_usage(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    rows = db.execute(
        select(
            AIUsageEvent.provider,
            func.count(AIUsageEvent.id),
            func.sum(AIUsageEvent.input_characters),
        )
        .where(AIUsageEvent.owner_id == user.id, AIUsageEvent.created_at >= month_start)
        .group_by(AIUsageEvent.provider)
    ).all()
    usage = {
        "local": {"requests": 0, "input_characters": 0},
        "cloud": {"requests": 0, "input_characters": 0},
    }
    for provider, count, characters in rows:
        usage[provider] = {"requests": count or 0, "input_characters": characters or 0}
    return {"month": now.strftime("%Y-%m"), "providers": usage}
