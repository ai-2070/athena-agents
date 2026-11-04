"""wiki_lint.py: the check of a Markdown wiki and the fingerprints of its raw sources, on wikis written into a temp
folder the way an agent (or Windows PowerShell 5.1) would write them."""

from __future__ import annotations

import hashlib
from pathlib import Path

SKILL, LINT = "llm-wiki", "wiki_lint.py"

SCHEMA = """# Schema

## Tags

Every tag on a page comes from this list; one is added here before a page uses it.

- `method`: a way of doing something
- `paper`, `model/transformer`

## Pages

- `not-a-tag`: backticks outside the Tags section don't count
"""


def write(folder: Path, rel: str, text: str, encoding: str = "utf-8") -> Path:
    path = folder.joinpath(*rel.split("/"))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode(encoding))
    return path


def page(kind: str, tags: str, body: str, extra: str = "") -> str:
    return f"---\ntype: {kind}\ntags: {tags}\ncreated: 2026-11-01\nupdated: 2026-11-04\n{extra}---\n{body}"


def clean_wiki(tmp_path: Path) -> Path:
    """A small wiki with nothing wrong: a source page with its raw file, a concept, an entity, an index and a log."""
    wiki = tmp_path / "wiki"
    pdf = write(wiki, "raw/papers/2026-11-01-attention.pdf", "%PDF-1.4 a paper\n")
    digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
    write(wiki, "SCHEMA.md", SCHEMA)
    write(wiki, "index.md", "# Index\n\n## Sources\n- [[attention-paper]]: the paper\n\n## Concepts\n"
          "- [[transformers]]: the architecture\n\n## Entities\n- [Google Brain](entities/google-brain.md): the lab\n")
    write(wiki, "log.md", "# Log\n\n## [2026-11-04] ingest | Attention paper\n- created [[attention-paper]]\n")
    write(wiki, "sources/attention-paper.md", page(
        "source", "[paper]", "# Attention paper\n\nIntroduces [[transformers|the Transformer]], from [[google-brain]].\n"
        "The file: ![[2026-11-01-attention.pdf]]\n",
        f"raw: raw/papers/2026-11-01-attention.pdf\nsha256: {digest}\n"))
    write(wiki, "concepts/transformers.md", page(
        "concept", "\n  - method\n  - Model/Transformer", "# Transformers\n\nSee [the paper](../sources/attention-paper.md#results)"
        " and [[google-brain#History]]. Heading here: [[#Use]]. Elsewhere: [site](https://example.com).\n",
        'sources:\n  - "[[attention-paper]]"\n'))
    write(wiki, "entities/google-brain.md", page("entity", "[]", "# Google Brain\n\nWrote [[attention-paper]] about [[transformers]].\n"))
    write(wiki, ".obsidian/workspace.md", "[[not checked]]")
    return wiki


def test_help_names_both_commands(run):
    r = run(SKILL, LINT, "--help")
    assert "check" in r.out and "hash" in r.out and "Exit codes" in r.out
    assert "--skip" in run(SKILL, LINT, "check", "--help").out


def test_a_clean_wiki_has_no_problems(run, tmp_path):
    body = run(SKILL, LINT, "check", clean_wiki(tmp_path)).json()
    assert body["ok"] is True and body["problems"] == {} and body["review"] == {}
    assert body["counts"] == {"pages": 3, "links": 11, "raw_files": 1, "sources": 1}
    assert "skipped" not in body


def test_links_that_lead_nowhere(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "concepts/attention.md", page("concept", "[method]", "# Attention\n\n"
          "[[Transformers]] and [[gone]] and [old](../concepts/missing.md) and [up](../../outside.md).\n"
          "`[[in code]]` <!-- [[in a comment]] --> %% [[obsidian comment]] %%\n"
          "```\n[[in a fence]]\n```\n"
          "| a | b |\n|---|---|\n| [[transformers\\|a table link]] | x |\n",
          "contradictions: [no-such-page]\n"))
    write(wiki, "index.md", (wiki / "index.md").read_text(encoding="utf-8") + "- [[attention]]: the idea\n")
    r = run(SKILL, LINT, "check", wiki, ok=False)
    assert r.code == 1 and r.err == ""
    broken = r.json()["problems"]["broken_links"]["items"]
    found = {(b["link"], b.get("line"), b["why"].split(" (")[0]) for b in broken}
    assert found == {
        ("[[Transformers]]", 10, "differs only in case from concepts/transformers.md"),
        ("[[gone]]", 10, "no such page or file"),
        ("[old](../concepts/missing.md)", 10, "no such page or file"),
        ("[up](../../outside.md)", 10, "points outside the wiki"),
        ("contradictions: no-such-page", None, "no such page or file"),
    }
    assert r.json()["review"]["contested"]["items"] == [{"page": "concepts/attention.md", "contradictions": ["no-such-page"]}]
    assert "broken_links" in r.json()["how_to_fix"]


