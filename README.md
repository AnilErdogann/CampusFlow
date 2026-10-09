# CampusFlow 🎓

**CampusFlow** is a Turkish-first academic planning app for university students. Its responsive web app brings courses, timetables, assignments, grades, attendance, study sessions and course materials into one account.

The dashboard turns deadlines and chosen priorities into a short next-step list. Course cards show the average still needed to reach a student's grade target. These calculations use the student's saved data and do not call a paid AI service.

> Portfolio project for demonstrating backend development, API design, relational data modeling, authentication, testing and analytics.

## Why this project?

A strong YBS portfolio project should connect **business needs** with **information systems**. CampusFlow does exactly that:

- **Business problem:** students have fragmented information about courses, tasks and grades.
- **Information system:** a central API stores and validates academic data.
- **Analytics:** weighted grades, completion rate and overdue work become measurable KPIs.
- **Software engineering:** authentication, ownership rules, tests, CI and containerization make the project closer to a real application.

## Features

- JWT-based authentication
- Secure password hashing with bcrypt
- User-specific data isolation
- Course and credit management
- Grade recording with weighted-average analytics
- Remaining grade needed to reach each course target
- Grade correction and deletion, with a 100% course-weight limit
- Assignment/task management
- Priority, due dates and status tracking
- A short, deadline-aware list of the next tasks, with quick progress actions
- Encrypted offline access to courses, tasks, timetable, study routine, attendance and notes after a successful online login on that device
- Offline core edits are queued locally and synchronized after reconnecting
- Dashboard KPIs
- Automatic API documentation via OpenAPI/Swagger
- SQLite for zero-config local development
- Docker support
- Automated GitHub Actions CI
- Automated tests with pytest
- Ruff linting

## Architecture

### Offline use

After the first successful online login, CampusFlow saves an encrypted copy of the core academic workspace in that browser on that device. On a later connection loss, enter the same email and password on the sign-in screen to unlock it. Courses, tasks, grades, timetable, attendance, focus records and saved notes remain usable; edits wait locally and sync when the account can authenticate online again.

AI requests, direct messages, PDF upload/processing, and live account features require an internet connection. Offline storage requires a secure browser context (HTTPS or `localhost`) and the app shell must have been loaded once while connected. Clearing browser site data removes the device copy; unsynchronized edits should be synced before changing devices or clearing storage.

```text
Client / Frontend
       │
       ▼
 FastAPI REST API
       │
 ┌─────┴─────────────┐
 │ Authentication     │
 │ Courses            │
 │ Tasks              │
 │ Analytics          │
 └─────┬─────────────┘
       ▼
 SQLAlchemy ORM
       │
       ▼
 SQLite / PostgreSQL
```

## Tech stack

| Area | Technology |
|---|---|
| Language | Python 3.11+ |
| API | FastAPI |
| Database | SQLite / PostgreSQL-ready |
| ORM | SQLAlchemy 2 |
| Validation | Pydantic |
| Auth | JWT + bcrypt |
| Testing | pytest + HTTPX |
| Quality | Ruff |
| Deployment | Docker |
| CI/CD | GitHub Actions |

## Run locally

### 1. Clone

```bash
git clone https://github.com/YOUR_USERNAME/campusflow.git
cd campusflow
```

### 2. Create environment

Windows PowerShell:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
```

macOS/Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

### 3. Configure

```bash
copy .env.example .env
```

On macOS/Linux use `cp .env.example .env`.

For real deployments, replace `SECRET_KEY` with a long random value and use PostgreSQL.

### 4. Start

```bash
uvicorn app.main:app --reload
```

Open:

- Swagger UI: `http://127.0.0.1:8000/docs`
- ReDoc: `http://127.0.0.1:8000/redoc`
- Health check: `http://127.0.0.1:8000/health`

## Run tests

```bash
pytest
ruff check .
```

## Docker

```bash
docker compose up --build
```

## API flow

1. `POST /api/auth/register`
2. `POST /api/auth/login`
3. Copy the returned bearer token into Swagger's **Authorize** button.
4. Create a course with `POST /api/courses`.
5. Add grades with `POST /api/courses/{course_id}/grades`.
6. Add assignments with `POST /api/tasks`.
7. View KPIs at `GET /api/dashboard`.

## Example dashboard response

```json
{
  "total_courses": 5,
  "total_tasks": 18,
  "completed_tasks": 12,
  "completion_rate": 66.67,
  "overdue_tasks": 2,
  "average_grade": 78.42
}
```

## Data model

- **User** owns courses and tasks.
- **Course** contains grades and can be linked to tasks.
- **Grade** has a score and weight, enabling weighted analytics.
- **Task** has status, priority, due date and optional course relationship.

## Security notes

Before a broad public launch, add:

- database migrations with Alembic
- refresh tokens / token revocation
- rate limiting
- structured logging and monitoring
- automated PostgreSQL backups and restore checks
- stricter CORS configuration

## Roadmap

- [ ] React/Next.js dashboard
- [ ] Calendar view
- [ ] GPA calculation by university grading rules
- [ ] Study-time tracking
- [ ] Email reminders
- [ ] Alembic migrations
- [ ] Role-based administration
- [ ] AI-assisted study planning

## Portfolio talking points

When presenting this project in an interview, focus on **why** each part exists:

- "I modeled the relationship between students, courses, tasks and grades using a relational database."
- "I isolated each user's data at the API layer so one student cannot access another student's records."
- "I used weighted averages rather than a simple mean because assessment components have different importance."
- "I added automated tests and GitHub Actions so every push checks code quality and functionality."
- "I kept the architecture modular so a frontend or PostgreSQL database can be added without rewriting the business logic."

## License

MIT

## Windows quick start

Projeyi Windows'ta açtıktan sonra `CampusFlow Kontrol Paneli` masaüstü kısayoluna veya `start.bat` dosyasına çift tıkla. İlk çalıştırmada eksik bileşenleri hazırlar; kontrol panelinden sunucuyu başlatabilir, durdurabilir, yeniden başlatabilir, yerel ağ adresini kopyalayabilir veya geçici internet bağlantısı açabilirsin. Panel kapansa da başlattığı sunucu çalışmayı sürdürür.

## Product review

See [PRODUCT_ASSESSMENT.md](PRODUCT_ASSESSMENT.md) for the product rationale, feature choices and a proposed student-validation plan.

## PC, Android, and iOS

CampusFlow is a responsive installable web app. On a PC, run the control panel and open `http://127.0.0.1:8765`. On Android, install it from Chrome; on iPhone/iPad, use Safari's **Share → Add to Home Screen → Open as Web App**. Mobile installation requires CampusFlow to be deployed at an HTTPS address.

The local Windows app stores accounts, courses, messages, PDFs, and notes in `%LOCALAPPDATA%\CampusFlow\campusflow.db` and keeps them when you log out or close the app. For the same account and delivered messages across PC and phones, deploy the included Docker Compose setup: it uses a persistent PostgreSQL volume and Caddy HTTPS. See [DEPLOYMENT.md](DEPLOYMENT.md) for setup and for copying an existing SQLite account to PostgreSQL.
