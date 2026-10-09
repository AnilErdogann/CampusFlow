from fastapi import APIRouter, Depends

from app.api.deps import get_admin_user, get_current_user
from app.models import User
from app.services.realtime import realtime_manager

router = APIRouter()


@router.get("/status")
def admin_status(user: User = Depends(get_current_user)):
    from app.core.config import get_settings

    configured_email = get_settings().admin_email.strip().casefold()
    return {"is_admin": bool(configured_email and user.email.strip().casefold() == configured_email)}


@router.get("/active-users")
async def active_users(_: User = Depends(get_admin_user)):
    users = await realtime_manager.snapshot()
    return {"users": users, "online_count": len(users)}
