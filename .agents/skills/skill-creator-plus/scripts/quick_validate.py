#!/usr/bin/env python3
import json
import re
import sys
from pathlib import Path

from init_skill import DEFERRED, NAME

PLAIN_SCALAR_START_FORBIDDEN = tuple("[]{}&*!|>%@`#,?-'\"")
PLAIN_NULL = re.compile(r"^(?:~|null|Null|NULL)$")
PLAIN_BOOLEAN = re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$")
PLAIN_INTEGER = re.compile(r"^[-+]?(?:0|[1-9][0-9]*|0o[0-7]+|0x[0-9a-fA-F]+)$")
PLAIN_FLOAT = re.compile(r"^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$")


def parse_scalar(value):
    if value.startswith('"'):
        parsed = json.loads(value)
        if not isinstance(parsed, str):
            raise ValueError("quoted value is not a string")
        return parsed
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            raise ValueError("unterminated single-quoted value")
        inner = value[1:-1]
        if "'" in inner.replace("''", ""):
            raise ValueError("unescaped single quote")
        return inner.replace("''", "'")
    if value.startswith(PLAIN_SCALAR_START_FORBIDDEN) or ": " in value or " #" in value:
        raise ValueError(f"unsupported value: {value}")
    if PLAIN_NULL.match(value):
        return None
    if PLAIN_BOOLEAN.match(value):
        return value.lower() == "true"
    if PLAIN_INTEGER.match(value):
        return int(value, 0)
    if PLAIN_FLOAT.match(value):
        return float(value)
    return value


def parse_sequence(lines, index, indent):
    items = []
    while index < len(lines) and lines[index][0] == indent and lines[index][1].startswith("- "):
        items.append(parse_scalar(lines[index][1][2:].strip()))
        index += 1
    return items, index


def parse_mapping(lines, index, indent):
    mapping = {}
    while index < len(lines) and lines[index][0] == indent:
        text = lines[index][1]
        key, separator, value = text.partition(":")
        key = key.strip()
        value = value.strip()
        if text.startswith("- ") or not separator or not key:
            raise ValueError(f"expected a key and value: {text}")
        if key in mapping:
            raise ValueError(f"duplicate key: {key}")
        index += 1
        following = lines[index] if index < len(lines) else None
        if value:
            mapping[key] = parse_scalar(value)
        elif following and following[0] >= indent and following[1].startswith("- "):
            mapping[key], index = parse_sequence(lines, index, following[0])
        elif following and following[0] > indent:
            mapping[key], index = parse_mapping(lines, index, following[0])
        else:
            mapping[key] = None
    if index < len(lines) and lines[index][0] > indent:
        raise ValueError(f"unexpected indentation: {lines[index][1]}")
    return mapping, index


def parse_frontmatter(text):
    lines = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        content = line.lstrip(" ")
        if content.startswith("\t"):
            raise ValueError("tabs cannot indent frontmatter")
        lines.append((len(line) - len(content), content.rstrip()))
    if lines and lines[0][0] != 0:
        raise ValueError(f"unexpected indentation: {lines[0][1]}")
    frontmatter, index = parse_mapping(lines, 0, 0)
    if index != len(lines):
        raise ValueError(f"unexpected indentation: {lines[index][1]}")
    return frontmatter


def validate_skill(skill_path):
    directory = Path(skill_path)
    skill = directory / "SKILL.md"
    if not skill.is_file():
        return False, "SKILL.md not found"
    content = skill.read_text(encoding="utf-8")
    match = re.match(r"^---\r?\n(.*?)\r?\n---(?:\r?\n|$)", content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"
    frontmatter_text = match.group(1)
    if re.search(r"(?m)^description:\s*[>|]-?\s*$", frontmatter_text):
        return False, "Description must use an inline string value"
    try:
        frontmatter = parse_frontmatter(frontmatter_text)
    except ValueError as error:
        return False, f"Invalid YAML in frontmatter: {error}"
    allowed = {"name", "description", "license", "allowed-tools", "metadata"}
    unexpected = set(frontmatter) - allowed
    if unexpected:
        return False, f"Unexpected frontmatter keys: {', '.join(sorted(unexpected))}"
    name = frontmatter.get("name")
    if not isinstance(name, str) or not NAME.fullmatch(name) or len(name) > 64:
        return False, "Name must be nonempty hyphen-case and at most 64 characters"
    if name != directory.name:
        return False, "Name must match the skill directory"
    description = frontmatter.get("description")
    if (
        not isinstance(description, str)
        or not description.strip()
        or len(description) > 1024
        or "\n" in description
        or "\r" in description
    ):
        return False, "Description must be nonempty and at most 1024 characters"
    if "<" in description or ">" in description:
        return False, "Description cannot contain angle brackets"
    instructions = content[match.end():].strip()
    if not instructions or DEFERRED.search(description) or DEFERRED.search(instructions):
        return False, "Complete instructions and description are required"
    return True, "Skill is valid!"


def main():
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>", file=sys.stderr)
        return 1
    valid, message = validate_skill(sys.argv[1])
    print(message)
    return 0 if valid else 1


if __name__ == "__main__":
    sys.exit(main())
