import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts" / "document_indexer.py"
SPEC = importlib.util.spec_from_file_location("document_indexer", SCRIPT)
indexer = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = indexer
SPEC.loader.exec_module(indexer)


class DocumentIndexerTests(unittest.TestCase):
    def test_structural_chunking_preserves_section_metadata(self):
        document = indexer.Document(
            "guide.md",
            "guide",
            [
                indexer.Section("Введение", "# Введение\n" + "Первый раздел. " * 20),
                indexer.Section("Установка", "## Установка\n" + "Второй раздел. " * 20),
            ],
        )
        chunks = indexer.chunk_structural([document], 220, 30)
        self.assertGreaterEqual(len(chunks), 2)
        self.assertEqual({chunk["section"] for chunk in chunks}, {"Введение", "Установка"})
        self.assertEqual([chunk["faiss_id"] for chunk in chunks], list(range(len(chunks))))
        self.assertTrue(all(chunk["chunk_id"].startswith("structural_") for chunk in chunks))

    def test_fixed_chunking_respects_size_and_overlap(self):
        chunks = list(indexer.split_fixed("Предложение. " * 100, 240, 40))
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(0 < len(chunk) <= 240 for chunk in chunks))

    def test_discovery_excludes_generated_and_dependency_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "README.md").write_text("text", encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "ignored.js").write_text("text", encoding="utf-8")
            (root / "pnpm-lock.yaml").write_text("lockfileVersion: 9", encoding="utf-8")
            output = root / "custom-output"
            output.mkdir()
            (output / "ignored.md").write_text("text", encoding="utf-8")
            files = indexer.discover_files(root, output)
            self.assertEqual([path.name for path in files], ["README.md"])


if __name__ == "__main__":
    unittest.main()
