#!/usr/bin/env python3
import argparse
import fnmatch
import os
import sys
import zipfile
from pathlib import Path


DEFAULT_EXCLUDES = [
    ".git/**",
    ".gitignore",
    ".DS_Store",
    "**/.DS_Store",
    "*.swp",
    "*.swo",
    "**/*.swp",
    "**/*.swo",
    "__pycache__/**",
    "**/__pycache__/**",
    "node_modules/**",
    "**/node_modules/**",
    "dist/**",
    "build/**",
    ".idea/**",
    ".vscode/**",
]


def iter_files(root: Path) -> list[Path]:
    return sorted([p for p in root.rglob("*") if p.is_file()], key=lambda p: p.as_posix())


def is_excluded(rel_posix: str, patterns: list[str]) -> bool:
    # Use forward slashes for matching and ensure directories can be excluded via /** patterns.
    for pattern in patterns:
        if fnmatch.fnmatch(rel_posix, pattern):
            return True
    return False


def make_love(src: Path, out: Path, excludes: list[str]) -> int:
    if not src.exists() or not src.is_dir():
        print(f"error: --src must be an existing directory: {src}", file=sys.stderr)
        return 2

    out.parent.mkdir(parents=True, exist_ok=True)

    # Write to temp then replace for safer updates.
    tmp_out = out.with_suffix(out.suffix + ".tmp")
    if tmp_out.exists():
        tmp_out.unlink()

    files = iter_files(src)
    if not files:
        print(f"error: no files found under: {src}", file=sys.stderr)
        return 2

    written = 0
    with zipfile.ZipFile(tmp_out, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for file_path in files:
            rel_path = file_path.relative_to(src)
            rel_posix = rel_path.as_posix()

            if is_excluded(rel_posix, excludes):
                continue

            # Normalize permissions a bit (helps when building on different machines).
            zi = zipfile.ZipInfo(rel_posix)
            mode = file_path.stat().st_mode
            zi.external_attr = (mode & 0o777) << 16

            with file_path.open("rb") as f:
                zf.writestr(zi, f.read())
            written += 1

    if written == 0:
        print("error: all files were excluded; nothing to package", file=sys.stderr)
        tmp_out.unlink(missing_ok=True)
        return 2

    tmp_out.replace(out)
    print(f"wrote {written} files -> {out}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Build a Love2D .love archive (zip) from a source directory.")
    parser.add_argument("--src", required=True, help="Path to Love2D game directory (contains main.lua).")
    parser.add_argument("--out", required=True, help="Output .love path (a .zip with .love extension).")
    parser.add_argument(
        "--exclude",
        action="append",
        default=[],
        help="Exclude glob pattern (repeatable). Patterns match paths relative to --src using forward slashes.",
    )
    args = parser.parse_args()

    src = Path(args.src).expanduser().resolve()
    out = Path(args.out).expanduser().resolve()

    excludes = DEFAULT_EXCLUDES + list(args.exclude or [])

    # Common case: out is inside src; ensure we don't include it.
    try:
        rel_out = out.relative_to(src).as_posix()
        excludes.append(rel_out)
    except ValueError:
        pass

    # Ensure consistent separators on Windows paths (if any).
    excludes = [p.replace(os.sep, "/") for p in excludes]

    return make_love(src=src, out=out, excludes=excludes)


if __name__ == "__main__":
    raise SystemExit(main())
