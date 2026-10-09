import re
import threading
import unicodedata
from functools import lru_cache
from io import BytesIO

import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageEnhance, ImageOps, UnidentifiedImageError
from rapidocr import RapidOCR

_OCR_LOCK = threading.Lock()
_MAX_PAGES = 12
_MAX_IMAGE_PIXELS = 24_000_000
_CODE_RE = re.compile(r"(?<![A-Z0-9])([A-Z][A-Z0-9]{1,7}\s*[-/]?\s*\d{2,4})(?!\d)", re.I)
_TIME_RE = re.compile(
    r"(?<!\d)([01]?\d|2[0-3])\s*[:.]\s*([0-5]\d)\s*(?:-|–|—|to|ile|/|–)\s*"
    r"([01]?\d|2[0-3])\s*[:.]\s*([0-5]\d)(?!\d)",
    re.I,
)
_ROOM_RE = re.compile(r"\b[A-Z]{1,3}\s*[-/]\s*\d{2,4}[A-Z]?\b", re.I)
_ROOM_LABEL_RE = re.compile(
    r"\b(?:derslik|salon|sinif|sınıf|room|classroom)\s*[:#]?\s*([A-Z0-9-]{1,14})", re.I
)

_DAY_NAMES = {
    0: ("pazartesi", "pzt", "monday", "mon"),
    1: ("sali", "sal", "tuesday", "tue"),
    2: ("carsamba", "car", "wednesday", "wed"),
    3: ("persembe", "per", "thursday", "thu"),
    4: ("cuma", "friday", "fri"),
    5: ("cumartesi", "cmt", "saturday", "sat"),
    6: ("pazar", "sunday", "sun"),
}


@lru_cache(maxsize=1)
def _ocr_engine() -> RapidOCR:
    return RapidOCR()


def _fold(value: str) -> str:
    value = value.translate(
        str.maketrans(
            {
                "ı": "i",
                "İ": "I",
                "ş": "s",
                "Ş": "S",
                "ğ": "g",
                "Ğ": "G",
                "ü": "u",
                "Ü": "U",
                "ö": "o",
                "Ö": "O",
                "ç": "c",
                "Ç": "C",
            }
        )
    )
    return "".join(
        char for char in unicodedata.normalize("NFKD", value) if not unicodedata.combining(char)
    )


def _ocr_lines(image: Image.Image, min_confidence: float = 0.0) -> list[str]:
    image = ImageOps.exif_transpose(image)

    def run(source: Image.Image):
        with _OCR_LOCK:
            return _ocr_engine()(np.asarray(source.convert("RGB")))

    result = run(image)
    if not result or len(result.txts or ()) < 3:
        enhanced = ImageOps.autocontrast(ImageOps.grayscale(image))
        enhanced = ImageEnhance.Sharpness(enhanced).enhance(1.5)
        enhanced = enhanced.resize((enhanced.width * 2, enhanced.height * 2))
        retry = run(enhanced)
        if retry and len(retry.txts or ()) > len(result.txts or ()):
            result = retry
    if not result or not result.txts:
        return []
    entries = []
    scores = result.scores or [1.0] * len(result.txts)
    for box, text, confidence in zip(result.boxes, result.txts, scores, strict=False):
        if float(confidence) < min_confidence:
            continue
        if text and text.strip():
            y = float(np.mean(box[:, 1]))
            height = max(1.0, float(np.max(box[:, 1]) - np.min(box[:, 1])))
            x = float(np.min(box[:, 0]))
            entries.append((y, x, height, text.strip()))
    entries.sort(key=lambda item: (item[0], item[1]))
    lines: list[list[tuple[float, float, float, str]]] = []
    for entry in entries:
        if not lines or abs(entry[0] - float(np.mean([part[0] for part in lines[-1]]))) > max(
            10, entry[2] * 0.7
        ):
            lines.append([entry])
        else:
            lines[-1].append(entry)
    return [" ".join(part[3] for part in row) for row in lines]


