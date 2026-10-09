import re
from io import BytesIO

import pypdfium2 as pdfium

from app.services.schedule_import import _ocr_lines

MAX_PDF_PAGES = 200
MAX_TEXT_CHARS = 1_500_000
_TOKEN_RE = re.compile(r"[a-zA-ZçğıöşüÇĞİÖŞÜ0-9]{2,}")
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")
_PAGE_MARKER_RE = re.compile(r"(?m)^\[\[PAGE:(\d+)\]\]\s*$")
_STOP_WORDS = set(
    "acaba ama ancak artık aslında az bazı belki benim bile bir birçok biz bu çok çünkü da daha de defa diye dolayı en gibi göre hangi hem hep hepsi her hiç için ile ise kez ki kim mı mi mu mü nasıl ne neden nerede nereye niçin o olan olarak önce sonra şu takdir tüm ve veya ya yani yok çok a an the of to in is for on that with as by from this it be are was were at or if we you they their".split()
)


def extract_pdf_text(content: bytes) -> str:
    try:
        document = pdfium.PdfDocument(content)
    except Exception as exc:
        raise ValueError(
            "PDF açılamadı. Dosyanın bozuk veya parola korumalı olmadığını kontrol et."
        ) from exc
    if len(document) > MAX_PDF_PAGES:
        document.close()
        raise ValueError(f"En fazla {MAX_PDF_PAGES} sayfalık PDF yükleyebilirsin.")
    pages: list[str] = []
    total_chars = 0
    try:
        for page_number, page in enumerate(document, start=1):
            text_page = page.get_textpage()
            try:
                text = text_page.get_text_range().strip()
            finally:
                text_page.close()
            if len(text) < 30:
                bitmap = page.render(scale=1.6)
                try:
                    text = "\n".join(_ocr_lines(bitmap.to_pil(), min_confidence=0.68))
                finally:
                    bitmap.close()
            text = re.sub(r"[ \t]+", " ", text).strip()
            if text:
                pages.append(f"[[PAGE:{page_number}]]\n{text}")
                total_chars += len(text)
            if total_chars >= MAX_TEXT_CHARS:
                break
    finally:
        document.close()
    result = "\n\n".join(pages).strip()
    if not result:
        raise ValueError("PDF içinde okunabilir metin bulunamadı. Daha net bir PDF dene.")
    return result[:MAX_TEXT_CHARS]


def pdf_page_count(content: bytes) -> int:
    try:
        document = pdfium.PdfDocument(content)
    except Exception as exc:
        raise ValueError("PDF açılamadı. Dosyanın bozuk veya parola korumalı olmadığını kontrol et.") from exc
    try:
        return len(document)
    finally:
        document.close()


def render_pdf_page(content: bytes, page_number: int) -> bytes:
    try:
        document = pdfium.PdfDocument(content)
    except Exception as exc:
        raise ValueError("PDF açılamadı. Dosyanın bozuk veya parola korumalı olmadığını kontrol et.") from exc
    try:
        if not 1 <= page_number <= len(document):
            raise ValueError("PDF sayfa numarası sınırların dışında.")
        page = document[page_number - 1]
        bitmap = page.render(scale=1.7)
        image = bitmap.to_pil()
        try:
            output = BytesIO()
            image.save(output, format="PNG", optimize=True)
            return output.getvalue()
        finally:
            image.close()
            bitmap.close()
            page.close()
    finally:
        document.close()


