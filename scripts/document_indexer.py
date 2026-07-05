"""Local document indexing pipeline: two chunking strategies + FAISS + JSON.

The script communicates with the Tauri host using JSON Lines on stdout.  It can
also be run directly; pass the configuration JSON through stdin.
"""

from __future__ import annotations

import json
import re
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


SUPPORTED_EXTENSIONS = {
    ".md", ".markdown", ".txt", ".rst", ".py", ".rs", ".ts", ".tsx",
    ".js", ".jsx", ".json", ".toml", ".yaml", ".yml", ".html", ".css", ".pdf",
}
EXCLUDED_DIRECTORIES = {
    ".git", ".idea", ".vscode", ".venv", "venv", "node_modules", "dist",
    "build", "target", "gen", "__pycache__", "document-index", ".agents", "summaries",
}
EXCLUDED_FILENAMES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock"}
CODE_EXTENSIONS = {".py", ".rs", ".ts", ".tsx", ".js", ".jsx", ".css"}
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
RST_HEADING_RE = re.compile(r"^[=\-~^`:#*+]{3,}\s*$")
CODE_SECTION_RE = re.compile(
    r"^\s*(?:pub\s+|export\s+|async\s+|static\s+|const\s+)?"
    r"(?:class|interface|enum|trait|struct|impl|def|fn|function)\s+([A-Za-z_$][\w$]*)"
)


@dataclass
class Section:
    title: str
    text: str


@dataclass
class Document:
    source: str
    title: str
    sections: list[Section]

    @property
    def text(self) -> str:
        return "\n\n".join(section.text for section in self.sections if section.text.strip())


