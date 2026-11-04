"""pdf_create.py: documents from a JSON spec."""

from __future__ import annotations

import json
from pathlib import Path

from pypdf import PdfReader

SKILL, CREATE = "pdf", "pdf_create.py"


def write_spec(folder: Path, spec: dict, name: str = "spec.json") -> Path:
    path = folder / name
    path.write_text(json.dumps(spec, ensure_ascii=False), encoding="utf-8")
    return path


def texts(path: Path) -> list[str]:
    return [p.extract_text() or "" for p in PdfReader(str(path)).pages]


def test_help(run):
    r = run(SKILL, CREATE, "--help")
    assert "usage:" in r.out and '"blocks"' in r.out


def test_builds_every_kind_of_block(run, tmp_path, png):
    spec = {
        "title": "Quarterly report",
        "author": "Finance",
        "header": "Acme Ltd",
        "footer": "Confidential",
        "blocks": [
            {"type": "heading", "text": "Results", "level": 1},
            {"type": "paragraph", "text": "Opening line\nsecond line"},
            {"type": "bullets", "items": ["first point", "second point"]},
            {"type": "bullets", "items": ["step one", "step two"], "numbered": True},
            {"type": "table", "rows": [["Region", "Units"], ["North", "1,250"], ["South", "980"]], "widths": [3, 1]},
            {"type": "image", "path": png.name, "width": 120, "caption": "Figure 1"},
            {"type": "rule"},
            {"type": "spacer", "height": 20},
            {"type": "pagebreak"},
            {"type": "heading", "text": "Appendix", "level": 2},
            {"type": "paragraph", "text": "The end.", "align": "justify"},
        ],
    }
    out = tmp_path / "out" / "report.pdf"
    r = run(SKILL, CREATE, write_spec(tmp_path, spec), "-o", out).json()
    assert r["pages"] == 2 and r["blocks"] == 11
    reader = PdfReader(str(out))
    assert reader.metadata.title == "Quarterly report" and reader.metadata.author == "Finance"
    first, second = texts(out)
    for words in ("Results", "second line", "first point", "step two", "Region", "1,250", "Figure 1", "Acme Ltd",
                  "Confidential", "1 / 2"):
        assert words in first, words
    assert "Appendix" in second and "2 / 2" in second
    assert len(reader.pages[0].images) == 1


def test_text_is_escaped_not_read_as_markup(run, tmp_path):
    spec = {"blocks": [
        {"type": "heading", "text": "R&D <beta> plan"},
        {"type": "paragraph", "text": "Fish & chips <b>not bold</b> & more"},
        {"type": "table", "rows": [["A & B", "<x>"], ["1", "2"]]},
    ]}
    out = tmp_path / "escaped.pdf"
    run(SKILL, CREATE, write_spec(tmp_path, spec), "-o", out)
    text = texts(out)[0]
    assert "R&D <beta> plan" in text
    assert "Fish & chips <b>not bold</b> & more" in text
    assert "A & B" in text and "<x>" in text


def test_markup_when_asked(run, tmp_path):
    spec = {"blocks": [{"type": "paragraph", "text": "<b>Bold</b> &amp; <i>italic</i>", "markup": True}]}
    out = tmp_path / "markup.pdf"
    run(SKILL, CREATE, write_spec(tmp_path, spec), "-o", out)
    text = texts(out)[0]
    assert "Bold & italic" in text and "<b>" not in text

    bad = {"blocks": [{"type": "paragraph", "text": "<b>never closed", "markup": True}]}
    r = run(SKILL, CREATE, write_spec(tmp_path, bad, "bad.json"), "-o", tmp_path / "bad.pdf", ok=False)
    assert r.code == 2 and "block 1" in r.err