def test_a_name_two_files_share_is_ambiguous(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "raw/articles/transformers.md", "a saved article with the same name as a page\n")
    write(wiki, "entities/transformers.md", page("entity", "[]", "# Transformers (the film)\n\nNot [[google-brain]].\n"))
    body = run(SKILL, LINT, "check", wiki, ok=False).json()
    whys = {b["why"] for b in body["problems"]["broken_links"]["items"]}
    assert any(w.startswith("3 files have this name") for w in whys)
    assert body["review"]["same_name"]["items"] == [{"name": "transformers.md", "pages": ["concepts/transformers.md", "entities/transformers.md"]}]
    assert body["review"]["not_ingested"]["items"] == ["raw/articles/transformers.md"]


def test_files_a_saved_article_uses_are_not_left_over(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "raw/articles/2026-11-02-blog.md", "# A post\n\n![chart](../assets/chart.png) and ![[diagram.svg]]\n")
    write(wiki, "raw/assets/chart.png", "png")
    write(wiki, "raw/assets/diagram.svg", "<svg/>")
    write(wiki, "raw/assets/stray.png", "png")
    body = run(SKILL, LINT, "check", wiki).json()
    assert body["review"]["not_ingested"]["items"] == ["raw/articles/2026-11-02-blog.md", "raw/assets/stray.png"]
    assert body["counts"]["raw_files"] == 5


def test_orphans_and_the_index(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "concepts/lonely.md", page("concept", "[method]", "# Lonely\n\nOnly the index links here; it links to [[transformers]].\n"))
    write(wiki, "concepts/unlisted.md", page("concept", "[method]", "# Unlisted\n\nLinks to [[lonely]].\n"))
    write(wiki, "index.md", (wiki / "index.md").read_text(encoding="utf-8") + "- [[lonely]]: alone\n")
    write(wiki, "log.md", (wiki / "log.md").read_text(encoding="utf-8") + "- and [[unlisted]], which the log doesn't count\n")
    body = run(SKILL, LINT, "check", wiki, ok=False).json()
    assert body["problems"]["orphans"]["items"] == ["concepts/unlisted.md"]
    assert body["problems"]["not_in_index"]["items"] == ["concepts/unlisted.md"]


def test_frontmatter_fields_and_tags(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "concepts/plain.md", "# Plain\n\nNo frontmatter; [[transformers]].\n")
    write(wiki, "concepts/open.md", "---\ntype: concept\n# never closed\n[[transformers]]\n")
    write(wiki, "concepts/tagged.md", "---\ntype: concept\nupdated:\ntags: [method, '#paper', not-a-tag, 1984, two words]\n"
          "confidence: low\n---\n[[transformers]]\n")
    for name in ("plain", "open", "tagged"):
        write(wiki, "index.md", (wiki / "index.md").read_text(encoding="utf-8") + f"- [[{name}]]\n")
    write(wiki, "concepts/transformers.md", (wiki / "concepts/transformers.md").read_text(encoding="utf-8")
          + "[[plain]] [[open]] [[tagged]]\n")
    body = run(SKILL, LINT, "check", wiki, ok=False).json()
    missing = {m["page"]: (m["missing"], m.get("why")) for m in body["problems"]["missing_fields"]["items"]}
    assert missing == {
        "concepts/plain.md": (["type", "tags", "updated"], "no frontmatter"),
        "concepts/open.md": (["type", "tags", "updated"], "the frontmatter has no closing ---"),
        "concepts/tagged.md": (["updated"], None),
    }
    tags = {(t["tag"], t["why"].split(",")[0].split(";")[0]) for t in body["problems"]["unknown_tags"]["items"]}
    assert tags == {("not-a-tag", "not in SCHEMA.md's Tags section"), ("1984", "is only digits"),
                    ("two words", "has a space")}
    assert body["review"]["low_confidence"]["items"] == ["concepts/tagged.md"]
    assert set(run(SKILL, LINT, "check", wiki, "--require=", ok=False).json()["problems"]) == {"unknown_tags"}


def test_no_tag_list_is_said_not_guessed(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "SCHEMA.md", "# Schema\n\nNo tag list yet.\n")
    body = run(SKILL, LINT, "check", wiki).json()
    assert body["ok"] is True and "SCHEMA.md has no Tags section" in body["skipped"][0]


def test_raw_sources_changed_or_gone(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "raw/papers/2026-11-01-attention.pdf", "%PDF-1.4 a paper, edited\n")
    write(wiki, "sources/blog.md", page("source", "[paper]", "# A blog post\n\n[[transformers]]\n",
                                        "raw: raw/articles/2026-11-02-blog.md\nsha256: 00\n"))
    write(wiki, "sources/talk.md", page("source", "[paper]", "# A talk\n\n[[transformers]]\n", "raw: raw/papers/2026-11-01-attention.pdf\n"))
    for name in ("blog", "talk"):
        write(wiki, "index.md", (wiki / "index.md").read_text(encoding="utf-8") + f"- [[{name}]]\n")
    write(wiki, "concepts/transformers.md", (wiki / "concepts/transformers.md").read_text(encoding="utf-8") + "[[blog]] [[talk]]\n")
    problems = run(SKILL, LINT, "check", wiki, ok=False).json()["problems"]
    changed = problems["raw_changed"]["items"]
    assert [c["raw"] for c in changed] == ["raw/papers/2026-11-01-attention.pdf"]
    assert changed[0]["now"] == hashlib.sha256((wiki / "raw/papers/2026-11-01-attention.pdf").read_bytes()).hexdigest()
    assert problems["raw_missing"]["items"] == [{"page": "sources/blog.md", "raw": "raw/articles/2026-11-02-blog.md", "why": "no such file"}]
    assert problems["missing_fields"]["items"] == [{"page": "sources/talk.md", "missing": ["sha256"]}]


