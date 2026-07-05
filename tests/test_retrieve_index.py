import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "retrieve_index.py"
SPEC = importlib.util.spec_from_file_location("retrieve_index", SCRIPT)
retriever = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = retriever
SPEC.loader.exec_module(retriever)


class RetrieveIndexTests(unittest.TestCase):
    def test_filter_reports_before_and_after_counts(self):
        chunks = [
            {
                "chunk_id": f"chunk_{index}",
                "source": "guide.md",
                "section": "RAG",
                "text": f"text {index}",
            }
            for index in range(5)
        ]

        result = retriever.filter_candidates(
            [0.91, 0.72, 0.49, 0.24, 0.10],
            [0, 1, 2, 3, 4],
            chunks,
            min_score=0.25,
            final_top_k=2,
        )

        self.assertEqual(result["candidateCount"], 5)
        self.assertEqual(result["passedCount"], 3)
        self.assertEqual(result["rejectedCount"], 2)
        self.assertEqual(len(result["chunks"]), 2)
        self.assertEqual(
            [chunk["citationId"] for chunk in result["chunks"]], ["S1", "S2"]
        )

    def test_filter_can_return_empty_context(self):
        result = retriever.filter_candidates(
            [0.20, 0.10],
            [0, 1],
            [{"text": "a"}, {"text": "b"}],
            min_score=0.30,
            final_top_k=5,
        )

        self.assertEqual(result["passedCount"], 0)
        self.assertEqual(result["rejectedCount"], 2)
        self.assertEqual(result["chunks"], [])

    def test_disabled_filter_keeps_low_score_candidates(self):
        result = retriever.filter_candidates(
            [0.20, 0.10],
            [0, 1],
            [{"text": "a"}, {"text": "b"}],
            min_score=0.30,
            final_top_k=2,
            filter_enabled=False,
        )

        self.assertEqual(result["passedCount"], 2)
        self.assertEqual(result["rejectedCount"], 0)
        self.assertEqual(len(result["chunks"]), 2)


if __name__ == "__main__":
    unittest.main()