def test_letters_the_built_in_fonts_lack_need_a_font(run, tmp_path, vera_ttf):
    spec = {"blocks": [{"type": "paragraph", "text": "Łask π ≤ 2"}]}
    r = run(SKILL, CREATE, write_spec(tmp_path, spec), "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and '"font"' in r.err and "π" in r.err
    assert not (tmp_path / "x.pdf").exists()

    spec["font"] = vera_ttf
    out = tmp_path / "pl.pdf"
    run(SKILL, CREATE, write_spec(tmp_path, spec, "font.json"), "-o", out)
    # read it back through the same cp1252 pipe: the text tool switches its output to UTF-8
    page = run(SKILL, "pdf_tool.py", "text", out).json()["pages"][0]["text"]
    assert "Łask π ≤ 2" in page


def test_font_without_the_letters_is_named(run, tmp_path, vera_ttf):
    spec = {"font": vera_ttf, "blocks": [{"type": "paragraph", "text": "Привет"}]}
    r = run(SKILL, CREATE, write_spec(tmp_path, spec), "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "Vera.ttf" in r.err


def test_clear_errors_for_bad_specs(run, tmp_path):
    r = run(SKILL, CREATE, write_spec(tmp_path, {"blocks": [{"type": "chart"}]}), "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "block 1" in r.err and "paragraph" in r.err
    spec = {"blocks": [{"type": "image", "path": "missing.png"}]}
    r = run(SKILL, CREATE, write_spec(tmp_path, spec, "img.json"), "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "no image" in r.err
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    r = run(SKILL, CREATE, tmp_path / "broken.json", "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "isn't valid JSON" in r.err


def test_spec_saved_by_windows_powershell(run, tmp_path):
    # Windows PowerShell 5.1: Out-File -Encoding utf8 adds a byte-order mark, > and Out-File write UTF-16,
    # Set-Content writes the ANSI code page
    spec = json.dumps({"blocks": [{"type": "paragraph", "text": "Zoë's café"}]}, ensure_ascii=False)
    for name, data in (("bom.json", spec.encode("utf-8-sig")), ("utf16.json", spec.encode("utf-16")),
                       ("ansi.json", spec.encode("cp1252"))):
        path = tmp_path / name
        path.write_bytes(data)
        out = tmp_path / (name + ".pdf")
        r = run(SKILL, CREATE, path, "-o", out).json()
        assert "Zoë's café" in texts(out)[0], name
        assert ("encoding_notes" in r) == (name == "ansi.json")


def test_a_tall_picture_shrinks_to_fit_the_page(run, tmp_path):
    from PIL import Image

    Image.new("RGB", (1170, 2532), (200, 30, 30)).save(tmp_path / "screenshot.png")  # a phone screenshot
    spec = write_spec(tmp_path, {"blocks": [{"type": "image", "path": "screenshot.png", "caption": "The app"}]})
    out = tmp_path / "tall.pdf"
    run(SKILL, CREATE, spec, "-o", out)
    page = PdfReader(str(out)).pages[0]
    assert len(page.images) == 1


def test_tables_without_cells_or_widths_are_refused_in_one_line(run, tmp_path):
    for i, table in enumerate(({"type": "table", "rows": [[]]}, {"type": "table", "rows": [["a", "b"]], "widths": [0, 0]})):
        r = run(SKILL, CREATE, write_spec(tmp_path, {"blocks": [table]}, f"t{i}.json"), "-o", tmp_path / "x.pdf", ok=False)
        assert r.code == 2 and "block 1 (table)" in r.err and "Traceback" not in r.err
    r = run(SKILL, CREATE, write_spec(tmp_path, {"font_size": 0, "blocks": [{"type": "rule"}]}, "f.json"), "-o",
            tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "font_size" in r.err


def test_never_writes_over_the_spec(run, tmp_path):
    spec = write_spec(tmp_path, {"blocks": [{"type": "paragraph", "text": "hi"}]})
    before = spec.read_bytes()
    r = run(SKILL, CREATE, spec, "-o", spec, ok=False)
    assert r.code == 2 and "won't write over the input" in r.err
    assert spec.read_bytes() == before


def test_an_output_path_that_is_a_folder_is_one_line(run, tmp_path):
    spec = write_spec(tmp_path, {"blocks": [{"type": "paragraph", "text": "hi"}]})
    (tmp_path / "taken.pdf").mkdir()
    r = run(SKILL, CREATE, spec, "-o", tmp_path / "taken.pdf", ok=False)
    assert r.code == 2 and "taken.pdf" in r.err and "Traceback" not in r.err
    assert not list(tmp_path.glob(".pdf_create-*"))
