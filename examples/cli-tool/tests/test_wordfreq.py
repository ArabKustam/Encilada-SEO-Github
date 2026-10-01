import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wordfreq import count_words


def test_counts_are_case_insensitive():
    assert count_words("Tea tea TEA coffee")["tea"] == 3


def test_digits_are_not_words():
    assert "42" not in count_words("42 apples")