def test_pages_powershell_wrote(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "entities/zoë.md", "﻿" + page("entity", "[]", "# Zoë\n\n[[transformers]] [[google-brain]]\n"), "utf-16-le")
    write(wiki, "entities/ansi.md", page("entity", "[]", "# Café\n\n[[transformers]] [[zoë]]\n"), "cp1252")
    write(wiki, "entities/crlf.md", page("entity", "[]", "# Line ends\n\n[[ansi]] [[crlf]]\n").replace("\n", "\r\n"))
    write(wiki, "index.md", (wiki / "index.md").read_text(encoding="utf-8") + "- [[zoë]]\n- [[ansi]]\n- [[crlf]]\n")
    write(wiki, "concepts/transformers.md", (wiki / "concepts/transformers.md").read_text(encoding="utf-8") + "[[crlf]]\n")
    body = run(SKILL, LINT, "check", wiki, ok=False).json()
    assert set(body["problems"]) == {"not_utf8"}
    assert {p["page"]: p["encoding"] for p in body["problems"]["not_utf8"]["items"]} == {"entities/ansi.md": "cp1252", "entities/zoë.md": "utf-16"}


def test_names_macos_stores_decomposed(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "entities/zoe\u0308.md", page("entity", "[]", "# Zoë\n\n[[transformers]]\n"))
    write(wiki, "index.md", (wiki / "index.md").read_text(encoding="utf-8") + "- [[zo\u00eb]]\n")
    write(wiki, "concepts/transformers.md", (wiki / "concepts/transformers.md").read_text(encoding="utf-8") + "[[zo\u00eb]]\n")
    body = run(SKILL, LINT, "check", wiki).json()
    assert body["ok"] is True and body["counts"]["pages"] == 4


def test_skip_folders_and_a_missing_core_file(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "_archive/old.md", "# Old, no frontmatter, [[gone]]\n")
    (wiki / "log.md").unlink()
    body = run(SKILL, LINT, "check", wiki, "--skip", "_archive", ok=False).json()
    assert body["problems"] == {"missing_files": {"count": 1, "items": ["log.md"]}}
    assert "missing_files" in body["how_to_fix"]


def test_limit_lists_some_and_counts_all(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    write(wiki, "concepts/many.md", page("concept", "[method]", "# Many\n\n" + " ".join(f"[[gone-{i}]]" for i in range(5)) + " [[transformers]]\n"))
    write(wiki, "index.md", (wiki / "index.md").read_text(encoding="utf-8") + "- [[many]]\n")
    write(wiki, "concepts/transformers.md", (wiki / "concepts/transformers.md").read_text(encoding="utf-8") + "[[many]]\n")
    broken = run(SKILL, LINT, "check", wiki, "--limit", "2", ok=False).json()["problems"]["broken_links"]
    assert broken["count"] == 5 and len(broken["items"]) == 2


def test_hash_prints_each_files_sha256(run, tmp_path):
    a = write(tmp_path, "raw/a.pdf", "one")
    b = write(tmp_path, "raw/b ü.md", "two")
    files = run(SKILL, LINT, "hash", a, b).json()["files"]
    assert [f["sha256"] for f in files] == [hashlib.sha256(b"one").hexdigest(), hashlib.sha256(b"two").hexdigest()]


def test_failures_are_one_line_and_exit_2(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    cases = [
        (("check", tmp_path / "nowhere"), "no such folder"),
        (("check", wiki / "index.md"), "is a file"),
        (("check", wiki, "--limit", "0"), "must be 1 or more"),
        (("check", wiki, "--limit", "-3"), "must be 1 or more"),
        (("check", wiki, "--limit", "lots"), "isn't a whole number"),
        (("check", wiki, "--skip", "../elsewhere"), "must be a folder inside the wiki"),
        (("check", wiki, "--raw", ""), "must be a folder inside the wiki"),
        (("hash", wiki / "raw"), "is a folder"),
        (("hash", wiki / "raw" / "none.pdf"), "no such file"),
        ((), "needs a command"),
    ]
    for args, words in cases:
        r = run(SKILL, LINT, *args, ok=False)
        assert r.code == 2, args
        assert r.out == "" and words in r.err and "Traceback" not in r.err, (args, r.err)
        assert len(r.err.strip().splitlines()) == 1, (args, r.err)


def test_check_changes_nothing(run, tmp_path):
    wiki = clean_wiki(tmp_path)
    before = {p: p.read_bytes() for p in wiki.rglob("*") if p.is_file()}
    run(SKILL, LINT, "check", wiki)
    assert {p: p.read_bytes() for p in wiki.rglob("*") if p.is_file()} == before
