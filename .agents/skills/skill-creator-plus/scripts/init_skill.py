#!/usr/bin/env python3
import argparse
import json
import re
import sys
from pathlib import Path

NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DEFERRED = re.compile(
    r"(?im)(?:\[(?:TODO|FIXME|TBD|HACK|XXX)\b|^\s*(?:#{1,6}\s*)?"
    r"(?:TODO|FIXME|TBD|HACK|XXX)(?:\s*[:\-]|\s*$|\s+(?:implement|complete|fill|add|replace|fix|write)\b))"
)


def create_skill(name: str, destination: Path, description: str, instructions: str) -> Path:
    if not NAME.fullmatch(name) or len(name) > 64:
        raise ValueError("skill name must be hyphen-case and at most 64 characters")
    description = description.strip()
    instructions = instructions.strip()
    if not description or len(description) > 1024 or "\n" in description or "\r" in description:
        raise ValueError("description must be a single nonempty line of at most 1024 characters")
    if "<" in description or ">" in description:
        raise ValueError("description cannot contain angle brackets")
    if not instructions or DEFERRED.search(description) or DEFERRED.search(instructions):
        raise ValueError("complete instructions and description are required")

    directory = destination.resolve() / name
    if directory.exists():
        raise ValueError("skill directory already exists")
    title = " ".join(part.capitalize() for part in name.split("-"))
    content = (
        f"---\nname: {name}\ndescription: {json.dumps(description, ensure_ascii=False)}\n---\n\n"
        f"# {title}\n\nFollow the repository rules in `AGENTS.md`.\n\n{instructions}\n"
    )
    directory.mkdir(parents=True, exist_ok=False)
    target = directory / "SKILL.md"
    try:
        target.write_text(content, encoding="utf-8")
    except OSError:
        target.unlink(missing_ok=True)
        directory.rmdir()
        raise
    return directory


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a complete repository skill")
    parser.add_argument("name")
    parser.add_argument("--path", required=True, type=Path)
    parser.add_argument("--description", required=True)
    parser.add_argument("--instructions-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        instructions = args.instructions_file.read_text(encoding="utf-8")
        directory = create_skill(args.name, args.path, args.description, instructions)
    except (OSError, UnicodeError, ValueError) as error:
        print(f"Cannot create skill: {error}", file=sys.stderr)
        return 1
    print(f"Created {directory}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
