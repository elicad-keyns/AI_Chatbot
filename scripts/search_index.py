"""Small CLI for verifying and exploring a generated document index."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Поиск по локальному FAISS-индексу")
    parser.add_argument("query", help="Текст поискового запроса")
    parser.add_argument("--index", default="document-index", help="Корневая папка индекса")
    parser.add_argument("--strategy", choices=("fixed", "structural"), default="structural")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()

    import faiss
    from sentence_transformers import SentenceTransformer

    directory = Path(args.index) / args.strategy
    metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    index = faiss.read_index(str(directory / "index.faiss"))
    if index.ntotal != len(metadata["chunks"]):
        raise RuntimeError("FAISS и metadata.json содержат разное число элементов")

    model = SentenceTransformer(metadata["embedding_model"])
    query_vector = model.encode([args.query], normalize_embeddings=True)
    scores, identifiers = index.search(query_vector, min(args.top_k, index.ntotal))
    for rank, (score, identifier) in enumerate(zip(scores[0], identifiers[0]), start=1):
        chunk = metadata["chunks"][int(identifier)]
        preview = " ".join(chunk["text"].split())[:240]
        print(
            f"{rank}. score={score:.4f} | {chunk['source']} | {chunk['section']}\n"
            f"   {preview}\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
