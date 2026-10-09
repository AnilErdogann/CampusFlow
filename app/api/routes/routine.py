from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import (
    AttendancePolicy,
    AttendanceRecord,
    Course,
    FocusSession,
    StudyPreference,
    User,
)
from app.schemas.schemas import AttendanceUpsert, FocusSessionCreate, StudyGoalUpdate

router = APIRouter()


def owned_course(course_id: int, user: User, db: Session) -> Course:
    course = db.scalar(select(Course).where(Course.id == course_id, Course.owner_id == user.id))
    if course is None:
        raise HTTPException(status_code=404, detail="Ders bulunamadı")
    return course


def get_or_create_preferences(user: User, db: Session) -> StudyPreference:
    preferences = db.scalar(select(StudyPreference).where(StudyPreference.owner_id == user.id))
    if preferences is None:
        preferences = StudyPreference(owner_id=user.id, weekly_goal_minutes=300)
        db.add(preferences)
        db.commit()
        db.refresh(preferences)
    return preferences


@router.get("/overview")
def overview(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    sessions = list(
        db.scalars(
            select(FocusSession)
            .where(FocusSession.owner_id == user.id)
            .order_by(FocusSession.session_date.desc(), FocusSession.id.desc())
            .limit(40)
        )
    )
    week_sessions = list(
        db.scalars(
            select(FocusSession).where(
                FocusSession.owner_id == user.id,
                FocusSession.session_date >= week_start,
                FocusSession.session_date <= today,
            )
        )
    )
    minutes_by_day = {
        (week_start + timedelta(days=offset)).isoformat(): 0 for offset in range(7)
    }
    for session in week_sessions:
        day_key = session.session_date.isoformat()
        minutes_by_day[day_key] += session.duration_minutes

    active_dates = set(
        db.scalars(
            select(FocusSession.session_date)
            .where(FocusSession.owner_id == user.id, FocusSession.session_date <= today)
            .distinct()
        )
    )
    streak = 0
    streak_day = today
    if streak_day not in active_dates:
        streak_day -= timedelta(days=1)
    while streak_day in active_dates:
        streak += 1
        streak_day -= timedelta(days=1)

    courses = list(
        db.scalars(select(Course).where(Course.owner_id == user.id).order_by(Course.code))
    )
    records = list(
        db.execute(
            select(AttendanceRecord, Course)
            .join(Course, AttendanceRecord.course_id == Course.id)
            .where(AttendanceRecord.owner_id == user.id, Course.owner_id == user.id)
            .order_by(AttendanceRecord.session_date.desc(), AttendanceRecord.id.desc())
            .limit(30)
        )
    )
    record_counts = db.execute(
        select(
            AttendanceRecord.course_id,
            AttendanceRecord.status,
            func.count(AttendanceRecord.id),
        )
        .where(AttendanceRecord.owner_id == user.id)
        .group_by(AttendanceRecord.course_id, AttendanceRecord.status)
    ).all()
    counts: dict[int, dict[str, int]] = {}
    for course_id, attendance_status, count in record_counts:
        counts.setdefault(course_id, {"attended": 0, "absent": 0, "excused": 0})[
            attendance_status
        ] = count
    policies = {
        policy.course_id: policy.allowed_absences
        for policy in db.scalars(
            select(AttendancePolicy).where(AttendancePolicy.owner_id == user.id)
        )
    }
    attendance_by_course = []
    for course in courses:
        course_counts = counts.get(course.id, {"attended": 0, "absent": 0, "excused": 0})
        allowed = policies.get(course.id, 3)
        absent = course_counts["absent"]
        total = sum(course_counts.values())
        attendance_by_course.append(
            {
                "course_id": course.id,
                "course_code": course.code,
                "course_name": course.name,
                **course_counts,
                "total": total,
                "allowed_absences": allowed,
                "risk": absent >= max(1, allowed - 1) if allowed else absent > 0,
            }
        )

    preference = get_or_create_preferences(user, db)
    return {
        "today": today.isoformat(),
        "week_start": week_start.isoformat(),
        "weekly_goal_minutes": preference.weekly_goal_minutes,
        "week_minutes": sum(item.duration_minutes for item in week_sessions),
        "today_minutes": sum(
            item.duration_minutes for item in week_sessions if item.session_date == today
        ),
        "streak_days": streak,
        "week_by_day": minutes_by_day,
        "sessions": [
            {
                "id": item.id,
                "course_id": item.course_id,
                "course_name": db.get(Course, item.course_id).name
                if item.course_id and db.get(Course, item.course_id)
                else None,
                "date": item.session_date.isoformat(),
                "duration_minutes": item.duration_minutes,
                "note": item.note,
            }
            for item in sessions[:20]
        ],
        "attendance_by_course": attendance_by_course,
        "attendance_records": [
            {
                "id": record.id,
                "course_id": course.id,
                "course_code": course.code,
                "course_name": course.name,
                "date": record.session_date.isoformat(),
                "status": record.status,
                "note": record.note,
            }
            for record, course in records
        ],
    }


@router.put("/goal")
def update_goal(
    payload: StudyGoalUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    preference = get_or_create_preferences(user, db)
    preference.weekly_goal_minutes = payload.weekly_goal_minutes
    db.commit()
    return {"weekly_goal_minutes": preference.weekly_goal_minutes}


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
def create_focus_session(
    payload: FocusSessionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session_date = payload.session_date or date.today()
    if session_date > date.today():
        raise HTTPException(status_code=422, detail="Gelecek tarihli çalışma kaydedilemez")
    if payload.course_id is not None:
        owned_course(payload.course_id, user, db)
    session = FocusSession(
        owner_id=user.id,
        course_id=payload.course_id,
        session_date=session_date,
        duration_minutes=payload.duration_minutes,
        note=payload.note.strip() if payload.note else None,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return {"id": session.id, "date": session.session_date.isoformat()}


@router.post("/attendance", status_code=status.HTTP_201_CREATED)
def upsert_attendance(
    payload: AttendanceUpsert,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    course = owned_course(payload.course_id, user, db)
    if payload.session_date > date.today():
        raise HTTPException(status_code=422, detail="Gelecek tarihli yoklama kaydedilemez")
    record = db.scalar(
        select(AttendanceRecord).where(
            AttendanceRecord.owner_id == user.id,
            AttendanceRecord.course_id == course.id,
            AttendanceRecord.session_date == payload.session_date,
        )
    )
    if record is None:
        record = AttendanceRecord(
            owner_id=user.id, course_id=course.id, session_date=payload.session_date
        )
        db.add(record)
    record.status = payload.status
    record.note = payload.note.strip() if payload.note else None

    policy = db.scalar(
        select(AttendancePolicy).where(
            AttendancePolicy.owner_id == user.id, AttendancePolicy.course_id == course.id
        )
    )
    if policy is None:
        policy = AttendancePolicy(owner_id=user.id, course_id=course.id)
        db.add(policy)
    policy.allowed_absences = payload.allowed_absences
    db.commit()
    db.refresh(record)
    return {"id": record.id, "status": record.status, "date": record.session_date.isoformat()}


@router.delete("/attendance/{record_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_attendance(
    record_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    record = db.scalar(
        select(AttendanceRecord).where(
            AttendanceRecord.id == record_id, AttendanceRecord.owner_id == user.id
        )
    )
    if record is None:
        raise HTTPException(status_code=404, detail="Yoklama kaydı bulunamadı")
    db.delete(record)
    db.commit()
