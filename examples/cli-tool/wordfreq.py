"""wordfreq — count the most frequent words in a text file."""
import argparse
import re
import sys
from collections import Counter

DEFAULT_TOP = 10
WORD = re.compile(r"[^\W\d_]+", re.UNICODE)


def count_words(text: str) -> Counter:
    return Counter(word.lower() for word in WORD.findall(text))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wordfreq", description="Count the most frequent words in a text file.")
    parser.add_argument("file", help="path to a UTF-8 text file, or - for stdin")
    parser.add_argument("-n", "--top", type=int, default=DEFAULT_TOP, help=f"how many words to show (default {DEFAULT_TOP})")
    args = parser.parse_args(argv)

    text = sys.stdin.read() if args.file == "-" else open(args.file, encoding="utf-8").read()
    for word, count in count_words(text).most_common(args.top):
        print(f"{count:6d}  {word}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
