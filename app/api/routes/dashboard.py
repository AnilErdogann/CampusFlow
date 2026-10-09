from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Course, Grade, Task, User
from app.schemas.schemas import Dashboard

router = APIRouter()


@router.get("", response_model=Dashboard)
def dashboard(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    courses = list(db.scalars(select(Course).where(Course.owner_id == user.id)))
    tasks = list(db.scalars(select(Task).where(Task.owner_id == user.id)))
    completed = sum(t.status == "done" for t in tasks)
    overdue = sum(
        bool(
            t.due_at
            and t.status != "done"
            and t.due_at < (datetime.now(timezone.utc) if t.due_at.tzinfo else datetime.utcnow())
        )
        for t in tasks
    )
    grades = list(db.scalars(select(Grade).join(Course).where(Course.owner_id == user.id)))
    total_weight = sum(g.weight for g in grades)
    avg = round(sum(g.score * g.weight for g in grades) / total_weight, 2) if total_weight else None
    return Dashboard(
        total_courses=len(courses),
        total_tasks=len(tasks),
        completed_tasks=completed,
        completion_rate=round(completed / len(tasks) * 100, 2) if tasks else 0,
        overdue_tasks=overdue,
        average_grade=avg,
    )
