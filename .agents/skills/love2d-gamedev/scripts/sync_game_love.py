#!/usr/bin/env python3
import argparse
import shutil
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Copy a built game.love into an iOS/Xcode resources folder (or any destination)."
    )
    parser.add_argument("--love", required=True, help="Path to the .love file to copy.")
    parser.add_argument(
        "--dest",
        required=True,
        help="Destination directory (recommended) or destination file path.",
    )
    parser.add_argument(
        "--name",
        default=None,
        help="Optional destination filename (defaults to source filename). Only used when --dest is a directory.",
    )
    parser.add_argument(
        "--mkdir",
        action="store_true",
        help="Create destination directory if it doesn't exist.",
    )
    args = parser.parse_args()

    love_path = Path(args.love).expanduser().resolve()
    if not love_path.exists() or not love_path.is_file():
        print(f"error: --love must be an existing file: {love_path}", file=sys.stderr)
        return 2

    dest = Path(args.dest).expanduser().resolve()
    dest_is_dir = dest.exists() and dest.is_dir()
    if not dest.exists():
        if dest.suffix:
            dest_is_dir = False
        else:
            dest_is_dir = True
            if args.mkdir:
                dest.mkdir(parents=True, exist_ok=True)

    if dest_is_dir:
        if not dest.exists():
            print(
                f"error: destination directory does not exist (use --mkdir): {dest}",
                file=sys.stderr,
            )
            return 2
        out_path = dest / (args.name or love_path.name)
    else:
        out_path = dest
        out_path.parent.mkdir(parents=True, exist_ok=True)

    shutil.copy2(love_path, out_path)
    print(f"copied {love_path} -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
