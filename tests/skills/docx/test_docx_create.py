"""docx_create.py: a document from a JSON spec, on a blank page or a template, read back with python-docx and plain
XML (not the script), and rendered with LibreOffice when it's installed."""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path

import pytest

SKILL, CREATE = "docx", "docx_create.py"
CYRILLIC = "Отчёт о продажах"


def part(path: Path, name: str) -> str:
    with zipfile.ZipFile(path) as z:
        return z.read(name).decode("utf-8")


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


def write_json(path: Path, data, encoding: str = "utf-8") -> Path:
    path.write_bytes(json.dumps(data, ensure_ascii=False).encode(encoding))
    return path


@pytest.fixture
def picture(tmp_path: Path) -> Path:
    from PIL import Image

    Image.new("RGB", (200, 100), (30, 120, 200)).save(tmp_path / "chart.png")
    return tmp_path / "chart.png"


@pytest.fixture
def spec(tmp_path: Path, picture: Path) -> dict:
    return {
        "title": "Quarterly report", "author": "Finance", "header": "Acme Ltd", "page_numbers": True,
        "font": "Arial", "font_size": 11, "page_size": "letter", "margins_mm": 20,
        "styles": [{"name": "Note", "base": "Normal", "size": 9, "italic": True, "color": "555555", "space_after": 6}],
        "blocks": [
            {"type": "heading", "text": CYRILLIC, "level": 0},
            {"type": "toc", "title": "Contents", "levels": 2},
            {"type": "heading", "text": "Summary", "level": 1},
            {"type": "paragraph", "text": "Sales rose 4% in R&D <beta>.\nSecond line.", "align": "justify"},
            {"type": "paragraph", "runs": [{"text": "Bold", "bold": True}, {"text": " and "},
                                           {"text": "a link", "link": "https://example.com/report"}]},
            {"type": "bullets", "items": ["One", {"text": "Under one", "level": 2}, "Two"]},
            {"type": "numbered", "items": ["First", "Second"]},
            {"type": "numbered", "items": ["Again first"]},
            {"type": "table", "rows": [["Region", "Units"], ["North", "1,250"], ["South", 980]], "widths_mm": [60, 30]},
            {"type": "image", "path": picture.name, "width_mm": 50, "caption": "Figure 1: Units"},
            {"type": "paragraph", "text": "A note.", "style": "Note"},
            {"type": "page_break"},
            {"type": "heading", "text": "Detail", "level": 2},
        ],
    }


def test_help_shows_the_spec(run):
    r = run(SKILL, CREATE, "--help")
    assert "blocks" in r.out and "page_numbers" in r.out and "Exit codes" in r.out


def test_a_full_document(run, spec, tmp_path):
    import docx
    from docx.shared import Mm

    path = write_json(tmp_path / "spec.json", spec)
    out = tmp_path / "report.docx"
    r = run(SKILL, CREATE, path, "-o", out).json()
    assert r["written"] and r["tables"] == 1 and r["images"] == 1 and r["lists"] == 3
    assert r["fields"] == ["NUMPAGES", "PAGE", "TOC"] and "placeholder" in r["note"]
    d = docx.Document(out)
    texts = [(p.style.name, p.text) for p in d.paragraphs]
    assert texts[0] == ("Title", CYRILLIC) and ("Heading 1", "Summary") in texts and ("Heading 2", "Detail") in texts
    assert ("Note", "A note.") in texts and ("Caption", "Figure 1: Units") in texts
    assert any(t == "Sales rose 4% in R&D <beta>.\nSecond line." for _, t in texts)
    sec = d.sections[0]
    assert abs(sec.page_width - Mm(215.9)) < Mm(0.1) and abs(sec.left_margin - Mm(20)) < Mm(0.1)
    assert d.core_properties.title == "Quarterly report" and d.core_properties.author == "Finance"
    assert d.styles["Normal"].font.name == "Arial"
    assert d.sections[0].header.paragraphs[0].text == "Acme Ltd"
    xml = part(out, "word/document.xml")
    # each list has a numbering of its own, so the second numbered list starts again at 1
    num_ids = re.findall(r'<w:numId w:val="(\d+)"/>', xml)
    assert len(set(num_ids)) == 3 and len(num_ids) == 6
    assert "<w:tblHeader/>" in xml and 'TOC \\o "1-2"' in xml and "w:hyperlink" in xml
    assert 'Target="https://example.com/report"' in part(out, "word/_rels/document.xml.rels")
    assert "PAGE" in part(out, "word/footer1.xml") and "NUMPAGES" in part(out, "word/footer1.xml")
    settings = part(out, "word/settings.xml")
    assert settings.index("w:updateFields") < settings.index("w:compat")  # settings.xml keeps a fixed order
    table = d.tables[0]
    assert table.style.name == "Table Grid" and table.rows[0].cells[0].paragraphs[0].runs[0].bold
    assert table.rows[1].cells[1].paragraphs[0].alignment == 2  # numbers sit to the right
    assert abs(table.columns[0].width - Mm(60)) < Mm(0.5)


