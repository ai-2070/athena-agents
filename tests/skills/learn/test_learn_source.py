"""learn_source.py: books, saved pages and subtitles to text an agent reads a piece at a time."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

SKILL, SCRIPT = "learn", "learn_source.py"

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Łódź Field Notes</dc:title><dc:creator>Ana Ruiz</dc:creator></metadata>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"""

PAGE = """<html><head><title>T</title><style>p {{ color: red }}</style></head><body>
<h1>{title}</h1><p>{text}</p><ul><li>first point</li><li>second point</li></ul>
<pre>run --this
  exactly</pre><script>ignored()</script></body></html>"""


def make_epub(path: Path, *, drm: bool = False) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/cover.xhtml", "<html><body><img src='cover.jpg'/></body></html>")
        z.writestr("OEBPS/text/ch1.xhtml", PAGE.format(title="Replication", text="Leaders and followers keep copies."))
        z.writestr("OEBPS/text/ch2.xhtml", PAGE.format(title="Partitioning", text="Split the data by key​ range."))
        if drm:
            z.writestr("META-INF/encryption.xml", '<encryption><EncryptedData><CipherReference URI="OEBPS/text/ch1.xhtml"/></EncryptedData></encryption>')
    return path


def test_epub_writes_chapters_in_reading_order_with_an_index(run, tmp_path):
    book = make_epub(tmp_path / "book.epub")
    r = run(SKILL, SCRIPT, "epub", book, "-o", tmp_path / "out", ok=False)
    # the cover has no text: done, with a warning to look at
    assert r.code == 1
    body = r.json()
    assert body["chapters"] == 2 and body["title"] == "Łódź Field Notes" and body["author"] == "Ana Ruiz"
    assert body["hidden_characters_removed"] == 1
    assert any("cover" in w for w in body["warnings"])
    index = json.loads((tmp_path / "out" / "index.json").read_text(encoding="utf-8"))
    assert [c["heading"] for c in index["chapters"]] == ["Replication", "Partitioning"]  # the spine's order, not the manifest's
    first = (tmp_path / "out" / index["chapters"][0]["file"]).read_text(encoding="utf-8")
    assert first.startswith("# Replication")
    assert "- first point" in first and "```\nrun --this\n  exactly\n```" in first
    assert "ignored()" not in first and "color: red" not in first
    second = (tmp_path / "out" / index["chapters"][1]["file"]).read_text(encoding="utf-8")
    assert "key range" in second and "​" not in second


def test_epub_with_drm_is_reported_not_read(run, tmp_path):
    r = run(SKILL, SCRIPT, "epub", make_epub(tmp_path / "locked.epub", drm=True), "-o", tmp_path / "out", ok=False)
    assert r.code == 1 and r.json()["ok"] is False and "DRM" in r.json()["warnings"][0]
    assert not (tmp_path / "out").exists()


def test_a_file_that_isnt_an_epub_is_one_line(run, tmp_path):
    (tmp_path / "x.epub").write_text("not a zip")
    r = run(SKILL, SCRIPT, "epub", tmp_path / "x.epub", "-o", tmp_path / "out", ok=False)
    assert r.code == 2 and r.out == "" and len(r.err.strip().splitlines()) == 1 and "Traceback" not in r.err


def test_html_page_to_text_takes_powershell_encodings(run, tmp_path):
    page = tmp_path / "page.html"
    # what PowerShell 5.1's > writes: UTF-16 with a byte-order mark
    page.write_bytes(PAGE.format(title="Kraków ‮guide", text="Café menu").encode("utf-16"))
    r = run(SKILL, SCRIPT, "html", page, "-o", tmp_path / "page.md")
    body = r.json()
    assert body["encoding"] == "utf-16" and body["hidden_characters_removed"] == 1
    text = (tmp_path / "page.md").read_text(encoding="utf-8")
    assert "# Kraków guide" in text and "Café menu" in text


SRT = """1
00:00:01,000 --> 00:00:03,000
Welcome to the talk

2
00:00:03,000 --> 00:00:05,000
Welcome to the talk
about replication

3
00:01:10,500 --> 00:01:12,000
<i>Leaders</i> take the writes &amp; followers copy them
"""


def test_subtitles_become_timestamped_paragraphs_without_rolling_repeats(run, tmp_path):
    (tmp_path / "talk.srt").write_text(SRT, encoding="utf-8")
    r = run(SKILL, SCRIPT, "subs", tmp_path / "talk.srt", "-o", tmp_path / "talk.md")
    assert r.json()["paragraphs"] == 2
    text = (tmp_path / "talk.md").read_text(encoding="utf-8")
    assert text.count("Welcome to the talk") == 1 and "about replication" in text
    assert "[00:01:10] Leaders take the writes & followers copy them" in text


def test_webvtt_and_a_bad_interval(run, tmp_path):
    (tmp_path / "talk.vtt").write_text("WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHello\n\n01:02:03.000 --> 01:02:05.000\nLater\n", encoding="utf-8")
    r = run(SKILL, SCRIPT, "subs", tmp_path / "talk.vtt", "-o", tmp_path / "t.md")
    assert "[01:02:03] Later" in (tmp_path / "t.md").read_text(encoding="utf-8")
    bad = run(SKILL, SCRIPT, "subs", tmp_path / "talk.vtt", "-o", tmp_path / "t.md", "--every", "0", ok=False)
    assert bad.code == 2 and "10 seconds" in bad.err and "Traceback" not in bad.err


def test_never_writes_over_its_input(run, tmp_path):
    notes = tmp_path / "notes.txt"
    notes.write_text("keep me", encoding="utf-8")
    r = run(SKILL, SCRIPT, "clean", notes, "-o", notes, ok=False)
    assert r.code == 2 and "is the input" in r.err
    assert notes.read_text(encoding="utf-8") == "keep me"


def test_clean_removes_hidden_characters_from_ansi_text(run, tmp_path):
    (tmp_path / "notes.txt").write_bytes("Ignore⁦ this⁩ note — fine".encode("utf-8"))
    r = run(SKILL, SCRIPT, "clean", tmp_path / "notes.txt", "-o", tmp_path / "clean.md")
    assert r.json()["hidden_characters_removed"] == 2
    assert (tmp_path / "clean.md").read_text(encoding="utf-8") == "Ignore this note — fine\n"