def _sentences(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    return [
        part.strip(" •-\t") for part in _SENTENCE_RE.split(normalized) if len(part.strip()) > 25
    ]


def _tokens(text: str) -> list[str]:
    return [word.lower() for word in _TOKEN_RE.findall(text) if word.lower() not in _STOP_WORDS]


def has_page_markers(text: str) -> bool:
    return bool(_PAGE_MARKER_RE.search(text))


def legacy_document_matches(question: str, text: str) -> bool:
    query_terms = set(_tokens(question))
    if not query_terms:
        return False
    material_terms = set(_tokens(text[:MAX_TEXT_CHARS]))
    return any(
        query_term == material_term
        or (len(query_term) >= 5 and len(material_term) >= 5 and query_term[:5] == material_term[:5])
        for query_term in query_terms
        for material_term in material_terms
    )


def _page_sections(text: str) -> list[tuple[int | None, str]]:
    matches = list(_PAGE_MARKER_RE.finditer(text))
    if not matches:
        return [(None, text)] if text.strip() else []
    sections = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        section = text[match.end() : end].strip()
        if section:
            sections.append((int(match.group(1)), section))
    return sections


def build_context_with_sources(
    question: str,
    documents: list[tuple[int, str, str]],
    max_chars: int = 18_000,
    max_sources: int = 8,
) -> tuple[str, list[dict[str, int | str | None]]]:
    query_terms = set(_tokens(question))
    if not query_terms:
        return "", []
    chunks: list[tuple[float, int, str, int | None, str]] = []
    for document_id, title, text in documents:
        for page_number, page_text in _page_sections(text):
            sentences = _sentences(page_text[:80_000])
            if not sentences and page_text.strip():
                sentences = [page_text.strip()[:1200]]
            for sentence in sentences:
                sentence_terms = set(_tokens(sentence))
                overlap = sum(
                    1
                    for query_term in query_terms
                    if any(
                        query_term == term
                        or (
                            len(query_term) >= 5
                            and len(term) >= 5
                            and query_term[:5] == term[:5]
                        )
                        for term in sentence_terms
                    )
                )
                if overlap:
                    score = overlap / max(1, len(query_terms) ** 0.45 * len(sentence_terms) ** 0.2)
                    chunks.append((score, document_id, title, page_number, sentence))
    if not chunks:
        return "", []
    chunks.sort(key=lambda item: item[0], reverse=True)
    selected: list[tuple[float, int, str, int | None, str]] = []
    page_counts: dict[tuple[int, int | None], int] = {}
    for chunk in chunks:
        page_key = (chunk[1], chunk[3])
        if page_counts.get(page_key, 0) >= 3:
            continue
        selected.append(chunk)
        page_counts[page_key] = page_counts.get(page_key, 0) + 1
        if len(selected) >= max_sources * 3:
            break

    source_by_page: dict[tuple[int, int | None], dict[str, int | str | None]] = {}
    context_lines: list[str] = []
    source_index = 0
    remaining = max_chars
    for _, document_id, title, page_number, sentence in selected:
        page_key = (document_id, page_number)
        if page_key not in source_by_page:
            if len(source_by_page) >= max_sources:
                continue
            source_index += 1
            source_by_page[page_key] = {
                "document_id": document_id,
                "title": title,
                "page_number": page_number,
                "excerpt": sentence[:320],
                "citation": source_index,
            }
        source = source_by_page[page_key]
        page_label = f"sayfa {page_number}" if page_number is not None else "sayfa bilgisi yok"
        line = f"[PDF {source['citation']} | {title} | {page_label}] {sentence}"
        if len(line) > remaining:
            line = line[:remaining]
        context_lines.append(line)
        remaining -= len(line) + 2
        if remaining <= 0:
            break
    return "\n\n".join(context_lines), list(source_by_page.values())


def build_context(question: str, materials: list[tuple[str, str]], max_chars: int = 18_000) -> str:
    query_terms = set(_tokens(question))
    chunks: list[tuple[float, str, str]] = []
    for title, text in materials:
        sentences = _sentences(text[:80_000])
        if not sentences and text.strip():
            sentences = [text.strip()[:1200]]
        for sentence in sentences:
            terms = set(_tokens(sentence))
            if query_terms:
                overlap = len(query_terms & terms)
                score = overlap / max(1, len(query_terms) ** 0.45 * len(terms) ** 0.2)
            else:
                score = 0.1
            chunks.append((score, title, sentence))
    if not chunks:
        return ""
    matching = [item for item in chunks if item[0] > 0]
    if matching:
        matching.sort(key=lambda item: item[0], reverse=True)
        selected = matching[:14]
    else:
        # Give the model representative context when the student uses a synonym.
        selected = chunks[:8]
    selected.sort(key=lambda item: item[1])
    output: list[str] = []
    used: set[tuple[str, str]] = set()
    remaining = max_chars
    for _, title, sentence in selected:
        marker = (title, sentence)
        if marker in used:
            continue
        used.add(marker)
        block = f"[{title}] {sentence}"
        if len(block) > remaining:
            block = block[:remaining]
        output.append(block)
        remaining -= len(block) + 2
        if remaining <= 0:
            break
    return "\n\n".join(output)