def test_a_spec_saved_by_windows_powershell(run, tmp_path):
    spec = {"blocks": [{"type": "heading", "text": CYRILLIC}, {"type": "paragraph", "text": "Zoë Ł ≤ 3"}]}
    path = write_json(tmp_path / "spec.json", spec, "utf-16")
    out = tmp_path / "out.docx"
    r = run(SKILL, CREATE, path, "-o", out).json()
    assert "encoding_notes" not in r
    import docx

    assert [p.text for p in docx.Document(out).paragraphs] == [CYRILLIC, "Zoë Ł ≤ 3"]
    ansi = write_json(tmp_path / "ansi.json", {"blocks": [{"type": "paragraph", "text": "Café"}]}, "cp1252")
    r = run(SKILL, CREATE, ansi, "-o", tmp_path / "ansi.docx").json()
    assert "isn't UTF-8" in r["encoding_notes"][0]


def test_every_problem_in_the_spec_at_once_and_nothing_written(run, tmp_path):
    spec = {"font_size": 0, "page_size": "B5", "margins_mm": -3, "styles": [{"base": "Normal"}], "blocks": [
        {"type": "heading", "level": 12, "text": "x"},
        {"type": "paragraph", "text": "x", "style": "No Such"},
        {"type": "bullets", "items": []},
        {"type": "table", "rows": [["a", "b"]], "widths_mm": [10]},
        {"type": "image", "path": "missing.png"},
        {"type": "paragraph", "runs": [{"text": "x", "color": "red"}]},
        {"type": "paragraph", "runs": [{"text": "y", "link": "javascript:alert(1)"}]},
        {"type": "toc", "levels": 0},
        {"type": "chart"},
    ]}
    out = tmp_path / "out.docx"
    r = run(SKILL, CREATE, write_json(tmp_path / "spec.json", spec), "-o", out, ok=False)
    assert r.code == 1 and not out.exists()
    problems = " | ".join(r.json()["problems"])
    for says in ("styles item 1", "page_size", "block 1", "No Such", "block 3", "widths_mm", "missing.png",
                 "color is six hex", "link is an http", "block 8", "block 9"):
        assert says in problems, says


def test_on_a_template_made_in_word(run, tmp_path):
    """Word saves only the styles a document uses, so a letterhead usually lacks headings and list styles."""
    import docx
    from lxml import etree

    tpl = docx.Document()
    tpl.sections[0].header.paragraphs[0].text = "ACME LETTERHEAD"
    tpl.add_paragraph("Old body text")
    styles = tpl.styles.element
    for s in list(styles):
        sid = s.get("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}styleId") or ""
        if sid.startswith(("Heading", "List", "Title", "TableGrid", "Caption")):
            styles.remove(s)
    tpl.save(tmp_path / "plain.docx")
    letterhead = tmp_path / "letterhead.dotx"
    with zipfile.ZipFile(tmp_path / "plain.docx") as zin, zipfile.ZipFile(letterhead, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(b"document.main+xml", b"template.main+xml")
            zout.writestr(item, data)
    spec = {"template": letterhead.name, "blocks": [
        {"type": "heading", "text": "Offer", "level": 1},
        {"type": "bullets", "items": ["Fast", "Cheap"]},
        {"type": "table", "rows": [["a", "1"]], "header": False}]}
    out = tmp_path / "offer.docx"
    run(SKILL, CREATE, write_json(tmp_path / "spec.json", spec), "-o", out)
    d = docx.Document(out)
    assert [p.text for p in d.paragraphs] == ["Offer", "Fast", "Cheap"]
    assert d.paragraphs[0].style.name == "Heading 1" and d.sections[0].header.paragraphs[0].text == "ACME LETTERHEAD"
    assert "document.main+xml" in part(out, "[Content_Types].xml")
    etree.fromstring(part(out, "word/styles.xml").encode())  # still well-formed
    assert run(SKILL, "docx_tool.py", "check", out).json()["warnings"] == 0


def test_never_over_its_inputs(run, spec, picture, tmp_path):
    path = write_json(tmp_path / "spec.json", spec)
    before = picture.read_bytes()
    r = run(SKILL, CREATE, path, "-o", picture, ok=False)
    assert r.code == 2 and one_line(r.err) and "won't write over" in r.err and picture.read_bytes() == before
    folder = tmp_path / "folder.docx"
    folder.mkdir()
    r = run(SKILL, CREATE, path, "-o", folder, ok=False)
    assert r.code == 2 and "is a folder" in r.err
    r = run(SKILL, CREATE, tmp_path / "nope.json", "-o", tmp_path / "x.docx", ok=False)
    assert r.code == 2 and one_line(r.err) and "no such file" in r.err


def test_page_numbers_and_layout_in_libreoffice(run, spec, tmp_path, libreoffice):
    path = write_json(tmp_path / "spec.json", spec)
    out = tmp_path / "report.docx"
    run(SKILL, CREATE, path, "-o", out)
    pdf = tmp_path / "work" / "report.pdf"
    run(SKILL, "soffice.py", "convert", out, "--to", "pdf", "-o", pdf)
    import pdfplumber

    with pdfplumber.open(pdf) as doc:
        pages = [p.extract_text() or "" for p in doc.pages]
        widths = [round(c[2] - c[0]) for c in doc.pages[0].find_tables()[0].rows[0].cells]
    assert len(pages) == 2 and "Page 1 of 2" in pages[0] and "Page 2 of 2" in pages[1]
    assert CYRILLIC in pages[0] and "1. First" in pages[0] and "1. Again first" in pages[0]
    assert "[Table of contents" in pages[0]  # LibreOffice prints the placeholder until fields are updated
    assert widths == [round(60 / 25.4 * 72), round(30 / 25.4 * 72)]
