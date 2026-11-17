#!/usr/bin/env python3
import re
import sys
from pathlib import Path

import yaml
from init_skill import DEFERRED, NAME


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
        frontmatter = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError as error:
        return False, f"Invalid YAML in frontmatter: {error}"
    if not isinstance(frontmatter, dict):
        return False, "Frontmatter must be a YAML dictionary"
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
