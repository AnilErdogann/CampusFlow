from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Course, Task, User
from app.schemas.schemas import TaskCreate, TaskOut, TaskUpdate

router = APIRouter()


def validate_course(course_id: int | None, user: User, db: Session) -> None:
    if course_id is not None and not db.scalar(
        select(Course).where(Course.id == course_id, Course.owner_id == user.id)
    ):
        raise HTTPException(status_code=400, detail="Course does not belong to the current user")


@router.post("", response_model=TaskOut, status_code=status.HTTP_201_CREATED)
def create_task(
    payload: TaskCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    validate_course(payload.course_id, user, db)
    task = Task(owner_id=user.id, **payload.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


@router.get("", response_model=list[TaskOut])
def list_tasks(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    query = (
        select(Task).where(Task.owner_id == user.id).order_by(Task.due_at.is_(None), Task.due_at)
    )
    return list(db.scalars(query))


@router.patch("/{task_id}", response_model=TaskOut)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = db.scalar(select(Task).where(Task.id == task_id, Task.owner_id == user.id))
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    data = payload.model_dump(exclude_unset=True)
    validate_course(data.get("course_id"), user, db)
    for key, value in data.items():
        setattr(task, key, value.value if hasattr(value, "value") else value)
    db.commit()
    db.refresh(task)
    return task


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task(
    task_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    task = db.scalar(select(Task).where(Task.id == task_id, Task.owner_id == user.id))
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    db.delete(task)
    db.commit()
