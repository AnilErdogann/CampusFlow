from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import delete, select
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db.session import get_db
from app.models import Course, CourseMeeting, User
from app.schemas.schemas import ScheduleEntryOut, ScheduleUpdate, ScheduleUpdateOut
from app.services.schedule_import import _fold, extract_schedule

router = APIRouter()
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".webp"}


@router.get("", response_model=list[ScheduleEntryOut])
def get_schedule(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = db.execute(
        select(CourseMeeting, Course)
        .join(Course, CourseMeeting.course_id == Course.id)
        .where(Course.owner_id == user.id)
        .order_by(CourseMeeting.weekday, CourseMeeting.start_time, Course.code)
    ).all()
    return [
        ScheduleEntryOut(
            id=meeting.id,
            course_id=course.id,
            code=course.code,
            name=course.name,
            weekday=meeting.weekday,
            start_time=meeting.start_time,
            end_time=meeting.end_time,
            instructor=meeting.instructor,
            room=meeting.room,
            course_note=course.course_note,
        )
        for meeting, course in rows
    ]


@router.post("/parse")
async def parse_schedule_upload(
    file: UploadFile = File(...),
    department: str = Form(default="", max_length=100),
    user: User = Depends(get_current_user),
):
    del user  # Authentication is required; the upload is processed in memory and never stored.
    filename = (file.filename or "").lower()
    extension = "." + filename.rsplit(".", 1)[-1] if "." in filename else ""
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="PDF, JPG, PNG veya WebP dosyası yükle.")
    content = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Dosya boyutu 15 MB sınırını aşıyor.")
    if extension == ".pdf" and not content.lstrip().startswith(b"%PDF"):
        raise HTTPException(status_code=400, detail="Bu dosya geçerli bir PDF gibi görünmüyor.")
    if extension in {".jpg", ".jpeg", ".png", ".webp"}:
        image_signatures = {
            ".jpg": (b"\xff\xd8\xff",),
            ".jpeg": (b"\xff\xd8\xff",),
            ".png": (b"\x89PNG\r\n\x1a\n",),
            ".webp": (b"RIFF",),
        }
        valid_signature = any(
            content.startswith(signature) for signature in image_signatures[extension]
        )
        if extension == ".webp":
            valid_signature = valid_signature and content[8:12] == b"WEBP"
        if not valid_signature:
            raise HTTPException(
                status_code=400, detail="Dosya uzantısı ile görüntü biçimi uyuşmuyor."
            )
    try:
        courses, raw_text = await run_in_threadpool(
            extract_schedule, content, extension, department.strip()
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=422, detail="Dosya okunamadı. Daha net bir PDF veya fotoğraf dene."
        ) from exc
    query = _fold(department.strip()).casefold()
    matched_course = any(
        query in _fold(f"{course['code']} {course['name']} {course.get('section', '')}").casefold()
        for course in courses
    )
    query_in_document = bool(query and query in _fold(raw_text).casefold())
    department_matched = not query or query_in_document or matched_course
    if query_in_document and not matched_course:
        for course in courses:
            course["section"] = department.strip()
    return {
        "courses": courses,
        "raw_text": raw_text,
        "recognized_count": len(courses),
        "department_matched": department_matched,
    }


@router.put("", response_model=ScheduleUpdateOut)
def replace_schedule(
    payload: ScheduleUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    codes = [item.code.strip().upper() for item in payload.courses]
    if len(set(codes)) != len(codes):
        raise HTTPException(
            status_code=422,
            detail="Aynı ders kodu birden fazla kez var. Önizlemede tek derste birleştir.",
        )
    meeting_count = sum(len(course.meetings) for course in payload.courses)
    if meeting_count > 600:
        raise HTTPException(
            status_code=422, detail="Bir programda en fazla 600 ders saati olabilir."
        )

    owned_courses = list(db.scalars(select(Course).where(Course.owner_id == user.id)))
    by_code = {course.code.strip().upper(): course for course in owned_courses}

    # Replace only timetable rows. Existing courses, grades, and assignments stay intact.
    db.execute(
        delete(CourseMeeting).where(
            CourseMeeting.course_id.in_(select(Course.id).where(Course.owner_id == user.id))
        )
    )
    for item in payload.courses:
        code = item.code.strip().upper()
        course = by_code.get(code)
        if course is None:
            course = Course(
                owner_id=user.id,
                code=code,
                name=item.name.strip(),
                credits=item.credits or 3,
                target_grade=70 if item.target_grade is None else item.target_grade,
            )
            db.add(course)
            db.flush()
            by_code[code] = course
        else:
            course.name = item.name.strip()
            if item.credits is not None:
                course.credits = item.credits
            if item.target_grade is not None:
                course.target_grade = item.target_grade
        for slot in item.meetings:
            course.meetings.append(
                CourseMeeting(
                    weekday=slot.weekday,
                    start_time=slot.start_time,
                    end_time=slot.end_time,
                    instructor=slot.instructor.strip() or None if slot.instructor else None,
                    room=slot.room.strip() or None if slot.room else None,
                )
            )
    db.commit()
    return ScheduleUpdateOut(updated_courses=len(payload.courses), updated_meetings=meeting_count)
