from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Course, Grade, User
from app.schemas.schemas import (
    CourseAnalytics,
    CourseCreate,
    CourseNoteUpdate,
    CourseOut,
    GradeCreate,
    GradeOut,
)
from app.services.analytics import course_progress, weighted_average

router = APIRouter()


def owned_course(course_id: int, user: User, db: Session) -> Course:
    course = db.scalar(select(Course).where(Course.id == course_id, Course.owner_id == user.id))
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    return course


@router.post("", response_model=CourseOut, status_code=status.HTTP_201_CREATED)
def create_course(
    payload: CourseCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    if db.scalar(
        select(Course).where(Course.owner_id == user.id, Course.code == payload.code.upper())
    ):
        raise HTTPException(status_code=409, detail="Course code already exists")
    course = Course(
        owner_id=user.id,
        code=payload.code.upper(),
        name=payload.name.strip(),
        **payload.model_dump(exclude={"code", "name"}),
    )
    db.add(course)
    db.commit()
    db.refresh(course)
    return course


@router.get("", response_model=list[CourseOut])
def list_courses(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list(db.scalars(select(Course).where(Course.owner_id == user.id).order_by(Course.code)))


@router.put("/{course_id}/note", response_model=CourseOut)
def update_course_note(
    course_id: int,
    payload: CourseNoteUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    course = owned_course(course_id, user, db)
    course.course_note = payload.course_note.strip() or None if payload.course_note else None
    db.commit()
    db.refresh(course)
    return course


@router.get("/{course_id}/analytics", response_model=CourseAnalytics)
def analytics(
    course_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    course = owned_course(course_id, user, db)
    return CourseAnalytics(
        course_id=course.id,
        code=course.code,
        name=course.name,
        weighted_average=weighted_average(course),
        target_grade=course.target_grade,
        progress_percent=course_progress(course),
    )


@router.post("/{course_id}/grades", response_model=GradeOut, status_code=status.HTTP_201_CREATED)
def add_grade(
    course_id: int,
    payload: GradeCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    course = owned_course(course_id, user, db)
    current_weight = db.scalar(
        select(func.coalesce(func.sum(Grade.weight), 0)).where(Grade.course_id == course.id)
    )
    remaining_weight = max(0.0, 100.0 - float(current_weight or 0.0))
    if payload.weight > remaining_weight + 1e-6:
        remaining_text = f"{remaining_weight:.2f}".rstrip("0").rstrip(".").replace(".", ",")
        raise HTTPException(
            status_code=422,
            detail=f"Bu derste en fazla %{remaining_text} değerlendirme ağırlığı kalmış.",
        )
    grade = Grade(course_id=course.id, **payload.model_dump())
    db.add(grade)
    db.commit()
    db.refresh(grade)
    return grade


@router.put("/{course_id}/grades/{grade_id}", response_model=GradeOut)
def update_grade(
    course_id: int,
    grade_id: int,
    payload: GradeCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    course = owned_course(course_id, user, db)
    grade = db.scalar(
        select(Grade).where(Grade.id == grade_id, Grade.course_id == course.id)
    )
    if grade is None:
        raise HTTPException(status_code=404, detail="Değerlendirme bulunamadı")

    other_weight = db.scalar(
        select(func.coalesce(func.sum(Grade.weight), 0)).where(
            Grade.course_id == course.id, Grade.id != grade.id
        )
    )
    remaining_weight = max(0.0, 100.0 - float(other_weight or 0.0))
    if payload.weight > remaining_weight + 1e-6:
        remaining_text = f"{remaining_weight:.2f}".rstrip("0").rstrip(".").replace(".", ",")
        raise HTTPException(
            status_code=422,
            detail=f"Bu dersin diğer notlarıyla en fazla %{remaining_text} ağırlık kullanılabilir.",
        )

    for key, value in payload.model_dump().items():
        setattr(grade, key, value)
    db.commit()
    db.refresh(grade)
    return grade


@router.delete("/{course_id}/grades/{grade_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_grade(
    course_id: int,
    grade_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    course = owned_course(course_id, user, db)
    grade = db.scalar(
        select(Grade).where(Grade.id == grade_id, Grade.course_id == course.id)
    )
    if grade is None:
        raise HTTPException(status_code=404, detail="Değerlendirme bulunamadı")
    db.delete(grade)
    db.commit()


@router.get("/{course_id}/grades", response_model=list[GradeOut])
def list_grades(
    course_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    course = owned_course(course_id, user, db)
    return list(db.scalars(select(Grade).where(Grade.course_id == course.id).order_by(Grade.id)))
