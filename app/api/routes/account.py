from datetime import datetime

from fastapi import APIRouter, Depends
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import (
    Course,
    CourseMeeting,
    DirectMessage,
    Grade,
    StudyDocument,
    StudyNote,
    Task,
    User,
)
from app.services.ai_config import get_or_create_settings

router = APIRouter()


@router.get("/export")
def export_account_data(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    courses = db.scalars(
        select(Course).where(Course.owner_id == user.id).order_by(Course.code)
    ).all()
    tasks = db.scalars(select(Task).where(Task.owner_id == user.id).order_by(Task.created_at)).all()
    meetings = db.execute(
        select(CourseMeeting, Course)
        .join(Course, CourseMeeting.course_id == Course.id)
        .where(Course.owner_id == user.id)
        .order_by(CourseMeeting.weekday, CourseMeeting.start_time)
    ).all()
    notes = db.scalars(
        select(StudyNote).where(StudyNote.owner_id == user.id).order_by(StudyNote.created_at)
    ).all()
    documents = db.scalars(
        select(StudyDocument)
        .where(StudyDocument.owner_id == user.id)
        .order_by(StudyDocument.created_at)
    ).all()
    messages = db.scalars(
        select(DirectMessage)
        .where(or_(DirectMessage.sender_id == user.id, DirectMessage.recipient_id == user.id))
        .order_by(DirectMessage.created_at)
        .limit(10_000)
    ).all()
    ai_settings = get_or_create_settings(db, user.id)
    return {
        "exported_at": datetime.utcnow().isoformat() + "Z",
        "profile": {
            "email": user.email,
            "full_name": user.full_name,
            "created_at": user.created_at.isoformat() + "Z",
        },
        "courses": [
            {
                "code": course.code,
                "name": course.name,
                "credits": course.credits,
                "target_grade": course.target_grade,
                "grades": [
                    {"name": grade.name, "score": grade.score, "weight": grade.weight}
                    for grade in db.scalars(select(Grade).where(Grade.course_id == course.id)).all()
                ],
            }
            for course in courses
        ],
        "tasks": [
            {
                "title": task.title,
                "description": task.description,
                "status": task.status,
                "priority": task.priority,
                "due_at": task.due_at.isoformat() if task.due_at else None,
            }
            for task in tasks
        ],
        "schedule": [
            {
                "course_code": course.code,
                "course_name": course.name,
                "weekday": meeting.weekday,
                "start_time": meeting.start_time,
                "end_time": meeting.end_time,
                "instructor": meeting.instructor,
                "room": meeting.room,
            }
            for meeting, course in meetings
        ],
        "ai_notes": [
            {
                "title": note.title,
                "body": note.body,
                "created_at": note.created_at.isoformat() + "Z",
            }
            for note in notes
        ],
        "study_documents": [
            {
                "title": document.title,
                "filename": document.filename,
                "short_summary": document.short_summary,
                "long_summary": document.long_summary,
                "created_at": document.created_at.isoformat() + "Z",
            }
            for document in documents
        ],
        "messages": [
            {
                "from": message.sender.email,
                "to": message.recipient.email,
                "body": message.body,
                "attachment_name": message.attachment_name,
                "created_at": message.created_at.isoformat() + "Z",
            }
            for message in messages
        ],
        "ai_preferences": {
            "provider": ai_settings.provider,
            "local_model": ai_settings.local_model,
            "cloud_model": ai_settings.cloud_model,
            "response_length": ai_settings.response_length,
            "share_materials_cloud": ai_settings.share_materials_cloud,
            "include_sources": ai_settings.include_sources,
        },
        "privacy": "Passwords, API keys, original PDF bytes and attachment contents are not included in this export.",
    }
