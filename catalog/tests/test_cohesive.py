import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pack_snapshot import cohesive_text  # noqa: E402

V002_SCENES = [
    {
        "source": "content_understanding",
        "sentence": (
            "A young woman sits at a desk studying on a laptop and taking notes while "
            "on-screen Spanish text explains she's an average student with slow learning "
            "who now knows which app to use to get good grades."
        ),
    },
    {
        "source": "gemini",
        "sentence": "A student is studying at her desk while an on-screen text displays her thoughts.",
    },
]
V002_OUTCOMES = [
    {"sentence": "The narrator states they know which application to use to get better grades."},
]


def _proper(text):
    words = []
    for sentence in text.split(". "):
        for word in sentence.split()[1:]:
            bare = word.strip(".,;:\"'")
            if bare[:1].isupper():
                words.append(bare)
    return words


def _numbers(text):
    import re
    return re.findall(r"\d[\d,]*", text)


class CohesiveTextTest(unittest.TestCase):
    def test_v002_merges_duplicates_in_time_order(self):
        text = cohesive_text(V002_SCENES, V002_OUTCOMES)
        self.assertEqual(
            text,
            "A young woman sits at a desk studying on a laptop and taking notes. "
            "On-screen Spanish text explains she's an average student with slow learning "
            "who now knows which app to use to get good grades.",
        )
        self.assertNotIn("narrator", text.lower())
        self.assertNotIn("student is studying", text.lower())
        self.assertLess(text.index("young woman"), text.index("On-screen"))

    def test_no_new_number_or_proper_noun(self):
        scenes = [
            {"source": "content_understanding", "sentence": "Maya holds 2 books in Paris."},
            {"source": "gemini", "sentence": "Maya holds 2 books in Paris while smiling."},
        ]
        text = cohesive_text(scenes, [])
        source = " ".join(item["sentence"] for item in scenes)
        self.assertLessEqual(set(_numbers(text)), set(_numbers(source)))
        self.assertLessEqual(set(_proper(text)), set(_proper(source)))
        self.assertEqual(text.count("Paris"), 1)
        self.assertEqual(text.count("2"), 1)

    def test_originals_stay_unchanged_and_empty_stays_empty(self):
        scenes = [{"source": "gemini", "sentence": "A desk."}]
        outcomes = [{"sentence": "A desk."}]
        before = (scenes[0]["sentence"], outcomes[0]["sentence"])
        self.assertEqual(cohesive_text(scenes, outcomes), "A desk.")
        self.assertEqual((scenes[0]["sentence"], outcomes[0]["sentence"]), before)
        self.assertEqual(cohesive_text([], []), "")


if __name__ == "__main__":
    unittest.main()
