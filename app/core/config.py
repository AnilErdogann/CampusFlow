import os
import secrets
import shutil
import sys
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _app_data_dir() -> Path:
    configured = os.getenv("CAMPUSFLOW_DATA_DIR")
    if configured:
        return Path(configured).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return (base / "CampusFlow").resolve()


APP_DATA_DIR = _app_data_dir()
APP_ENV_FILE = APP_DATA_DIR / ".env"
APP_DATABASE_FILE = APP_DATA_DIR / "campusflow.db"


def _migrate_legacy_install() -> None:
    # A copy preserves the old project-folder database as a recoverable backup.
    # Skip automatic migration when tests or deployments explicitly select a DB.
    if os.getenv("DATABASE_URL"):
        return
    APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    legacy_db = Path.cwd() / "campusflow.db"
    if not APP_DATABASE_FILE.exists() and legacy_db.is_file():
        if legacy_db.resolve() != APP_DATABASE_FILE.resolve():
            shutil.copy2(legacy_db, APP_DATABASE_FILE)
    legacy_env = Path.cwd() / ".env"
    if not APP_ENV_FILE.exists() and legacy_env.is_file():
        entries = legacy_env.read_text(encoding="utf-8").splitlines()
        normalized_url = f"sqlite:///{APP_DATABASE_FILE.as_posix()}"
        for index, line in enumerate(entries):
            if line.startswith("DATABASE_URL=sqlite:///./campusflow.db") or line.startswith(
                "DATABASE_URL=sqlite:///campusflow.db"
            ):
                entries[index] = f"DATABASE_URL={normalized_url}"
        APP_ENV_FILE.write_text("\n".join(entries).rstrip() + "\n", encoding="utf-8")


if not os.getenv("DATABASE_URL") and os.getenv("CAMPUSFLOW_SKIP_LEGACY_MIGRATION") != "1":
    _migrate_legacy_install()


class Settings(BaseSettings):
    app_name: str = "CampusFlow"
    database_url: str = f"sqlite:///{APP_DATABASE_FILE.as_posix()}"
    secret_key: str = "change-this-in-production"
    access_token_expire_minutes: int = 60
    admin_email: str = ""
    webrtc_turn_urls: str = ""
    webrtc_turn_username: str = ""
    webrtc_turn_credential: str = ""

    model_config = SettingsConfigDict(
        env_file=APP_ENV_FILE, case_sensitive=False, extra="ignore"
    )


@lru_cache
def get_settings() -> Settings:
    # Keep a strong installation secret across restarts for JWTs and encrypted AI keys.
    # Environment-provided secrets continue to take precedence for hosted/test deployments.
    if not os.getenv("SECRET_KEY"):
        env_path = APP_ENV_FILE
        existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        entries = existing.splitlines()
        secret_line = next(
            (line for line in entries if line.strip().startswith("SECRET_KEY=")), None
        )
        existing_secret = secret_line.split("=", 1)[1].strip().strip("\"'") if secret_line else ""
        if len(existing_secret) < 48 or existing_secret == "change-this-in-production":
            generated_secret = secrets.token_urlsafe(48)
            replacement = f"SECRET_KEY={generated_secret}"
            if secret_line:
                entries[entries.index(secret_line)] = replacement
            else:
                entries.append(replacement)
            env_path.write_text("\n".join(entries).rstrip() + "\n", encoding="utf-8")
    return Settings()
