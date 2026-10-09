from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.models import TaskStatus


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=72)

    @field_validator("password")
    @classmethod
    def password_fits_bcrypt(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Parola UTF-8 olarak en fazla 72 bayt olabilir")
        return value


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    full_name: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)

    @field_validator("password")
    @classmethod
    def password_fits_bcrypt(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Parola UTF-8 olarak en fazla 72 bayt olabilir")
        return value


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class CourseCreate(BaseModel):
    code: str = Field(min_length=2, max_length=30)
    name: str = Field(min_length=2, max_length=150)
    credits: int = Field(ge=1, le=30)
    target_grade: float = Field(default=70, ge=0, le=100)


class CourseOut(CourseCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    course_note: str | None = None


class CourseNoteUpdate(BaseModel):
    course_note: str | None = Field(default=None, max_length=1200)


class TaskCreate(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    description: str | None = None
    course_id: int | None = None
    priority: int = Field(default=3, ge=1, le=5)
    due_at: datetime | None = None


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=200)
    description: str | None = None
    course_id: int | None = None
    priority: int | None = Field(default=None, ge=1, le=5)
    due_at: datetime | None = None
    status: TaskStatus | None = None


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    description: str | None
    course_id: int | None
    priority: int
    due_at: datetime | None
    status: TaskStatus


class GradeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    score: float = Field(ge=0, le=100)
    weight: float = Field(gt=0, le=100)


class GradeOut(GradeCreate):
    model_config = ConfigDict(from_attributes=True)
    id: int
    course_id: int


class CourseAnalytics(BaseModel):
    course_id: int
    code: str
    name: str
    weighted_average: float | None
    target_grade: float
    progress_percent: float


class MeetingImport(BaseModel):
    weekday: int = Field(ge=0, le=6)
    start_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    end_time: str = Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    instructor: str | None = Field(default=None, max_length=150)
    room: str | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def end_after_start(self):
        if self.end_time <= self.start_time:
            raise ValueError("Ders bitiş saati başlangıç saatinden sonra olmalı")
        return self


class ScheduleCourseImport(BaseModel):
    code: str = Field(min_length=2, max_length=30)
    name: str = Field(min_length=2, max_length=150)
    credits: int | None = Field(default=None, ge=1, le=30)
    target_grade: float | None = Field(default=None, ge=0, le=100)
    meetings: list[MeetingImport] = Field(min_length=1, max_length=24)


class ScheduleUpdate(BaseModel):
    courses: list[ScheduleCourseImport] = Field(min_length=1, max_length=200)


class ScheduleEntryOut(BaseModel):
    id: int
    course_id: int
    code: str
    name: str
    weekday: int
    start_time: str
    end_time: str
    instructor: str | None
    room: str | None
    course_note: str | None = None


class ScheduleUpdateOut(BaseModel):
    updated_courses: int
    updated_meetings: int


class StudyNoteCreate(BaseModel):
    title: str = Field(min_length=1, max_length=180)
    body: str = Field(min_length=1, max_length=20_000)
    source_document_id: int | None = None


class AssistantQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=1000)


class StudyNoteOut(BaseModel):
    id: int
    title: str
    body: str
    source_document_id: int | None
    source_title: str | None = None
    created_at: datetime


class StudyDocumentOut(BaseModel):
    id: int
    title: str
    filename: str
    short_summary: str
    long_summary: str
    ai_provider: Literal["local", "cloud"] | None = None
    ai_model: str | None = None
    created_at: datetime


class MessageOut(BaseModel):
    id: int
    sender_id: int
    sender_name: str
    sender_email: EmailStr
    recipient_id: int
    recipient_name: str
    recipient_email: EmailStr
    body: str
    attachment_name: str | None
    created_at: datetime
    read_at: datetime | None = None


class MessageContactOut(BaseModel):
    user_id: int
    full_name: str
    email: EmailStr
    last_message: str
    created_at: datetime
    unread_count: int = 0


class AISettingsUpdate(BaseModel):
    provider: Literal["local", "cloud"] = "local"
    local_model: str = Field(default="qwen2.5:3b", min_length=1, max_length=120)
    cloud_model: str = Field(default="gpt-6-luna", min_length=1, max_length=120)
    cloud_api_key: str | None = Field(default=None, max_length=500)
    clear_cloud_api_key: bool = False
    response_length: Literal["concise", "standard", "detailed"] = "standard"
    temperature: float = Field(default=0.25, ge=0, le=1)
    share_materials_cloud: bool = False
    include_sources: bool = True

    @field_validator("local_model", "cloud_model")
    @classmethod
    def model_name_is_safe(cls, value: str) -> str:
        import re

        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}", value.strip()):
            raise ValueError("Model adı geçersiz")
        return value.strip()


class AISettingsOut(BaseModel):
    provider: Literal["local", "cloud"]
    local_model: str
    cloud_model: str
    cloud_api_key_set: bool
    cloud_api_key_hint: str | None
    response_length: Literal["concise", "standard", "detailed"]
    temperature: float
    share_materials_cloud: bool
    include_sources: bool


class AISummaryOut(BaseModel):
    short_summary: str
    long_summary: str
    provider: Literal["local", "cloud"]
    model: str


class AssistantSourceOut(BaseModel):
    document_id: int
    title: str
    page_number: int | None = None
    excerpt: str
    citation: int


class AssistantAnswerOut(BaseModel):
    answer: str
    provider: Literal["local", "cloud"]
    model: str
    used_materials: bool
    sources: list[AssistantSourceOut] = Field(default_factory=list)
    privacy_note: str | None = None


class Dashboard(BaseModel):
    total_courses: int
    total_tasks: int
    completed_tasks: int
    completion_rate: float
    overdue_tasks: int
    average_grade: float | None


class StudyGoalUpdate(BaseModel):
    weekly_goal_minutes: int = Field(ge=60, le=3000)


class FocusSessionCreate(BaseModel):
    duration_minutes: int = Field(ge=1, le=180)
    course_id: int | None = None
    session_date: date | None = None
    note: str | None = Field(default=None, max_length=300)


class AttendanceUpsert(BaseModel):
    course_id: int
    session_date: date
    status: Literal["attended", "absent", "excused"]
    allowed_absences: int = Field(default=3, ge=0, le=30)
    note: str | None = Field(default=None, max_length=300)
