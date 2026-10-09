import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import inspect

from app.api.routes import (
    account,
    admin,
    ai,
    auth,
    courses,
    dashboard,
    messages,
    realtime,
    routine,
    schedule,
    study,
    tasks,
)
from app.core.config import get_settings
from app.db.session import Base, engine

settings = get_settings()
APP_ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = Path(__file__).resolve().parent / "static"
DOWNLOAD_DIR = Path(os.getenv("CAMPUSFLOW_DOWNLOADS_DIR", APP_ROOT / "downloads"))
app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    description="Academic planning, task management and performance analytics API.",
)

Base.metadata.create_all(bind=engine)
if "courses" in inspect(engine).get_table_names():
    existing_course_columns = {column["name"] for column in inspect(engine).get_columns("courses")}
    if "course_note" not in existing_course_columns:
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE courses ADD COLUMN course_note TEXT")
if "study_documents" in inspect(engine).get_table_names():
    existing_document_columns = {
        column["name"] for column in inspect(engine).get_columns("study_documents")
    }
    with engine.begin() as connection:
        if "ai_provider" not in existing_document_columns:
            connection.exec_driver_sql(
                "ALTER TABLE study_documents ADD COLUMN ai_provider VARCHAR(20)"
            )
        if "ai_model" not in existing_document_columns:
            connection.exec_driver_sql(
                "ALTER TABLE study_documents ADD COLUMN ai_model VARCHAR(120)"
            )
if "direct_messages" in inspect(engine).get_table_names():
    existing_message_columns = {
        column["name"] for column in inspect(engine).get_columns("direct_messages")
    }
    if "read_at" not in existing_message_columns:
        with engine.begin() as connection:
            connection.exec_driver_sql("ALTER TABLE direct_messages ADD COLUMN read_at TIMESTAMP")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

app.include_router(auth.router, prefix="/api/auth", tags=["Authentication"])
app.include_router(courses.router, prefix="/api/courses", tags=["Courses"])
app.include_router(tasks.router, prefix="/api/tasks", tags=["Tasks"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Analytics"])
app.include_router(routine.router, prefix="/api/routine", tags=["Study routine and attendance"])
app.include_router(schedule.router, prefix="/api/schedule", tags=["Schedule"])
app.include_router(study.router, prefix="/api/study", tags=["Study materials and notes"])
app.include_router(messages.router, prefix="/api/messages", tags=["Direct messages"])
app.include_router(ai.router, prefix="/api/ai", tags=["AI settings and providers"])
app.include_router(account.router, prefix="/api/account", tags=["Account"])
app.include_router(admin.router, prefix="/api/admin", tags=["Admin"])
app.include_router(realtime.router, tags=["Realtime"])


@app.get("/", include_in_schema=False)
def root():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/download", include_in_schema=False)
def download_page():
    return FileResponse(STATIC_DIR / "download.html", headers={"Cache-Control": "no-cache"})


@app.get("/downloads/CampusFlow-Setup.exe", include_in_schema=False)
def download_windows_installer():
    installer = DOWNLOAD_DIR / "CampusFlow-Setup.exe"
    if not installer.is_file():
        raise HTTPException(status_code=404, detail="Windows kurulum dosyası bu sunucuya yüklenmemiş.")
    return FileResponse(
        installer,
        media_type="application/vnd.microsoft.portable-executable",
        filename="CampusFlow-Setup.exe",
    )


@app.get("/api/downloads/windows", include_in_schema=False)
def windows_download_status():
    installer = DOWNLOAD_DIR / "CampusFlow-Setup.exe"
    available = installer.is_file()
    return {"available": available, "size_bytes": installer.stat().st_size if available else 0}


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="text/javascript",
        headers={"Service-Worker-Allowed": "/", "Cache-Control": "no-cache"},
    )


@app.get("/health", tags=["Health"])
def health():
    return {"status": "ok"}