def _read_document(content: bytes, extension: str) -> list[str]:
    if extension == ".pdf":
        try:
            document = pdfium.PdfDocument(content)
        except Exception as exc:
            raise ValueError(
                "PDF dosyası açılamadı. Dosyanın bozuk veya parola korumalı olmadığını kontrol et."
            ) from exc
        if len(document) > _MAX_PAGES:
            document.close()
            raise ValueError(f"En fazla {_MAX_PAGES} sayfalık bir program yükleyebilirsin.")
        lines: list[str] = []
        try:
            for page in document:
                text_page = page.get_textpage()
                text = text_page.get_text_range().strip()
                if len(text) >= 24:
                    lines.extend(line.strip() for line in text.splitlines() if line.strip())
                else:
                    bitmap = page.render(scale=2.2)
                    image = bitmap.to_pil()
                    lines.extend(_ocr_lines(image))
                    bitmap.close()
                text_page.close()
        finally:
            document.close()
        return lines

    try:
        image = Image.open(BytesIO(content))
        if image.width * image.height > _MAX_IMAGE_PIXELS:
            raise ValueError("Fotoğraf çok büyük. Daha küçük bir görüntü yükle.")
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise ValueError("Fotoğraf okunamadı. JPG, PNG veya WebP dosyası yükle.") from exc
    return _ocr_lines(image)


def _find_days(text: str) -> list[int]:
    folded = _fold(text).lower()
    days = []
    for day, aliases in _DAY_NAMES.items():
        for alias in aliases:
            if re.search(rf"(?<![a-z]){re.escape(alias)}(?![a-z])", folded):
                days.append(day)
                break
    return days


def _format_time(hour: str, minute: str) -> str:
    return f"{int(hour):02d}:{minute}"


def _extract_rooms(text: str, course_code: str) -> list[str]:
    """Extract classroom labels without mistaking a course code for a room."""
    labelled = [value for value in _ROOM_LABEL_RE.findall(text)]
    candidates = labelled or _ROOM_RE.findall(text)
    code_key = re.sub(r"[^A-Z0-9]", "", course_code.upper())
    rooms: list[str] = []
    for candidate in candidates:
        room = re.sub(r"\s+", "", candidate.upper()).replace("/", "-")
        if not room or re.sub(r"[^A-Z0-9]", "", room) == code_key:
            continue
        if room not in rooms:
            rooms.append(room)
    return rooms


def _course_code_matches(text: str) -> list[re.Match[str]]:
    """Ignore room codes in meeting rows when looking for course boundaries."""
    folded = _fold(text).upper()
    time_matches = list(_TIME_RE.finditer(text))
    labelled_room_spans = [match.span(1) for match in _ROOM_LABEL_RE.finditer(text)]
    day_names = "|".join(alias for aliases in _DAY_NAMES.values() for alias in aliases)
    matches = []
    for match in _CODE_RE.finditer(folded):
        if any(match.start() < end and match.end() > start for start, end in labelled_room_spans):
            continue
        if time_matches and match.start() >= time_matches[0].end():
            continue
        if re.fullmatch(rf"(?:{day_names})\s*[-:]?\s*\d{{1,2}}", match.group(1), re.I):
            continue
        matches.append(match)
    return matches


def _is_section_heading(row: str, department_query: str) -> bool:
    if _CODE_RE.search(_fold(row).upper()) or _TIME_RE.search(row) or _find_days(row):
        return False
    folded = _fold(row).lower().strip(" :|-_")
    if not 4 <= len(folded) <= 100:
        return False
    if department_query and _fold(department_query).lower() in folded:
        return True
    if any(
        token in folded
        for token in (
            "bolum",
            "program",
            "fakulte",
            "department",
            "faculty",
            "anabilim",
            "yonetim",
            "bilisim",
            "muhendis",
            "isletme",
            "iktisat",
            "mimarl",
        )
    ):
        return True
    return bool(row.isupper() and len(folded.split()) >= 2)


