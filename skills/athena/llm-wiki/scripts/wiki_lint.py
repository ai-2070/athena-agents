#!/usr/bin/env python3
"""Check a Markdown wiki kept with the llm-wiki skill, and fingerprint its raw sources.

    python wiki_lint.py check <wiki folder> [--skip FOLDER] [--raw FOLDER] [--require FIELDS] [--limit N]
    python wiki_lint.py hash <file> [<file> ...]

Standard library only, Python 3.11 or newer.

check reads index.md and every page (each .md file except those in the raw folder, dot folders and --skip folders,
and the root's SCHEMA.md, index.md, log.md and log-*.md) and prints what it found as JSON:

  problems (exit code 1 when there is any)
    missing_files    SCHEMA.md, index.md or log.md isn't at the wiki's root
    broken_links     a [[wikilink]], relative Markdown link, or sources:/contradictions: name that leads nowhere:
                     no such file, a name that differs only in case, a bare name several files share, or a path
                     outside the wiki
    orphans          pages no other page links to (links from index.md and the log don't count)
    not_in_index     pages index.md doesn't link to
    missing_fields   pages with no frontmatter, without a field --require names, or with raw: but no sha256:
    unknown_tags     tags missing from the Tags section of SCHEMA.md, or that Obsidian can't read as tags
    raw_missing      a page's raw: field names a file that isn't there
    raw_changed      a raw file whose SHA-256 no longer matches the sha256: its page recorded
    not_utf8         pages saved in an encoding other than UTF-8
  review (listed for a person to look at; never a problem)
    contested        pages marked contested: true or listing contradictions:
    low_confidence   pages marked confidence: low
    not_ingested     files in the raw folder that no page's raw: field names and nothing links to
    same_name        file names more than one page uses

Links in code, HTML comments and %% comments are left out, and so are tags written in the text with #.
hash prints the SHA-256 of each file, for a source page's sha256: field.

Exit codes: 0 done (check: no problems); 1 check ran and found problems, which stdout's JSON lists; 2 it couldn't
run, with one line on stderr saying why. Neither command changes any file.
"""

from __future__ import annotations

import argparse
import codecs
import hashlib
import json
import locale
import os
import posixpath
import re
import sys
import unicodedata
from typing import Any, Callable, NoReturn
from urllib.parse import unquote

SPECIAL = {"schema.md", "index.md", "log.md"}
LOG_ARCHIVE = re.compile(r"^log-.+\.md$", re.IGNORECASE)

HOW_TO_FIX = {
    "missing_files": "create it from references/templates.md: the wiki's conventions, catalogue and history live there",
    "broken_links": "point the link at the page's real name (search for it), write the folder when two files share a "
                    "name, or remove the link; a page worth having can be written instead",
    "orphans": "link the page from the pages it relates to (a source page from the pages that use it), "
               "or ask the user whether it still belongs",
    "not_in_index": "add a line for it to index.md under its type, with a one-line summary",
    "missing_fields": "add the frontmatter fields SCHEMA.md asks for; a page with raw: needs the sha256: that "
                      "'wiki_lint.py hash' prints for the file",
    "unknown_tags": "use a tag from SCHEMA.md's list, or add the tag there first (with the user, if they keep "
                    "the list); tags need a letter and no spaces",
    "raw_missing": "find the file (renamed or moved?) and fix the raw: path, or tell the user the source is gone",
    "raw_changed": "the source changed after it was ingested: compare it with the page, update what changed, then "
                   "record the new sha256 and say so in the log",
    "not_utf8": "save the page again as UTF-8 with your file tools (PowerShell's > writes UTF-16)",
}


# ---------------------------------------------------------------- helpers


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; page names and tags often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], int]) -> int:
    """Run a command, and turn whatever stops it into one line on stderr and exit code 2, never a traceback."""
    try:
        return job()
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file another program holds, a folder where a file should be
        where = e.filename2 or e.filename
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
    except Exception as e:
        why = f"stopped unexpectedly ({type(e).__name__}: {e})"
    print(f"{prog}: " + " ".join(why.split()), file=sys.stderr)
    return 2


