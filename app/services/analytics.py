from datetime import datetime, timezone

from app.models import Course, Task


def weighted_average(course: Course) -> float | None:
    total_weight = sum(g.weight for g in course.grades)
    if not total_weight:
        return None
    return round(sum(g.score * g.weight for g in course.grades) / total_weight, 2)


def course_progress(course: Course) -> float:
    grades = weighted_average(course)
    if grades is None:
        return 0.0
    return round(min(grades / max(course.target_grade, 1) * 100, 100), 2)


def is_overdue(task: Task) -> bool:
    if not task.due_at or task.status == "done":
        return False
    due = task.due_at
    now = datetime.now(timezone.utc) if due.tzinfo else datetime.utcnow()
    return due < now