def _instructor(text: str) -> str:
    folded = _fold(text)
    match = re.search(
        r"(?:prof(?:esor)?\.?|dr\.?|doc\.?|doç\.?|hoca|ogretim\s+(?:gorevlisi|elemani|uyesi)|ogr\.?\s*uyesi)\s*[:.]?\s*([^|;,]+)",
        folded,
        re.I,
    )
    if not match:
        return ""
    name = text[match.start(1) : match.end(1)]
    name = re.sub(
        r"^(?:prof(?:esor)?|dr|doç|doc|ogr\.?|öğr\.?|gör\.?|gor\.?)\s*\.?\s*", "", name, flags=re.I
    )
    name = _TIME_RE.sub("", name)
    name = _ROOM_RE.sub("", name)
    name = _ROOM_LABEL_RE.sub("", name)
    name = re.sub(
        r"\b(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\b.*", "", name, flags=re.I
    )
    return re.sub(r"\s+", " ", name).strip(" -:|,")[:120]


def _clean_course_fragment(text: str) -> str:
    name = text
    name = _TIME_RE.sub(" ", name)
    name = _ROOM_RE.sub(" ", name)
    name = _ROOM_LABEL_RE.sub(" ", name)
    day_words = "pazartesi|pzt|salı|sali|sal|çarşamba|carsamba|car|perşembe|persembe|per|cuma|cumartesi|cmt|pazar|monday|tuesday|wednesday|thursday|friday|saturday|sunday"
    name = re.sub(rf"\b(?:{day_words})\b", " ", name, flags=re.I)
    name = re.sub(
        r"\b(?:prof(?:esor)?|dr|doç|doc|hoca|derslik|salon|sınıf|sinif|room)\b.*",
        " ",
        name,
        flags=re.I,
    )
    name = re.sub(
        r"\b(?:ders\s*(?:adi|kodu)|course\s*(?:name|code))\s*[:#-]?", " ", name, flags=re.I
    )
    name = re.sub(r"[|;,]+", " ", name)
    name = re.sub(r"\s+", " ", name).strip(" -:|,")
    return name[:150]


def _course_name(text: str, code_match: re.Match[str]) -> str:
    name = text[: code_match.start()] + " " + text[code_match.end() :]
    return _clean_course_fragment(name)


