#!/usr/bin/env python3
"""Use Ubuntu's official archive for the CI runner's known slow Azure mirror.

Only repository URI tokens are changed; suites, components, signatures and
unrelated repositories remain byte-for-byte intact. No package install occurs.
"""

import argparse
from pathlib import Path
import re


AZURE_URI = re.compile(r"https?://azure\.archive\.ubuntu\.com/ubuntu/?\Z")
OFFICIAL_URI = "https://archive.ubuntu.com/ubuntu"
# GitHub runner images route Ubuntu through this priority-ordered list.
# Match the URI itself, never follow an arbitrary mirror+file path.
RUNNER_MIRROR_URI = "mirror+file:/etc/apt/apt-mirrors.txt"


def replace_uri(token):
    if token == RUNNER_MIRROR_URI:
        return OFFICIAL_URI
    return OFFICIAL_URI + ("/" if token.endswith("/") else "") if AZURE_URI.fullmatch(token) else token


def rewrite_sources(text, deb822):
    lines = []
    uri_field = False
    for line in text.splitlines(keepends=True):
        if not line.strip():
            uri_field = False
        elif not line.lstrip().startswith("#"):
            if deb822:
                field = re.match(r"^([A-Za-z][A-Za-z0-9-]*):", line)
                if field:
                    uri_field = field.group(1).lower() == "uris"
                if uri_field and (field or line[:1].isspace()):
                    line = re.sub(r"\S+", lambda match: replace_uri(match.group()), line)
            else:
                entry = re.match(r"^(\s*deb(?:-src)?\s+(?:\[[^\]\r\n]*\]\s+)?)(\S+)", line)
                if entry:
                    line = line[:entry.start(2)] + replace_uri(entry.group(2)) + line[entry.end(2):]
        lines.append(line)
    return "".join(lines)


def prepare(apt_dir):
    files = [apt_dir / "sources.list"]
    directory = apt_dir / "sources.list.d"
    files += sorted(directory.glob("*.list")) + sorted(directory.glob("*.sources"))
    changed = 0
    for path in files:
        if path.is_symlink() or not path.is_file():
            continue
        original = path.read_bytes()
        updated = rewrite_sources(original.decode("utf-8"), path.suffix == ".sources").encode("utf-8")
        if updated != original:
            path.write_bytes(updated)
            changed += 1
    return changed


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apt-dir", type=Path, default=Path("/etc/apt"))
    args = parser.parse_args()
    print(f"Browser dependency APT preparation: {prepare(args.apt_dir)} source file(s) updated")
