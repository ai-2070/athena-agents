"""pptx_tool.py: info, outline, check, images and render, on real decks."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

SKILL, TOOL = "powerpoint", "pptx_tool.py"
COMMANDS = ["info", "outline", "check", "images", "render"]


@pytest.mark.parametrize("command", COMMANDS)
def test_every_command_has_help(run, command):
    r = run(SKILL, TOOL, command, "--help")
    assert "usage:" in r.out and "example:" in r.out


def test_info_lists_layouts_fonts_sections_and_master_text(run, sample):
    info = run(SKILL, TOOL, "info", sample).json()
    assert info["slides"] == 6 and info["hidden_slides"] == [6] and info["kind"] == "pptx"
    assert info["size"]["shape"] == "16:9"
    first = info["layouts"][0]
    assert first["layout"] == 1 and first["name"] == "Title Slide" and first["used_by_slides"] == [1]
    assert {(p["idx"], p["type"]) for p in first["placeholders"]} >= {(0, "CENTER_TITLE"), (1, "SUBTITLE"), (11, "FOOTER")}
    fonts = {f["font"]: f for f in info["fonts"]}
    assert "theme body" in fonts["Calibri"]["where"] and isinstance(fonts["Calibri"]["installed"], bool)
    assert info["theme_colors"]["accent1"] == "#4F81BD" and info["theme_colors"]["lt1"] == "#FFFFFF"
    assert info["sections"] == [{"name": "Intro", "slides": [1, 2]}, {"name": "Detail", "slides": [3, 4, 5, 6]}]
    assert any(t["text"] == "Acme Ltd footer line" and t["where"] == "master 1" for t in info["text_on_layouts"])


def test_info_opens_a_template(run, brand):
    info = run(SKILL, TOOL, "info", brand).json()
    assert info["kind"] == "potx" and "pptx" in info["note"]
    assert info["layouts"][0]["name"] == "Brand Title Slide"


def test_outline_reads_every_kind_of_shape_and_prints_utf8(run, sample, title_text):
    out = run(SKILL, TOOL, "outline", sample)
    assert title_text in out.out  # through a cp1252 pipe
    slides = out.json()["slides"]
    assert [s["slide"] for s in slides] == [1, 2, 3, 4, 5, 6]
    assert slides[0]["title"] == title_text
    assert slides[1]["notes"] == "Ask Acme about the numbers"
    assert "Revenue at Acme grew" in slides[1]["shapes"][1]["text"]
    grouped = {s["name"]: s for s in slides[2]["shapes"]}
    assert grouped["TextBox 3"]["in_group"] == "Group 2" and grouped["TextBox 3"]["text"] == "Acme in a group"
    assert grouped["Rectangle 5"]["in_group"] == "Group 2 > Group 4"
    chart = next(s for s in slides[3]["shapes"] if s["kind"] == "chart")["chart"]
    assert chart["categories"] == ["Q1", "Q2", "Q3"] and chart["title"] == "Acme share"
    assert chart["series"][1] == {"name": "South", "values": [0.4, 0.5, 0.6]}
    table = next(s for s in slides[4]["shapes"] if s["kind"] == "table")
    assert table["rows"][1] == ["{{client}}", "1,250"]
    logo = next(s for s in slides[4]["shapes"] if s["kind"] == "picture")
    assert logo["alt"] == "Company logo" and logo["image"]["pixels"] == [160, 90]
    assert slides[5]["hidden"] is True


def test_outline_puts_grouped_shapes_where_they_show(run, sample, tmp_path, h):
    """A group's children are in the group's own units; a group stretched to twice its size moves and grows them."""
    prs = h.open(sample)
    group = next(s for s in prs.slides[2].shapes if s.name == "Group 2")
    ext = group._element.grpSpPr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm/{http://schemas.openxmlformats.org/drawingml/2006/main}ext")
    ext.set("cx", str(int(ext.get("cx")) * 2))
    ext.set("cy", str(int(ext.get("cy")) * 2))
    stretched = tmp_path / "stretched.pptx"
    prs.save(stretched)
    shapes = {s["name"]: s for s in run(SKILL, TOOL, "outline", stretched, "--slides", "3").json()["slides"][0]["shapes"]}
    assert shapes["TextBox 3"]["box_in"] == [1.0, 2.0, 8.0, 2.0]
    assert shapes["Rectangle 5"]["box_in"] == [11.0, 2.0, 8.0, 2.0]
    r = run(SKILL, TOOL, "check", stretched, "--slides", "3", ok=False)
    assert r.code == 1
    assert any("Rectangle 5" in p["shape"] and "past the slide edge" in p["problem"] for p in r.json()["problems"])


def test_outline_can_go_to_a_file(run, sample, tmp_path):
    out = tmp_path / "work" / "outline.json"
    r = run(SKILL, TOOL, "outline", sample, "--out", out).json()
    assert r["out"] == str(out) and "shapes" not in r["slides"][0]
    full = json.loads(out.read_text(encoding="utf-8"))
    assert len(full["slides"]) == 6 and full["slides"][0]["shapes"]
    r = run(SKILL, TOOL, "outline", sample, "--out", sample, ok=False)
    assert r.code == 2 and "won't write over" in r.err


def test_check_finds_leftovers(run, sample):
    r = run(SKILL, TOOL, "check", sample, ok=False)
    assert r.code == 1 and r.err == ""
    body = r.json()
    problems = [(p["slide"], p["problem"]) for p in body["problems"]]
    assert (5, "unfilled {{client}} in the table") in problems
    assert any(p["slide"] == 5 and p["shape"] == "speaker notes" for p in body["problems"])
    assert any(n.get("slide") == 6 and "hidden" in n["note"] for n in body["notes"])
    assert any(n.get("slide") == 6 and "no slide title" in n["note"] for n in body["notes"])


def test_check_flags_an_empty_placeholder_and_passes_a_clean_deck(run, tmp_path):
    from pptx import Presentation

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "Only a title"
    prs.save(tmp_path / "empty.pptx")
    r = run(SKILL, TOOL, "check", tmp_path / "empty.pptx", ok=False)
    assert r.code == 1 and "empty placeholder" in r.json()["problems"][0]["problem"]
    slide.placeholders[1].text = "Now filled"
    prs.save(tmp_path / "full.pptx")
    assert run(SKILL, TOOL, "check", tmp_path / "full.pptx").json()["ok"] is True


def test_images_saves_each_picture_once_and_never_over_a_file(run, sample, tmp_path, h):
    from pptx.util import Inches

    prs = h.open(sample)
    prs.slides[2].shapes.add_picture(str(tmp_path / "logo.png"), Inches(1), Inches(4), Inches(2))  # the same picture again
    twice = tmp_path / "twice.pptx"
    prs.save(twice)
    folder = tmp_path / "pictures"
    folder.mkdir()
    (folder / "slide3_7.png").write_bytes(b"keep me")
    saved = run(SKILL, TOOL, "images", twice, "--out-dir", folder).json()["images"]
    assert len(saved) == 1 and saved[0]["slides"] == [3, 5]
    assert (folder / "slide3_7.png").read_bytes() == b"keep me"
    assert Path(saved[0]["file"]).name == "slide3_7_2.png"


@pytest.mark.parametrize("args, says", [
    (["--slides", "0"], "numbered from 1"),
    (["--slides", "2-9"], "past the end"),
    (["--slides", "a"], "can't read the slide list"),
])
def test_bad_slide_lists_are_one_line(run, sample, args, says, h):
    r = run(SKILL, TOOL, "outline", sample, *args, ok=False)
    assert r.code == 2 and h.one_line(r.err) and says in r.err and r.out == ""


def test_files_that_arent_decks_are_one_line(run, tmp_path, h):
    (tmp_path / "notes.pptx").write_text("not a deck", encoding="utf-8")
    (tmp_path / "old.ppt").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 600)
    (tmp_path / "locked.pptx").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + "EncryptedPackage".encode("utf-16-le") + b"\0" * 600)
    import zipfile

    with zipfile.ZipFile(tmp_path / "book.pptx", "w") as z:  # a workbook with the wrong name
        z.writestr("[Content_Types].xml", '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>')
    for name, says in (("notes.pptx", "isn't a PowerPoint file"), ("old.ppt", "soffice.py convert"),
                       ("locked.pptx", "password-protected"), ("book.pptx", "isn't a PowerPoint presentation"),
                       ("missing.pptx", "no such file")):
        r = run(SKILL, TOOL, "info", tmp_path / name, ok=False)
        assert r.code == 2 and h.one_line(r.err) and says in r.err, (name, r.err)


def test_mistakes_in_the_command_line_are_one_line(run, sample, h):
    for args, says in ((["render", sample], "--out-dir"), ([], "needs a command"),
                       (["render", sample, "--out-dir", "x", "--width", "0"], "--width"),
                       (["render", sample, "--out-dir", "x", "--timeout", "-1"], "--timeout")):
        r = run(SKILL, TOOL, *args, ok=False)
        assert r.code == 2 and h.one_line(r.err) and says in r.err, (args, r.err)


def test_render_without_libreoffice_says_why_in_one_line(run, sample, tmp_path, h):
    r = run(SKILL, TOOL, "render", sample, "--out-dir", tmp_path / "looks", "--soffice", tmp_path / "nowhere" / "soffice", ok=False)
    assert r.code == 2 and h.one_line(r.err) and "--soffice points to" in r.err
    assert not [p for p in (tmp_path / "looks").iterdir()]  # its scratch folder is gone


# --- with the real LibreOffice


def test_render_draws_every_slide_hidden_ones_too(run, sample, tmp_path, libreoffice):
    from PIL import Image

    looks = tmp_path / "looks"
    body = run(SKILL, TOOL, "render", sample, "--out-dir", looks, "--width", "640").json()
    assert [f["slide"] for f in body["files"]] == [1, 2, 3, 4, 5, 6]
    assert "not_drawn" not in body
    first = Image.open(body["files"][0]["file"])
    assert first.size[0] == 640 and abs(first.size[1] - 360) <= 1
    assert sorted(p.name for p in looks.iterdir()) == [f"sample_slide{n}.png" for n in range(1, 7)]
    assert any(f["font"] == "Calibri" for f in body.get("fonts_substituted", [])) or "fonts_substituted" not in body


def test_render_some_slides_as_jpeg(run, sample, tmp_path, libreoffice):
    body = run(SKILL, TOOL, "render", sample, "--out-dir", tmp_path / "jpg", "--slides", "2,4", "--format", "jpg").json()
    assert [f["slide"] for f in body["files"]] == [2, 4]
    assert all(Path(f["file"]).read_bytes()[:3] == b"\xff\xd8\xff" for f in body["files"])


def test_render_shows_the_slide_as_drawn(run, tmp_path, libreoffice):
    """A slide that's black on its left half comes out dark on the left and white on the right."""
    from PIL import Image
    from pptx import Presentation
    from pptx.dml.color import RGBColor
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Inches

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    box = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Inches(5), Inches(7.5))
    box.fill.solid()
    box.fill.fore_color.rgb = RGBColor(0, 0, 0)
    prs.save(tmp_path / "half.pptx")
    body = run(SKILL, TOOL, "render", tmp_path / "half.pptx", "--out-dir", tmp_path / "looks", "--width", "400").json()
    image = Image.open(body["files"][0]["file"]).convert("L")
    assert image.getpixel((50, 150)) < 40 and image.getpixel((350, 150)) > 215
