"""Machine-readable local FAISS retrieval used by the Tauri RAG pipeline."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path


def main() -> int:
    started = time.perf_counter()
    config = json.load(sys.stdin)
    index_dir = Path(config["indexPath"])
    metadata_path = index_dir / "metadata.json"
    faiss_path = index_dir / "index.faiss"
    if not metadata_path.is_file() or not faiss_path.is_file():
        raise FileNotFoundError(f"Индекс не найден: {index_dir}")

    import faiss
    from sentence_transformers import SentenceTransformer

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    index = faiss.read_index(str(faiss_path))
    chunks = metadata.get("chunks", [])
    if index.ntotal != len(chunks):
        raise RuntimeError(
            f"FAISS содержит {index.ntotal} векторов, metadata.json — {len(chunks)} чанков"
        )

    query = str(config.get("query", "")).strip()
    if not query:
        raise ValueError("Пустой RAG-запрос")
    top_k = max(1, min(int(config.get("topK", 5)), 20))
    min_score = float(config.get("minScore", 0.25))
    model = SentenceTransformer(metadata["embedding_model"])
    query_vector = model.encode(
        [query], convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False
    )

    candidate_count = min(index.ntotal, max(top_k * 4, top_k))
    scores, identifiers = index.search(query_vector, candidate_count)
    results = []
    for score, identifier in zip(scores[0], identifiers[0]):
        identifier = int(identifier)
        score = float(score)
        if identifier < 0 or score < min_score:
            continue
        chunk = chunks[identifier]
        results.append(
            {
                "citationId": f"S{len(results) + 1}",
                "faissId": identifier,
                "chunkId": str(chunk.get("chunk_id", f"chunk_{identifier}")),
                "source": str(chunk.get("source", "unknown")),
                "title": str(chunk.get("title", "")),
                "section": str(chunk.get("section", "Документ")),
                "score": score,
                "text": str(chunk.get("text", "")),
            }
        )
        if len(results) >= top_k:
            break

    print(
        json.dumps(
            {
                "strategy": metadata.get("strategy", index_dir.name),
                "query": query,
                "indexPath": str(index_dir.resolve()),
                "retrievalMs": round((time.perf_counter() - started) * 1000),
                "chunks": results,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
        raise SystemExit(1)
