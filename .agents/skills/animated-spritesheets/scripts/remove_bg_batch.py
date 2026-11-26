#!/usr/bin/env -S uv run
# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.32.0"]
# ///
from __future__ import annotations

import argparse
import os
from pathlib import Path
import requests


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Batch remove backgrounds from PNGs using remove.bg.")
    parser.add_argument("--input-dir", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--glob", default="*.png")
    parser.add_argument("--api-key-env", default="REMOVE_BG_API_KEY")
    parser.add_argument("--size", default="auto")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    api_key = os.environ.get(args.api_key_env)
    if not api_key:
        raise SystemExit(f"Missing API key env var: {args.api_key_env}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    matched = sorted(args.input_dir.glob(args.glob))
    if not matched:
        raise SystemExit(f"No files matched {args.glob} in {args.input_dir}")

    for src in matched:
        out = args.out_dir / f"{src.stem}-no-bg.png"
        with src.open("rb") as handle:
            response = requests.post(
                "https://api.remove.bg/v1.0/removebg",
                headers={"X-Api-Key": api_key},
                files={"image_file": handle},
                data={"size": args.size},
                timeout=300,
            )
        response.raise_for_status()
        out.write_bytes(response.content)
        print(out)


if __name__ == "__main__":
    main()