def decode(raw: bytes) -> tuple[str, str]:
    """The text of a file and the encoding it was read in, whichever way Windows PowerShell 5.1 wrote it: > and
    Out-File write UTF-16, Set-Content the ANSI code page, -Encoding utf8 UTF-8 with a byte-order mark."""
    if raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return raw.decode("utf-16", "replace"), "utf-16"
    try:
        return raw.decode("utf-8-sig"), "utf-8"
    except UnicodeDecodeError:
        ansi = locale.getpreferredencoding(False)
        if codecs.lookup(ansi).name == "utf-8":
            ansi = "cp1252"  # not this machine's code page, so most likely Windows' Western European one
        return raw.decode(ansi, "replace"), ansi


def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def positive(value: str) -> int:
    try:
        n = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} isn't a whole number") from None
    if n < 1:
        raise argparse.ArgumentTypeError("must be 1 or more")
    return n


# ---------------------------------------------------------------- reading pages


def unquote_yaml(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        return value[1:-1]
    return value


def split_inline_list(inner: str) -> list[str]:
    items, current, quote = [], "", ""
    for ch in inner:
        if quote:
            current += ch
            if ch == quote:
                quote = ""
        elif ch in "'\"":
            quote = ch
            current += ch
        elif ch == ",":
            items.append(current)
            current = ""
        else:
            current += ch
    items.append(current)
    return [unquote_yaml(i) for i in items if i.strip()]


def yaml_value(value: str) -> Any:
    """A scalar or an inline [a, b] list; enough of YAML for the fields this script reads."""
    if value[:1] not in "'\"" and " #" in value:
        value = value.split(" #", 1)[0].rstrip()  # a comment after the value
    if re.fullmatch(r"\[\[[^\[\]]*\]\]", value):
        return value  # an unquoted [[link]]: YAML would read a nested list, Obsidian wants quotes; take it as meant
    if value.startswith("[") and value.endswith("]"):
        return split_inline_list(value[1:-1])
    return unquote_yaml(value)


def frontmatter(text: str) -> tuple[dict[str, Any] | None, str | None]:
    """The page's frontmatter as {key: str | list | None}, or None with the reason there isn't any."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, "no frontmatter"
    end = next((i for i in range(1, len(lines)) if lines[i].strip() in ("---", "...")), None)
    if end is None:
        return None, "the frontmatter has no closing ---"
    data: dict[str, Any] = {}
    key = None
    for line in lines[1:end]:
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([^\s:#-][^:]*?)\s*:(?:\s+(.*))?$", line)
        if m and not line[0].isspace():
            key = m.group(1)
            rest = (m.group(2) or "").strip()
            data[key] = yaml_value(rest) if rest else None
            continue
        item = re.match(r"^\s*-(?:\s+(.*))?$", line)
        if item and key is not None:
            if not isinstance(data[key], list):
                data[key] = []
            if item.group(1) and item.group(1).strip():
                data[key].append(unquote_yaml(item.group(1)))
        # anything else (nested mappings, folded text) isn't needed here
    return data, None


def as_list(value: Any, commas: bool = False) -> list[str]:
    """A field's values: a list as it is, a single value as a list of one (split at commas when asked)."""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    parts = str(value).split(",") if commas else [str(value)]
    return [v.strip() for v in parts if v.strip()]


def blank(match: re.Match) -> str:
    """The same length of spaces, keeping line breaks, so positions and line numbers still match the file."""
    return re.sub(r"[^\n]", " ", match.group(0))


FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")


def without_fences(text: str) -> str:
    """The text with fenced code blocks blanked out, line for line."""
    out, fence = [], ""
    for line in text.split("\n"):
        m = FENCE.match(line)
        if fence:
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not m.group(2).strip():
                fence = ""
            out.append(" " * len(line))
        elif m:
            fence = m.group(1)
            out.append(" " * len(line))
        else:
            out.append(line)
    return "\n".join(out)


def without_code(text: str) -> str:
    """The text with fenced and inline code, HTML comments and Obsidian's %% comments blanked out."""
    text = re.sub(r"<!--.*?-->", blank, without_fences(text), flags=re.DOTALL)
    text = re.sub(r"%%.*?%%", blank, text, flags=re.DOTALL)
    return re.sub(r"(?<!`)(`+)(?!`).+?(?<!`)\1(?!`)", blank, text)


WIKILINK = re.compile(r"!?\[\[([^\[\]\n]+?)\]\]")
MDLINK = re.compile(r"!?\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+[\"'(][^)\n]*)?\s*\)")
SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:|^//")


def wikilink_target(inner: str) -> str:
    target = inner.split("|", 1)[0].rstrip("\\")  # [[page\|text]] inside a table
    return target.split("#", 1)[0].strip()


class Vault:
    """Every file in the wiki, for resolving links the way Obsidian and Markdown viewers would."""

    def __init__(self, files: list[str]) -> None:
        self.files = set(files)
        self.lower: dict[str, list[str]] = {}
        self.names: dict[str, list[str]] = {}
        self.names_lower: dict[str, list[str]] = {}
        for f in files:
            name = posixpath.basename(f)
            self.lower.setdefault(f.lower(), []).append(f)
            self.names.setdefault(name, []).append(f)
            self.names_lower.setdefault(name.lower(), []).append(f)

    def _exact(self, name: str) -> list[str]:
        if "/" not in name:
            return self.names.get(name, [])
        if name in self.files:
            return [name]
        return sorted(f for f in self.files if f.endswith("/" + name))

    def _folded(self, name: str) -> list[str]:
        low = name.lower()
        if "/" not in low:
            return self.names_lower.get(low, [])
        return sorted(f for f in self.files if f.lower() == low or f.lower().endswith("/" + low))

    def by_name(self, target: str) -> tuple[str | None, str | None]:
        """Resolve [[target]]: a name anywhere in the wiki, or a path from its root. (file, None) or (None, why)."""
        t = target.replace("\\", "/").lstrip("/")
        tries = [t] if t.lower().endswith(".md") else [t + ".md", t]
        for name in tries:
            found = self._exact(name)
            if len(found) == 1:
                return found[0], None
            if found:
                return None, f"{len(found)} files have this name ({', '.join(sorted(found))}): add the folder"
        for name in tries:
            folded = self._folded(name)
            if folded:
                return None, f"differs only in case from {', '.join(sorted(folded))} (Linux and GitHub won't open it)"
        return None, "no such page or file"

    def by_path(self, target: str, page: str) -> tuple[str | None, str | None]:
        """Resolve a Markdown link's target: relative to the page, then from the wiki's root, then by name."""
        t = unquote(target.strip("<>").split("#", 1)[0].split("?", 1)[0]).replace("\\", "/")
        if not t:
            return None, None
        here = posixpath.dirname(page)
        relative = posixpath.normpath(posixpath.join(here, t))
        if relative == ".." or relative.startswith("../"):
            return None, "points outside the wiki"
        for path in (relative, relative + ".md", posixpath.normpath(t.lstrip("/")), posixpath.normpath(t.lstrip("/")) + ".md"):
            if path in self.files:
                return path, None
        found, why = self.by_name(t)
        if found:
            return found, None
        folded = self.lower.get(relative.lower()) or self.lower.get(relative.lower() + ".md")
        if folded:
            return None, f"differs only in case from {', '.join(sorted(folded))} (Linux and GitHub won't open it)"
        return None, why


# ---------------------------------------------------------------- check


HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")


def schema_tags(text: str) -> set[str] | None:
    """The tags in backticks on the list lines of SCHEMA.md's Tags section, or None when there's no such section."""
    lines = without_fences(text).split("\n")
    start, level, end = None, 0, len(lines)
    for i, line in enumerate(lines):
        m = HEADING.match(line)
        if not m:
            continue
        if start is None:
            if re.match(r"tags\b", m.group(2), re.IGNORECASE):
                start, level = i + 1, len(m.group(1))
        elif len(m.group(1)) <= level:
            end = i
            break
    if start is None:
        return None
    tags: set[str] = set()
    for line in lines[start:end]:
        if re.match(r"^\s*(?:[-*+]|\d+[.)])\s", line):
            tags.update(t.strip().lstrip("#").lower() for t in re.findall(r"`([^`\n]+)`", line) if t.strip())
    return tags


def tag_trouble(tag: str) -> str | None:
    if re.search(r"\s", tag):
        return "has a space, which Obsidian doesn't allow in a tag"
    if re.fullmatch(r"[0-9/]+", tag):
        return "is only digits; Obsidian needs at least one other character"
    return None


class Findings:
    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.found: dict[str, dict[str, Any]] = {}

    def add(self, kind: str, item: Any) -> None:
        entry = self.found.setdefault(kind, {"count": 0, "items": []})
        entry["count"] += 1
        if len(entry["items"]) < self.limit:
            entry["items"].append(item)


def walk(root: str, raw: str, skip: list[str]) -> tuple[list[str], list[str], dict[str, str]]:
    """(every file, the Markdown pages to check, where each is on disk), as paths from the root with forward
    slashes. Names are compared composed (NFC): macOS can hand them back decomposed, while links are typed composed."""
    files, pages, disk = [], [], {}
    for here, dirs, names in os.walk(root):
        rel_dir = os.path.relpath(here, root).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for name in sorted(names):
            if name.startswith("."):
                continue
            on_disk = f"{rel_dir}/{name}" if rel_dir else name
            rel = unicodedata.normalize("NFC", on_disk)
            disk[rel] = os.path.join(root, *on_disk.split("/"))
            files.append(rel)
            if not name.lower().endswith(".md"):
                continue
            if any(rel == s or rel.startswith(s + "/") for s in [raw, *skip]):
                continue
            if not rel_dir and (name.lower() in SPECIAL or LOG_ARCHIVE.match(name)):
                continue
            pages.append(rel)
    return files, pages, disk


def clean_folder(value: str, what: str) -> str:
    folder = posixpath.normpath(value.replace("\\", "/").strip("/"))
    if folder in ("", ".") or folder == ".." or folder.startswith("../") or os.path.isabs(value):
        raise Fail(f"{what} {value!r} must be a folder inside the wiki, written from its root (like _archive)")
    return folder


def read_page(path: str) -> tuple[str, str]:
    with open(path, "rb") as fh:
        text, encoding = decode(fh.read())
    return unicodedata.normalize("NFC", text.replace("\r\n", "\n").replace("\r", "\n")), encoding


def cmd_check(args: argparse.Namespace) -> int:
    root = os.path.abspath(args.wiki)
    if not os.path.exists(root):
        raise Fail(f"no such folder: {args.wiki}")
    if not os.path.isdir(root):
        raise Fail(f"{args.wiki} is a file; give the wiki's folder")
    raw = clean_folder(args.raw, "--raw")
    skip = [clean_folder(s, "--skip") for s in args.skip]
    required = [f.strip() for f in args.require.split(",") if f.strip()]

    files, pages, disk = walk(root, raw, skip)
    vault = Vault(files)
    problems, review = Findings(args.limit), Findings(args.limit)
    skipped: list[str] = []
    top = {f.lower(): f for f in files if "/" not in f}
    for name in ("SCHEMA.md", "index.md", "log.md"):
        if name.lower() not in top:
            problems.add("missing_files", name)

    tags_allowed = None
    if "schema.md" in top:
        schema_text, _ = read_page(disk[top["schema.md"]])
        tags_allowed = schema_tags(schema_text)
        if tags_allowed is None:
            skipped.append("unknown_tags: SCHEMA.md has no Tags section, so only tags Obsidian can't read are listed")
    else:
        skipped.append("unknown_tags: no SCHEMA.md, so only tags Obsidian can't read are listed")

    inbound: dict[str, set[str]] = {p: set() for p in pages}
    in_index: set[str] = set()
    named_raw: set[str] = set()
    linked: set[str] = set()  # every file some page or saved article links to (an article's pictures, say)
    link_count = 0

    def follow(page: str, line: int | None, link: str, found: str | None, why: str | None) -> None:
        nonlocal link_count
        if found is None and why is None:
            return  # a link to a heading on the same page
        link_count += 1
        if found is not None:
            linked.add(found)
        if found is None:
            where: dict[str, Any] = {"line": line} if line is not None else {"in": "frontmatter"}
            problems.add("broken_links", {"page": page, **where, "link": link, "why": why})
        elif page == top.get("index.md"):
            in_index.add(found)
        elif found in inbound and found != page:
            inbound[found].add(page)

    scanned = ([top["index.md"]] if "index.md" in top else []) + pages
    for page in scanned:
        text, encoding = read_page(disk[page])
        if encoding != "utf-8":
            problems.add("not_utf8", {"page": page, "encoding": encoding})
        bare = without_code(text)
        for m in WIKILINK.finditer(bare):
            target = wikilink_target(m.group(1))
            line = bare.count("\n", 0, m.start()) + 1
            found, why = vault.by_name(target) if target else (None, None)
            follow(page, line, m.group(0), found, why)
        for m in MDLINK.finditer(bare):
            target = m.group(1)
            if SCHEME.match(target.strip("<>")) or target.startswith("#"):
                continue
            line = bare.count("\n", 0, m.start()) + 1
            found, why = vault.by_path(target, page)
            follow(page, line, m.group(0), found, why)
        if page == top.get("index.md"):
            continue

        meta, why_none = frontmatter(text)
        if meta is None:
            if required:
                problems.add("missing_fields", {"page": page, "missing": required, "why": why_none})
            continue
        missing = [f for f in required if meta.get(f) is None or meta.get(f) == ""]
        raw_paths = as_list(meta.get("raw"))
        recorded = [h.lower() for h in as_list(meta.get("sha256"))]
        if raw_paths and len(recorded) != len(raw_paths):
            missing.append("sha256" if len(raw_paths) == 1 else "sha256 (one per raw file, in the same order)")
        if missing:
            problems.add("missing_fields", {"page": page, "missing": missing})

        # sources: and contradictions: may name pages without [[ ]]; quoted [[links]] were followed above
        for field in ("sources", "contradictions"):
            for ref in as_list(meta.get(field)):
                if "[[" in ref or SCHEME.match(ref):
                    continue
                found, why = vault.by_name(ref.split("|", 1)[0].split("#", 1)[0].strip())
                follow(page, None, f"{field}: {ref}", found, why)

        for tag in as_list(meta.get("tags"), commas=True):
            tag = tag.strip().lstrip("#")
            trouble = tag_trouble(tag)
            if trouble:
                problems.add("unknown_tags", {"page": page, "tag": tag, "why": trouble})
            elif tags_allowed is not None and tag.lower() not in tags_allowed:
                problems.add("unknown_tags", {"page": page, "tag": tag, "why": "not in SCHEMA.md's Tags section"})

        for n, path in enumerate(raw_paths):
            rel = posixpath.normpath(path.replace("\\", "/").lstrip("/"))
            if rel == ".." or rel.startswith("../"):
                problems.add("raw_missing", {"page": page, "raw": path, "why": "outside the wiki"})
                continue
            if rel not in vault.files:
                folded = vault.lower.get(rel.lower())
                why = "no such file"
                if folded:
                    why = f"differs only in case from {folded[0]} (Linux and GitHub won't open it)"
                problems.add("raw_missing", {"page": page, "raw": path, "why": why})
                continue
            named_raw.add(rel)
            if len(recorded) == len(raw_paths):
                now = sha256_of(disk[rel])
                if now != recorded[n]:
                    problems.add("raw_changed", {"page": page, "raw": rel, "recorded": recorded[n], "now": now})

        contradictions = as_list(meta.get("contradictions"))
        if str(meta.get("contested") or "").strip().lower() in ("true", "yes") or contradictions:
            review.add("contested", {"page": page, "contradictions": contradictions})
        if str(meta.get("confidence") or "").strip().lower() == "low":
            review.add("low_confidence", page)

    for page in pages:
        if not inbound[page]:
            problems.add("orphans", page)
        if "index.md" in top and page not in in_index:
            problems.add("not_in_index", page)
    raw_files = [f for f in files if f.startswith(raw + "/")]
    for f in raw_files:  # links inside saved articles only mark the files they use (pictures); they aren't checked
        if not f.lower().endswith(".md"):
            continue
        bare = without_code(read_page(disk[f])[0])
        for m in WIKILINK.finditer(bare):
            linked.add(vault.by_name(wikilink_target(m.group(1)))[0] or "")
        for m in MDLINK.finditer(bare):
            if not SCHEME.match(m.group(1).strip("<>")):
                linked.add(vault.by_path(m.group(1), f)[0] or "")
    for f in raw_files:
        if f not in named_raw and f not in linked:
            review.add("not_ingested", f)
    by_name: dict[str, list[str]] = {}
    for page in pages:
        by_name.setdefault(posixpath.basename(page).lower(), []).append(page)
    for name, same in sorted(by_name.items()):
        if len(same) > 1:
            review.add("same_name", {"name": posixpath.basename(same[0]), "pages": same})

    result = {
        "ok": not problems.found,
        "wiki": root,
        "counts": {"pages": len(pages), "links": link_count, "raw_files": len(raw_files),
                   "sources": len(named_raw)},
        "problems": problems.found,
        "review": review.found,
        "how_to_fix": {k: HOW_TO_FIX[k] for k in problems.found},
    }
    if skipped:
        result["skipped"] = skipped
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if problems.found else 0


def cmd_hash(args: argparse.Namespace) -> int:
    out = []
    for path in args.files:
        if os.path.isdir(path):
            raise Fail(f"{path} is a folder; give the source file")
        if not os.path.exists(path):
            raise Fail(f"no such file: {path}")
        out.append({"file": path.replace("\\", "/"), "sha256": sha256_of(path)})
    print(json.dumps({"files": out}, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="wiki_lint.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    sp = sub.add_parser("check", help="check the wiki's links, index, frontmatter, tags and raw sources",
                        description="Check the wiki's links, index, frontmatter, tags and raw sources. Prints JSON; "
                        "exit 0 no problems, 1 problems found, 2 couldn't check.",
                        epilog="example:\n  python wiki_lint.py check wiki --skip _archive",
                        formatter_class=argparse.RawDescriptionHelpFormatter)
    sp.set_defaults(func=cmd_check)
    sp.add_argument("wiki", help="the wiki's folder (the one with SCHEMA.md, index.md and log.md)")
    sp.add_argument("--skip", action="append", default=[], metavar="FOLDER",
                    help="a folder whose pages aren't checked, such as _archive or templates (repeatable); "
                    "links into it still count")
    sp.add_argument("--raw", default="raw", metavar="FOLDER", help="the folder of raw sources (default raw)")
    sp.add_argument("--require", default="type,tags,updated", metavar="FIELDS",
                    help="frontmatter fields every page needs, comma-separated (default type,tags,updated; "
                    "--require= for none)")
    sp.add_argument("--limit", type=positive, default=50, metavar="N",
                    help="list at most N items of each kind (default 50; all are counted)")

    sp = sub.add_parser("hash", help="print the SHA-256 of files, for a source page's sha256: field",
                        description="Print the SHA-256 of each file as JSON, for a source page's sha256: field.",
                        epilog="example:\n  python wiki_lint.py hash wiki/raw/papers/2026-11-04-attention.pdf",
                        formatter_class=argparse.RawDescriptionHelpFormatter)
    sp.set_defaults(func=cmd_hash)
    sp.add_argument("files", nargs="+", metavar="file", help="a raw source file (several may be given)")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command: check or hash")
    return run_job(f"wiki_lint.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
