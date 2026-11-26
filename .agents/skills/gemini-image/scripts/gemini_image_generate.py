#!/usr/bin/env python3
"""
Minimal Google Gemini image-generation wrapper.

Calls POST /v1beta/models/{model}:generateContent with responseModalities=["TEXT","IMAGE"]
and writes any inline-image parts to disk.

Usage:
  GEMINI_API_KEY=... python3 gemini_image_generate.py \
    --prompt "Editorial overhead shot of a single matcha latte on linen" \
    --model gemini-3.1-flash-image-preview \
    --aspect-ratio 16:9 \
    --image-size 2K \
    --out-dir tmp/matcha
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import urllib.error
import urllib.request
from pathlib import Path


API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

VALID_MODELS = {
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image-preview",
    "gemini-2.5-flash-image",
}

VALID_THINKING = {"minimal", "High"}

ASPECTS_3_1_FLASH = {
    "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3",
    "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
}
ASPECTS_3_PRO_AND_2_5 = {
    "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
}

SIZES_3X = {"512", "0.5K", "1K", "2K", "4K"}
SIZES_2_5 = {"1K"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate images with Google Gemini.")
    parser.add_argument("--prompt", required=True, help="Text prompt.")
    parser.add_argument(
        "--model",
        default="gemini-3.1-flash-image-preview",
        help=f"One of: {sorted(VALID_MODELS)}",
    )
    parser.add_argument("--out-dir", type=Path, required=True, help="Directory to write images to.")
    parser.add_argument("--filename-prefix", default="image", help="Prefix for output filenames.")
    parser.add_argument("--aspect-ratio", default=None, help='e.g. "16:9", "1:1", "9:16".')
    parser.add_argument("--image-size", default=None, help='"512", "0.5K", "1K", "2K", "4K".')
    parser.add_argument(
        "--thinking-level",
        default=None,
        choices=sorted(VALID_THINKING),
        help='"minimal" or "High". Skip to use model default.',
    )
    parser.add_argument(
        "--include-thoughts",
        action="store_true",
        help="Include thought signatures in the response (tokens billed regardless).",
    )
    parser.add_argument(
        "--google-search",
        action="store_true",
        help="Enable Google Search grounding.",
    )
    parser.add_argument(
        "--system-instruction",
        default=None,
        help="Optional system instruction text.",
    )
    parser.add_argument("--print-json", action="store_true", help="Print the raw JSON response.")
    return parser.parse_args()


def get_api_key() -> str:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise SystemExit("GEMINI_API_KEY (or GOOGLE_API_KEY) is required")
    return api_key


def validate(args: argparse.Namespace) -> None:
    if args.model not in VALID_MODELS:
        raise SystemExit(f"--model must be one of {sorted(VALID_MODELS)}")
    if args.aspect_ratio is not None:
        allowed = ASPECTS_3_1_FLASH if args.model == "gemini-3.1-flash-image-preview" else ASPECTS_3_PRO_AND_2_5
        if args.aspect_ratio not in allowed:
            raise SystemExit(
                f"--aspect-ratio {args.aspect_ratio!r} not supported by {args.model}. "
                f"Allowed: {sorted(allowed)}"
            )
    if args.image_size is not None:
        allowed_sizes = SIZES_2_5 if args.model == "gemini-2.5-flash-image" else SIZES_3X
        if args.image_size not in allowed_sizes:
            raise SystemExit(
                f"--image-size {args.image_size!r} not supported by {args.model}. "
                f"Allowed: {sorted(allowed_sizes)}"
            )
        if args.image_size in {"512", "0.5K"} and args.model != "gemini-3.1-flash-image-preview":
            raise SystemExit("--image-size 512/0.5K is only supported by gemini-3.1-flash-image-preview")
    if args.thinking_level is not None and args.model == "gemini-2.5-flash-image":
        raise SystemExit("--thinking-level is not supported by gemini-2.5-flash-image")


def build_payload(args: argparse.Namespace) -> dict[str, object]:
    image_config: dict[str, str] = {}
    if args.aspect_ratio:
        image_config["aspectRatio"] = args.aspect_ratio
    if args.image_size:
        image_config["imageSize"] = args.image_size

    generation_config: dict[str, object] = {
        "responseModalities": ["TEXT", "IMAGE"],
    }
    if image_config:
        generation_config["imageConfig"] = image_config

    if args.thinking_level is not None or args.include_thoughts:
        thinking_config: dict[str, object] = {}
        if args.thinking_level is not None:
            thinking_config["thinkingLevel"] = args.thinking_level
        if args.include_thoughts:
            thinking_config["includeThoughts"] = True
        generation_config["thinkingConfig"] = thinking_config

    payload: dict[str, object] = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": args.prompt}],
            }
        ],
        "generationConfig": generation_config,
    }

    if args.system_instruction:
        payload["systemInstruction"] = {
            "parts": [{"text": args.system_instruction}],
        }

    if args.google_search:
        payload["tools"] = [{"google_search": {}}]

    return payload


def send_request(api_key: str, model: str, payload: dict[str, object]) -> dict[str, object]:
    url = f"{API_BASE}/{model}:generateContent"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "x-goog-api-key": api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Gemini API error {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"Network error: {exc}") from exc
    return json.loads(body)


def suffix_for_mime(mime_type: str) -> str:
    guessed = mimetypes.guess_extension(mime_type)
    if guessed:
        return guessed
    if mime_type.startswith("image/"):
        return f".{mime_type.split('/', 1)[1]}"
    return ".bin"


def write_images(
    response: dict[str, object],
    out_dir: Path,
    filename_prefix: str,
) -> list[Path]:
    candidates = response.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise SystemExit("No candidates returned by the API")

    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    image_index = 0

    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content")
        if not isinstance(content, dict):
            continue
        parts = content.get("parts")
        if not isinstance(parts, list):
            continue
        for part in parts:
            if not isinstance(part, dict):
                continue
            inline = part.get("inlineData") or part.get("inline_data")
            if not isinstance(inline, dict):
                continue
            data = inline.get("data")
            mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
            if not isinstance(data, str):
                continue
            image_index += 1
            extension = suffix_for_mime(mime)
            path = out_dir / f"{filename_prefix}-{image_index}{extension}"
            path.write_bytes(base64.b64decode(data))
            written.append(path)

    if not written:
        raise SystemExit("Response did not contain any inline image parts")
    return written


def main() -> None:
    args = parse_args()
    validate(args)
    api_key = get_api_key()
    payload = build_payload(args)
    response = send_request(api_key, args.model, payload)
    written = write_images(response, args.out_dir, args.filename_prefix)

    if args.print_json:
        print(json.dumps(response, indent=2))

    for path in written:
        print(path)


if __name__ == "__main__":
    main()