def emit(event_type: str, message: str = "", **details: Any) -> None:
    payload = {"type": event_type, "message": message, **details}
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def read_text_file(path: Path) -> str:
    for encoding in ("utf-8", "utf-8-sig", "cp1251"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def read_pdf(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as error:
        raise RuntimeError("Для PDF установите зависимость: pip install pypdf") from error
    reader = PdfReader(str(path))
    pages = []
    for number, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        pages.append(f"# Страница {number}\n\n{text.strip()}")
    return "\n\n".join(pages)


def discover_files(root: Path, output_root: Path) -> list[Path]:
    files: list[Path] = []
    resolved_output = output_root.resolve()
    for path in root.rglob("*"):
        if (
            not path.is_file()
            or path.suffix.lower() not in SUPPORTED_EXTENSIONS
            or path.name in EXCLUDED_FILENAMES
        ):
            continue
        if any(part in EXCLUDED_DIRECTORIES for part in path.relative_to(root).parts[:-1]):
            continue
        try:
            path.resolve().relative_to(resolved_output)
            continue
        except ValueError:
            pass
        files.append(path)
    return sorted(files, key=lambda item: item.as_posix().lower())


def split_sections(text: str, path: Path) -> list[Section]:
    lines = text.splitlines()
    boundaries: list[tuple[int, str]] = []
    suffix = path.suffix.lower()

    for index, line in enumerate(lines):
        markdown = HEADING_RE.match(line)
        if markdown:
            boundaries.append((index, markdown.group(2).strip()))
            continue
        if index + 1 < len(lines) and RST_HEADING_RE.match(lines[index + 1]):
            if line.strip():
                boundaries.append((index, line.strip()))
            continue
        if suffix in CODE_EXTENSIONS:
            code = CODE_SECTION_RE.match(line)
            if code:
                boundaries.append((index, code.group(1)))

    if not boundaries:
        return [Section("Документ", text.strip())]
    if boundaries[0][0] > 0 and "\n".join(lines[: boundaries[0][0]]).strip():
        boundaries.insert(0, (0, "Введение"))

    sections: list[Section] = []
    for position, (start, title) in enumerate(boundaries):
        end = boundaries[position + 1][0] if position + 1 < len(boundaries) else len(lines)
        section_text = "\n".join(lines[start:end]).strip()
        if section_text:
            sections.append(Section(title, section_text))
    return sections or [Section("Документ", text.strip())]


def load_documents(root: Path, output_root: Path, debug: bool) -> list[Document]:
    paths = discover_files(root, output_root)
    emit("progress", f"Найдено файлов: {len(paths)}", stage="discovery", current=0, total=len(paths))
    documents: list[Document] = []
    for index, path in enumerate(paths, start=1):
        try:
            text = read_pdf(path) if path.suffix.lower() == ".pdf" else read_text_file(path)
            text = text.replace("\x00", "").strip()
            if not text:
                if debug:
                    emit("debug", f"Пропущен пустой файл: {path}", stage="loading")
                continue
            relative = path.relative_to(root).as_posix()
            document = Document(relative, path.stem, split_sections(text, path))
            documents.append(document)
            if debug:
                emit(
                    "debug", f"Загружен {relative}", stage="loading", chars=len(text),
                    sections=len(document.sections), current=index, total=len(paths),
                )
        except Exception as error:
            emit("warning", f"Не удалось прочитать {path}: {error}", stage="loading")
    emit("progress", f"Загружено документов: {len(documents)}", stage="loading", current=len(paths), total=len(paths))
    return documents


def split_fixed(text: str, size: int, overlap: int) -> Iterable[str]:
    start = 0
    while start < len(text):
        ideal_end = min(start + size, len(text))
        end = ideal_end
        if ideal_end < len(text):
            candidates = [text.rfind("\n\n", start + size // 2, ideal_end), text.rfind(". ", start + size // 2, ideal_end)]
            boundary = max(candidates)
            if boundary > start:
                end = boundary + (2 if text[boundary: boundary + 2] in {"\n\n", ". "} else 0)
        chunk = text[start:end].strip()
        if chunk:
            yield chunk
        if end >= len(text):
            break
        start = max(start + 1, end - overlap)


def make_chunk(document: Document, section: str, text: str, strategy: str, index: int) -> dict[str, Any]:
    return {
        "faiss_id": index,
        "chunk_id": f"{strategy}_{index:06d}",
        "source": document.source,
        "title": document.title,
        "section": section,
        "strategy": strategy,
        "char_count": len(text),
        "text": text,
    }


def chunk_fixed(documents: list[Document], size: int, overlap: int) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for document in documents:
        # File boundaries are preserved; the section at the chunk start is retained as metadata.
        section_ranges: list[tuple[int, int, str]] = []
        cursor = 0
        pieces = []
        for section in document.sections:
            if pieces:
                cursor += 2
            start = cursor
            pieces.append(section.text)
            cursor += len(section.text)
            section_ranges.append((start, cursor, section.title))
        full_text = "\n\n".join(pieces)
        search_from = 0
        for text in split_fixed(full_text, size, overlap):
            position = full_text.find(text, search_from)
            if position < 0:
                position = search_from
            section_title = next((title for start, end, title in section_ranges if start <= position < end), "Документ")
            chunks.append(make_chunk(document, section_title, text, "fixed", len(chunks)))
            search_from = max(position + 1, position + len(text) - overlap)
    return chunks


def chunk_structural(documents: list[Document], size: int, overlap: int) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for document in documents:
        for section in document.sections:
            for text in split_fixed(section.text, size, overlap):
                chunks.append(make_chunk(document, section.title, text, "structural", len(chunks)))
    return chunks


def stats(chunks: list[dict[str, Any]]) -> dict[str, Any]:
    lengths = [chunk["char_count"] for chunk in chunks]
    return {
        "chunk_count": len(chunks),
        "min_chars": min(lengths, default=0),
        "max_chars": max(lengths, default=0),
        "average_chars": round(sum(lengths) / len(lengths), 2) if lengths else 0,
        "short_chunks": sum(length < 200 for length in lengths),
        "sources": len({chunk["source"] for chunk in chunks}),
        "sections": len({(chunk["source"], chunk["section"]) for chunk in chunks}),
    }


def build_index(
    chunks: list[dict[str, Any]], output_dir: Path, model_name: str, batch_size: int,
    debug: bool, model: Any, faiss: Any, np: Any,
) -> dict[str, Any]:
    strategy = chunks[0]["strategy"] if chunks else output_dir.name
    emit("progress", f"Генерация эмбеддингов: {strategy}", stage="embeddings", strategy=strategy)
    texts = [chunk["text"] for chunk in chunks]
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=debug,
        convert_to_numpy=True,
        normalize_embeddings=True,
    ).astype(np.float32)
    dimension = int(embeddings.shape[1])
    index = faiss.IndexFlatIP(dimension)
    index.add(embeddings)

    output_dir.mkdir(parents=True, exist_ok=True)
    faiss.write_index(index, str(output_dir / "index.faiss"))
    metadata = {
        "format_version": 1,
        "strategy": strategy,
        "embedding_model": model_name,
        "embedding_dimension": dimension,
        "distance_metric": "cosine_similarity_via_normalized_inner_product",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "chunk_count": len(chunks),
        "chunks": chunks,
    }
    (output_dir / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    emit("progress", f"Индекс {strategy} сохранён: {len(chunks)} чанков", stage="saving", strategy=strategy)
    return {"dimension": dimension, **stats(chunks)}


def write_comparison(output_root: Path, fixed: dict[str, Any], structural: dict[str, Any], config: dict[str, Any]) -> None:
    comparison = {
        "fixed": fixed,
        "structural": structural,
        "settings": {
            "fixed_chunk_size": config["fixedChunkSize"],
            "fixed_chunk_overlap": config["fixedChunkOverlap"],
            "structural_chunk_size": config["structuralChunkSize"],
        "embedding_model": config["modelName"],
        },
    }
    (output_root / "comparison.json").write_text(
        json.dumps(comparison, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    markdown = f"""# Сравнение стратегий chunking

| Метрика | Фиксированный размер | По структуре |
|---|---:|---:|
| Чанков | {fixed['chunk_count']} | {structural['chunk_count']} |
| Средняя длина | {fixed['average_chars']} | {structural['average_chars']} |
| Минимальная длина | {fixed['min_chars']} | {structural['min_chars']} |
| Максимальная длина | {fixed['max_chars']} | {structural['max_chars']} |
| Коротких чанков (<200) | {fixed['short_chunks']} | {structural['short_chunks']} |
| Разделов в метаданных | {fixed['sections']} | {structural['sections']} |

Фиксированная стратегия даёт более равномерные фрагменты. Структурная стратегия
сохраняет границы заголовков, разделов и файлов, поэтому метаданные точнее отражают
исходный документ, но размеры чанков менее равномерны.
"""
    (output_root / "comparison.md").write_text(markdown, encoding="utf-8")


def validate_config(config: dict[str, Any]) -> None:
    if not config.get("enabled", False):
        raise RuntimeError("Индексация выключена в настройках")
    size = int(config.get("fixedChunkSize", 1200))
    overlap = int(config.get("fixedChunkOverlap", 150))
    if size < 200:
        raise ValueError("Размер фиксированного чанка должен быть не меньше 200 символов")
    if overlap < 0 or overlap >= size:
        raise ValueError("Перекрытие должно быть неотрицательным и меньше размера чанка")
    structural_size = int(config.get("structuralChunkSize", 1600))
    if structural_size < 200 or overlap >= structural_size:
        raise ValueError("Structural-размер должен быть не меньше 200 и больше перекрытия")
    if int(config.get("batchSize", 32)) < 1:
        raise ValueError("Batch size должен быть положительным")


def run(config: dict[str, Any]) -> dict[str, Any]:
    validate_config(config)
    started = time.perf_counter()
    debug = bool(config.get("debug", False))
    root = Path(config.get("documentsPath") or ".").expanduser().resolve()
    output_root = Path(config.get("outputPath") or "document-index").expanduser()
    if not output_root.is_absolute():
        output_root = (root / output_root).resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Папка документов не найдена: {root}")
    output_root.mkdir(parents=True, exist_ok=True)

    emit("progress", f"Старт индексации: {root}", stage="start", debug=debug)
    documents = load_documents(root, output_root, debug)
    if not documents:
        raise RuntimeError("Не найдено ни одного поддерживаемого непустого документа")

    fixed_chunks = chunk_fixed(
        documents, int(config.get("fixedChunkSize", 1200)), int(config.get("fixedChunkOverlap", 150))
    )
    structural_chunks = chunk_structural(
        documents, int(config.get("structuralChunkSize", 1600)), int(config.get("fixedChunkOverlap", 150))
    )
    emit("progress", f"Chunking завершён: fixed={len(fixed_chunks)}, structural={len(structural_chunks)}", stage="chunking")

    try:
        import faiss
        import numpy as np
        from sentence_transformers import SentenceTransformer
    except ImportError as error:
        raise RuntimeError(
            "Не установлены зависимости индексации. Выполните: "
            "python -m pip install -r requirements-indexing.txt"
        ) from error
    model_name = config.get(
        "modelName", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
    )
    emit("progress", f"Загрузка модели эмбеддингов: {model_name}", stage="embeddings")
    model = SentenceTransformer(model_name)

    fixed_stats = build_index(
        fixed_chunks, output_root / "fixed", model_name,
        int(config.get("batchSize", 32)), debug, model, faiss, np,
    )
    structural_stats = build_index(
        structural_chunks, output_root / "structural", model_name,
        int(config.get("batchSize", 32)), debug, model, faiss, np,
    )
    write_comparison(output_root, fixed_stats, structural_stats, config)
    total_characters = sum(len(document.text) for document in documents)
    estimated_pages = round(total_characters / 1800, 1)
    if estimated_pages < 20:
        emit(
            "warning",
            f"Объём корпуса около {estimated_pages} страниц; для задания рекомендуется минимум 20–30",
            stage="validation",
        )
    result = {
        "success": True,
        "documents": len(documents),
        "total_characters": total_characters,
        "estimated_pages": estimated_pages,
        "output_path": str(output_root),
        "duration_seconds": round(time.perf_counter() - started, 2),
        "fixed": fixed_stats,
        "structural": structural_stats,
    }
    emit("result", "Индексация успешно завершена", **result)
    return result


def main() -> int:
    try:
        config = json.load(sys.stdin)
        run(config)
        return 0
    except Exception as error:
        emit("error", str(error), traceback=traceback.format_exc())
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