def parse_schedule_lines(lines: list[str], department_query: str = "") -> tuple[list[dict], str]:
    """Turn extracted schedule text into editable course/session suggestions."""
    rows = [re.sub(r"\s+", " ", line).strip() for line in lines if line and line.strip()]
    if not rows:
        raise ValueError("Dosyada okunabilir yazı bulunamadı. Daha net bir fotoğraf veya PDF dene.")

    # Keep each coded-course row together with following lines until the next course code.
    blocks: list[tuple[list[str], str]] = []
    current: list[str] = []
    current_section = ""
    active_section = ""

    def flush_current():
        nonlocal current
        if current:
            blocks.append((current, current_section))
            current = []

    for row in rows:
        matches = _course_code_matches(row)
        if matches:
            flush_current()
            current = [row]
            current_section = active_section
        elif _is_section_heading(row, department_query):
            flush_current()
            active_section = row
        elif current:
            current.append(row)
        elif _TIME_RE.search(row) and _find_days(row):
            current = [row]
            current_section = active_section
    flush_current()

    grouped: dict[str, dict] = {}
    for block, section in blocks:
        code_match = _CODE_RE.search(_fold(block[0]).upper())
        if not code_match:
            continue
        code = re.sub(r"\s+", "", code_match.group(1).upper()).replace("/", "-")
        name = _course_name(block[0], code_match)
        days = list(dict.fromkeys(day for row in block for day in _find_days(row)))
        time_rows = []
        room_rows: dict[int, list[str]] = {}
        time_ranges = []
        for row_index, row in enumerate(block):
            row_ranges = [
                (
                    _format_time(match.group(1), match.group(2)),
                    _format_time(match.group(3), match.group(4)),
                )
                for match in _TIME_RE.finditer(row)
            ]
            if row_ranges:
                time_rows.append(
                    {"index": row_index, "ranges": row_ranges, "days": _find_days(row)}
                )
                for time_range in row_ranges:
                    if time_range not in time_ranges:
                        time_ranges.append(time_range)
            row_rooms = _extract_rooms(row, code)
            if row_rooms:
                room_rows[row_index] = row_rooms
        all_rooms = list(dict.fromkeys(room for row_rooms in room_rows.values() for room in row_rooms))
        if len(name) < 2:
            candidates = [_clean_course_fragment(row) for row in block[1:] if not _instructor(row)]
            name = max(
                (candidate for candidate in candidates if len(candidate) >= 2), key=len, default=""
            )
        instructor = next((_instructor(row) for row in block if _instructor(row)), "")

        sessions = []
        if days and time_rows:
            time_row_count = len(time_rows)
            for time_row_number, time_row in enumerate(time_rows):
                row_days = time_row["days"]
                if not row_days and time_row_count == len(days):
                    row_days = [days[time_row_number]]
                elif not row_days:
                    row_days = days

                row_ranges = time_row["ranges"]
                if len(row_days) == len(row_ranges):
                    day_range_pairs = list(zip(row_days, row_ranges, strict=True))
                else:
                    day_range_pairs = [
                        (day, time_range) for day in row_days for time_range in row_ranges
                    ]

                row_index = time_row["index"]
                row_rooms = room_rows.get(row_index, [])
                if not row_rooms and len(all_rooms) == 1:
                    row_rooms = all_rooms
                elif (
                    not row_rooms
                    and len(all_rooms) == len(time_ranges)
                    and len(row_ranges) == 1
                ):
                    row_rooms = [all_rooms[time_ranges.index(row_ranges[0])]]
                room = row_rooms[0] if row_rooms else ""
                for day, (start, end) in day_range_pairs:
                    session = {
                        "weekday": day,
                        "start_time": start,
                        "end_time": end,
                        "room": room,
                    }
                    if session not in sessions:
                        sessions.append(session)
        if not sessions:
            sessions.append(
                {
                    "weekday": None,
                    "start_time": "",
                    "end_time": "",
                    "room": all_rooms[0] if all_rooms else "",
                }
            )

        existing = grouped.get(code)
        if existing:
            if not existing["name"] and name:
                existing["name"] = name
            if not existing["instructor"] and instructor:
                existing["instructor"] = instructor
            existing["meetings"].extend(
                session for session in sessions if session not in existing["meetings"]
            )
        else:
            grouped[code] = {
                "code": code,
                "name": name or code,
                "instructor": instructor,
                "section": section,
                "credits": None,
                "meetings": sessions,
            }

    if department_query and grouped:
        query = _fold(department_query).lower().strip()
        section_matches = [
            course
            for course in grouped.values()
            if query and query in _fold(course.get("section", "")).lower()
        ]
        course_matches = [
            course
            for course in grouped.values()
            if query and query in _fold(f"{course['code']} {course['name']}").lower()
        ]
        if section_matches:
            grouped = {course["code"]: course for course in section_matches}
        elif course_matches:
            grouped = {course["code"]: course for course in course_matches}
        # If the department is not labelled clearly, keep the detected list and let
        # the student choose from the OCR preview instead of hiding valid courses.

    courses = list(grouped.values())
    raw_text = "\n".join(rows[:100])[:8000]
    return courses, raw_text


def extract_schedule(
    content: bytes, extension: str, department_query: str = ""
) -> tuple[list[dict], str]:
    lines = _read_document(content, extension)
    return parse_schedule_lines(lines, department_query)
