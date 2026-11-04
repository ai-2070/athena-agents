"""pptx_deck.py: new decks and edits from a JSON plan, on real decks."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

SKILL, DECK, TOOL = "powerpoint", "pptx_deck.py", "pptx_tool.py"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def test_help(run):
    for args in (["--help"], ["new", "--help"], ["edit", "--help"]):
        r = run(SKILL, DECK, *args)
        assert "usage:" in r.out
    assert "replace" in run(SKILL, DECK, "--help").out and "example:" in run(SKILL, DECK, "edit", "--help").out


# --- new decks


def test_new_deck_is_16_9_with_the_design_stretched_to_fit(run, write_plan, tmp_path, h):
    plan = write_plan({"properties": {"title": "Review", "author": "Finance"}, "steps": [
        {"do": "add", "layout": "Title Slide", "title": "Q3 review", "subtitle": "Every region grew"},
        {"do": "add", "layout": 2, "title": "North grew fastest", "body": ["North up 18%", {"text": "Two new stores", "level": 1}]},
    ]})
    out = tmp_path / "deck.pptx"
    body = run(SKILL, DECK, "new", plan, "-o", out).json()
    assert body["slides"] == 2 and body["ok"] is True and body["size_in"] == [13.33, 7.5]
    prs = h.open(out)
    assert prs.core_properties.title == "Review" and prs.core_properties.author == "Finance"
    assert prs.core_properties.comments == "" and prs.core_properties.last_modified_by == ""
    title = prs.slides[1].shapes.title
    assert abs((title.left + title.width / 2) - prs.slide_width / 2) < 914400 * 0.05  # centred on the wide slide
    paras = prs.slides[1].placeholders[1].text_frame.paragraphs
    assert [p.text for p in paras] == ["North up 18%", "Two new stores"] and paras[1].level == 1
    assert run(SKILL, TOOL, "check", out).json()["ok"] is True  # no empty placeholders left behind


def test_new_deck_fills_placeholders_with_pictures_charts_and_tables(run, write_plan, tmp_path, h):
    h.png(tmp_path / "photo.png", size=(400, 300))
    plan = write_plan([
        {"do": "add", "layout": "Picture with Caption", "title": "Our store", "body": "Opened in May",
         "placeholders": {"1": {"picture": "photo.png", "alt": "The new store"}}},
        {"do": "add", "layout": "Two Content", "title": "Mix", "body": {"chart": {"type": "pie", "categories": ["A", "B"], "series": {"Share": [60, 40]}}},
         "placeholders": {"2": {"table": {"rows": [["Region", "Units"], ["North", 1250]], "widths": [2, 1]}}}},
        {"do": "add", "layout": "Title Only", "title": "Shapes", "shapes": [
            {"type": "text", "x": 1, "y": "4cm", "w": 5, "h": 1, "text": "Big number", "size": 40, "bold": True, "name": "Callout"},
            {"type": "picture", "path": "photo.png", "x": 7, "y": 2, "w": 4, "h": 4, "alt": "photo"},
            {"type": "box", "shape": "oval", "x": 1, "y": 5, "w": 2, "h": 1, "fill": "#1F4E79", "line": "none", "text": "Hi", "color": "#FFFFFF"},
            {"type": "chart", "x": 7, "y": 2, "w": 5, "h": 3, "chart": {"type": "scatter", "series": {"Plant": [[1, 2], [2, 4.5]]}, "title": "Fit"}}]},
    ])
    out = tmp_path / "deck.pptx"
    run(SKILL, DECK, "new", plan, "-o", out)
    outline = run(SKILL, TOOL, "outline", out).json()["slides"]
    kinds = [s["kind"] for s in outline[0]["shapes"]]
    assert "picture" in kinds and outline[0]["shapes"][kinds.index("picture")]["alt"] == "The new store"
    chart = next(s for s in outline[1]["shapes"] if s["kind"] == "chart")
    assert chart["placeholder"]["idx"] == 1 and chart["chart"]["type"] == "PIE"
    table = next(s for s in outline[1]["shapes"] if s["kind"] == "table")
    assert table["rows"] == [["Region", "Units"], ["North", "1250"]]
    shapes = {s["name"]: s for s in outline[2]["shapes"]}
    assert shapes["Callout"]["text"] == "Big number" and shapes["Callout"]["box_in"][1] == round(4 / 2.54, 2)
    pic = next(s for s in outline[2]["shapes"] if s["kind"] == "picture")
    assert pic["box_in"] == [7.0, 2.5, 4.0, 3.0]  # fitted inside 4 x 4, keeping 4:3
    assert run(SKILL, TOOL, "check", out).json()["ok"] is True


def test_new_deck_from_a_template_uses_its_layouts_and_leaves_its_slides_out(run, write_plan, brand, tmp_path, h):
    before = brand.read_bytes()
    plan = write_plan([{"do": "add", "layout": "Brand Title Slide", "title": "On brand"},
                       {"do": "add", "layout": "brand title and content", "title": "Point", "body": "Detail"}])
    out = tmp_path / "branded.pptx"
    body = run(SKILL, DECK, "new", plan, "-o", out, "--template", brand).json()
    assert body["slides"] == 2 and body["template"] == str(brand)
    assert h.titles(out) == ["On brand", "Point"]
    assert "template.main" not in h.read_part(out, "[Content_Types].xml")
    assert "sectionLst" not in h.read_part(out, "ppt/presentation.xml")
    assert brand.read_bytes() == before
    r = run(SKILL, DECK, "new", plan, "-o", tmp_path / "x.potx", "--template", brand, ok=False)
    assert r.code == 2 and ".pptx" in r.err


def test_an_unknown_layout_or_placeholder_lists_what_there_is(run, write_plan, tmp_path, h):
    r = run(SKILL, DECK, "new", write_plan([{"do": "add", "layout": "Agenda"}]), "-o", tmp_path / "d.pptx", ok=False)
    assert r.code == 2 and h.one_line(r.err) and "1. Title Slide" in r.err
    r = run(SKILL, DECK, "new", write_plan([{"do": "add", "layout": "Title Only", "body": "x"}]), "-o", tmp_path / "d.pptx", ok=False)
    assert "no body placeholder" in r.err and "0 (TITLE)" in r.err
    r = run(SKILL, DECK, "new", write_plan([{"do": "add", "layout": "Title Only", "placeholders": {"7": "x"}}]), "-o", tmp_path / "d.pptx", ok=False)
    assert "no placeholder 7" in r.err
    assert not (tmp_path / "d.pptx").exists()


def test_keep_empty_keeps_placeholders(run, write_plan, tmp_path, h):
    out = tmp_path / "d.pptx"
    body = run(SKILL, DECK, "new", write_plan([{"do": "add", "layout": "Title and Content", "title": "T", "keep_empty": True},
                                               {"do": "add", "layout": "Title and Content", "title": "T"}]), "-o", out).json()
    assert len(h.open(out).slides[0].placeholders) == 2 and len(h.open(out).slides[1].placeholders) == 1
    assert body["steps"][1]["empty_placeholders_removed"] == 1


# --- edits: text


def test_replace_finds_text_split_across_runs_and_keeps_its_look(run, write_plan, sample, tmp_path, h):
    before = sample.read_bytes()
    out = tmp_path / "out.pptx"
    body = run(SKILL, DECK, "edit", sample, write_plan([{"do": "replace", "find": "Acme", "with": "Globex"}]), "-o", out).json()
    step = body["steps"][0]
    assert step["by_place"] == {"slides": 5, "notes": 1, "charts": 1} and step["slides_changed"] == [1, 2, 3, 4]
    assert step["look_check"]["slides"] == [2]  # "Ac" bold + "me Corp" plain
    assert "masters or layouts" in step["left_on_layouts"]
    assert sample.read_bytes() == before
    prs = h.open(out)
    first, second = prs.slides[1].placeholders[1].text_frame.paragraphs[:2]
    assert [(r.text, r.font.bold) for r in first.runs] == [("Revenue at Globex grew", True)]
    assert [(r.text, r.font.bold) for r in second.runs] == [("Globex", True), (" Corp", False)]
    joined = h.texts(out)
    assert "Globex in a group" in joined[2] and "Deep Globex" in joined[2]  # inside a group and a nested group
    assert "Acme" not in " ".join(joined)
    assert prs.slides[1].notes_slide.notes_text_frame.text == "Ask Globex about the numbers"
    chart_xml = h.read_part(out, "ppt/charts/chart1.xml")
    assert "Globex share" in chart_xml


def test_replace_on_layouts_and_case(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "replace", "find": "acme LTD", "with": "Globex plc", "match_case": False, "layouts": True}])
    body = run(SKILL, DECK, "edit", sample, plan, "-o", out).json()
    assert body["steps"][0]["by_place"] == {"slides": 1, "layouts": 1}
    info = run(SKILL, TOOL, "info", out).json()
    assert info["text_on_layouts"][0]["text"] == "Globex plc footer line"


def test_replace_that_finds_nothing_is_a_problem_but_writes_the_deck(run, write_plan, sample, tmp_path):
    out = tmp_path / "out.pptx"
    r = run(SKILL, DECK, "edit", sample, write_plan([{"do": "replace", "find": "footer line", "with": "x"}]), "-o", out, ok=False)
    assert r.code == 1 and r.err == ""
    assert 'add "layouts": true' in r.json()["problems"][0]
    assert out.exists()


def test_fill_puts_values_in_place_of_tokens(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "fill", "values": {"client": "Ünïcode Ltd — 株式会社"}}])
    body = run(SKILL, DECK, "edit", sample, plan, "-o", out).json()
    assert body["steps"][0]["filled"] == ["client"] and body["ok"] is True
    prs = h.open(out)
    table = next(s for s in prs.slides[4].shapes if s.has_table).table
    assert table.cell(1, 0).text == "Ünïcode Ltd — 株式会社"
    assert prs.slides[4].notes_slide.notes_text_frame.text == "Prepared for Ünïcode Ltd — 株式会社"
    assert run(SKILL, TOOL, "check", out, ok=False).json()["problems"] == []


def test_fill_reports_tokens_without_values_and_values_without_tokens(run, write_plan, sample, tmp_path):
    r = run(SKILL, DECK, "edit", sample, write_plan([{"do": "fill", "values": {"date": "today"}}]), "-o", tmp_path / "o.pptx", ok=False)
    assert r.code == 1
    step = r.json()["steps"][0]
    assert step["no_value"] == ["client"] and step["not_found"] == ["date"]


def test_text_step_keeps_the_shapes_look(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([
        {"do": "text", "slide": 2, "shape": "Content Placeholder 2", "text": ["First", "Second", {"text": "Sub", "level": 1}, {"runs": [{"text": "Mixed "}, {"text": "bold", "bold": False, "link": "https://example.com"}]}]},
        {"do": "text", "slide": 5, "shape": "Table 2", "cell": [3, 2], "text": "2,500"},
        {"do": "notes", "slide": 2, "text": "Second thought", "append": True},
    ])
    run(SKILL, DECK, "edit", sample, plan, "-o", out)
    prs = h.open(out)
    paras = prs.slides[1].placeholders[1].text_frame.paragraphs
    assert [p.text for p in paras] == ["First", "Second", "Sub", "Mixed bold"]
    assert paras[0].runs[0].font.bold is True and paras[2].level == 1  # the old paragraphs' looks
    assert paras[3].runs[1].hyperlink.address == "https://example.com"
    table = next(s for s in prs.slides[4].shapes if s.has_table).table
    assert table.cell(2, 1).text == "2,500"
    assert prs.slides[1].notes_slide.notes_text_frame.text == "Ask Acme about the numbers\nSecond thought"


def test_notes_can_be_emptied_on_every_slide(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    run(SKILL, DECK, "edit", sample, write_plan([{"do": "notes", "slides": "1-", "text": ""}]), "-o", out)
    assert all(not s.has_notes_slide or not s.notes_slide.notes_text_frame.text for s in h.open(out).slides)
    r = run(SKILL, DECK, "edit", sample, write_plan([{"do": "notes", "slide": 1, "slides": "2", "text": "x"}]), "-o", out, ok=False)
    assert r.code == 2 and "slide" in r.err


def test_table_step_adds_rows(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    rows = [["Client", "Units"], ["North", "1"], ["South", "2"], ["Total", "3"]]
    run(SKILL, DECK, "edit", sample, write_plan([{"do": "table", "slide": 5, "shape": 3, "rows": rows}]), "-o", out)
    table = next(s for s in h.open(out).slides[4].shapes if s.has_table).table
    assert [[c.text for c in r.cells] for r in table.rows] == rows
    r = run(SKILL, DECK, "edit", sample, write_plan([{"do": "table", "slide": 5, "shape": 3, "rows": [["a", "b", "c"]]}]), "-o", out, ok=False)
    assert r.code == 2 and "2 columns" in r.err


# --- edits: charts and pictures


def chart_of(path: Path, h, slide: int = 4):
    return next(s for s in h.open(path).slides[slide - 1].shapes if s.has_chart).chart


def test_chart_data_replaced_whole(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "chart", "slide": 4, "categories": ["H1", "H2"], "series": {"North": [0.5, 0.6]}, "title": "Halves"}])
    run(SKILL, DECK, "edit", sample, plan, "-o", out)
    chart = chart_of(out, h)
    assert list(chart.plots[0].categories) == ["H1", "H2"]
    assert [(s.name, s.values) for s in chart.plots[0].series] == [("North", (0.5, 0.6))]
    assert chart.chart_title.text_frame.text == "Halves"
    assert "<c:formatCode>0%</c:formatCode>" in h.read_part(out, "ppt/charts/chart1.xml")  # the number format stays


def test_chart_small_changes_keep_each_series_colour(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "chart", "slide": 4, "shape": "Share chart", "remove": ["South"], "set": {"North": {"Q2": 0.25}},
                        "add": {"East": [0.3, 0.3, 0.3]}, "rename": {"Q3": "Q3 2026"}}])
    run(SKILL, DECK, "edit", sample, plan, "-o", out)
    chart = chart_of(out, h)
    assert list(chart.plots[0].categories) == ["Q1", "Q2", "Q3 2026"]
    assert [(s.name, s.values) for s in chart.plots[0].series] == [
        ("North", (0.1, 0.25, 0.3)), ("West", (0.2, 0.2, 0.2)), ("East", (0.3, 0.3, 0.3))]
    series = {s.name: s for s in chart.plots[0].series}
    assert str(series["North"].format.fill.fore_color.rgb) == "1F4E79"
    assert str(series["West"].format.fill.fore_color.rgb) == "548235"  # not South's colour, which went with it
    assert series["East"]._element.find("{http://schemas.openxmlformats.org/drawingml/2006/chart}spPr") is None


@pytest.mark.parametrize("step, says", [
    ({"set": {"Nowhere": [1, 2, 3]}}, "no series 'Nowhere'"),
    ({"set": {"North": [1, 2]}}, "2 values for 3 categories"),
    ({"set": {"North": ["1", 2, 3]}}, "isn't a number"),
    ({"rename": {"Q9": "x"}}, "no category 'Q9'"),
    ({"categories": ["a"], "series": {"x": [1]}, "set": {"North": [1, 2, 3]}}, "not both"),
])
def test_chart_mistakes_are_one_line_and_write_nothing(run, write_plan, sample, tmp_path, step, says, h):
    out = tmp_path / "out.pptx"
    r = run(SKILL, DECK, "edit", sample, write_plan([{"do": "chart", "slide": 4, **step}]), "-o", out, ok=False)
    assert r.code == 2 and h.one_line(r.err) and says in r.err, r.err
    assert not out.exists()


def test_picture_step_swaps_the_picture_in_its_frame(run, write_plan, sample, tmp_path, h):
    h.png(tmp_path / "wide.png", (200, 30, 30), (400, 100))
    out = tmp_path / "out.pptx"
    run(SKILL, DECK, "edit", sample, write_plan([{"do": "picture", "slide": 5, "shape": "Logo", "path": "wide.png", "alt": "New logo"}]), "-o", out)
    old = next(s for s in h.open(sample).slides[4].shapes if s.name == "Logo")
    new = next(s for s in h.open(out).slides[4].shapes if s.name == "Logo")
    assert (new.left, new.top, new.width, new.height) == (old.left, old.top, old.width, old.height)
    assert new.image.size == (400, 100) and new.crop_left > 0.1  # cropped to fill, not stretched
    assert len([n for n in h.zip_names(out) if n.startswith("ppt/media/")]) == 1  # the old picture is gone


# --- edits: slides


def test_delete_move_and_sections(run, write_plan, sample, tmp_path, h, title_text):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "delete", "slides": "6,3"}, {"do": "move", "slides": "4", "to": 1}])
    run(SKILL, DECK, "edit", sample, plan, "-o", out)
    assert h.titles(out) == ["Table", title_text, "Growth", "Share"]
    info = run(SKILL, TOOL, "info", out).json()
    assert info["sections"] == [{"name": "Intro", "slides": [1, 2, 3]}, {"name": "Detail", "slides": [4]}]
    assert len([n for n in h.zip_names(out) if n.startswith("ppt/slides/slide")]) == 4


def test_duplicate_makes_an_independent_copy_after_the_slide(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "duplicate", "slide": 2}, {"do": "text", "slide": 3, "shape": "Title 1", "text": "Copy"},
                       {"do": "notes", "slide": 3, "text": "Copy notes"}, {"do": "duplicate", "slide": 6, "to": 1}])
    body = run(SKILL, DECK, "edit", sample, plan, "-o", out).json()
    assert body["steps"][0]["copy_is_slide"] == 3
    assert h.titles(out)[:4] == ["Table", h.title, "Growth", "Copy"]
    prs = h.open(out)
    assert prs.slides[2].notes_slide.notes_text_frame.text == "Ask Acme about the numbers"
    assert prs.slides[3].notes_slide.notes_text_frame.text == "Copy notes"
    assert prs.slides[0].shapes[2].image.size == (160, 90)  # the copied picture
    names = h.zip_names(out)
    assert len(names) == len(set(names))
    sections = run(SKILL, TOOL, "info", out).json()["sections"]
    assert sections[0] == {"name": "Intro", "slides": [1, 2, 3, 4]}


def test_duplicate_refuses_a_chart_slide(run, write_plan, sample, tmp_path, h):
    r = run(SKILL, DECK, "edit", sample, write_plan([{"do": "duplicate", "slide": 4}]), "-o", tmp_path / "o.pptx", ok=False)
    assert r.code == 2 and h.one_line(r.err) and "chart" in r.err and "add step" in r.err


def test_slides_deleted_then_added_get_their_own_parts(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "delete", "slides": "1"}, {"do": "add", "layout": "Title Only", "title": "New", "at": 2}])
    run(SKILL, DECK, "edit", sample, plan, "-o", out)
    names = h.zip_names(out)
    assert len(names) == len(set(names))
    assert h.titles(out)[:3] == ["Growth", "New", "Grouped"]


def test_hide_and_footer(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "hide", "slides": "6", "hidden": False}, {"do": "hide", "slides": "1"},
                       {"do": "footer", "slides": "2-5", "text": "Acme confidential", "number": True}])
    body = run(SKILL, DECK, "edit", sample, plan, "-o", out).json()
    assert body["ok"] is True
    prs = h.open(out)
    assert prs.slides[0]._element.get("show") == "0" and prs.slides[5]._element.get("show") is None
    types = [ph.placeholder_format.type.name for ph in prs.slides[1].placeholders]
    assert "FOOTER" in types and "SLIDE_NUMBER" in types
    footer = next(ph for ph in prs.slides[1].placeholders if ph.placeholder_format.type.name == "FOOTER")
    assert footer.text_frame.text == "Acme confidential"
    assert 'type="slidenum"' in h.read_part(out, "ppt/slides/slide2.xml")
    assert all(ph.placeholder_format.type.name != "FOOTER" for ph in prs.slides[0].placeholders)


def test_footer_on_a_layout_without_one_is_a_problem(run, write_plan, brand, tmp_path):
    plan = write_plan([{"do": "add", "layout": "Brand Blank"}, {"do": "add", "layout": "Brand Title Only", "title": "T"},
                       {"do": "footer", "text": "x"}])
    r = run(SKILL, DECK, "new", plan, "-o", tmp_path / "o.pptx", "--template", brand, ok=False)
    assert r.code == 1 and "slides 1 have no footer" in r.json()["problems"][0]


def test_add_shapes_and_delete_shape(run, write_plan, sample, tmp_path, h):
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "add_shapes", "slide": 3, "shapes": [{"type": "text", "x": 1, "y": 5, "w": 4, "h": 1, "text": "Note", "name": "Note"}]},
                       {"do": "delete_shape", "slide": 5, "shape": "Logo"}])
    run(SKILL, DECK, "edit", sample, plan, "-o", out)
    prs = h.open(out)
    assert any(s.name == "Note" for s in prs.slides[2].shapes)
    assert all(s.name != "Logo" for s in prs.slides[4].shapes)
    assert not [n for n in h.zip_names(out) if n.startswith("ppt/media/")]


# --- files, plans and failures


def test_never_writes_over_the_input_unless_asked(run, write_plan, sample, h):
    before = sample.read_bytes()
    plan = write_plan([{"do": "replace", "find": "Acme", "with": "Globex"}])
    r = run(SKILL, DECK, "edit", sample, plan, "-o", sample, ok=False)
    assert r.code == 2 and h.one_line(r.err) and "won't write over" in r.err
    assert sample.read_bytes() == before
    run(SKILL, DECK, "edit", sample, plan, "-o", sample, "--overwrite")
    assert "Acme" not in " ".join(h.texts(sample))
    assert not [p for p in sample.parent.iterdir() if p.name.startswith(".pptx_deck-")]


def test_a_macro_deck_stays_a_macro_deck(run, write_plan, sample, tmp_path, h):
    pptm = h.as_template(sample, tmp_path / "macro.pptm", macro=True)
    plan = write_plan([{"do": "hide", "slides": "1"}])
    r = run(SKILL, DECK, "edit", pptm, plan, "-o", tmp_path / "out.pptx", ok=False)
    assert r.code == 2 and ".pptm" in r.err
    run(SKILL, DECK, "edit", pptm, plan, "-o", tmp_path / "out.pptm")
    assert "macroEnabled" in h.read_part(tmp_path / "out.pptm", "[Content_Types].xml")


@pytest.mark.parametrize("encoding", ["utf-16", "utf-8-sig", "cp1252"])
def test_plans_saved_by_windows_powershell_are_read(run, write_plan, sample, tmp_path, encoding, h):
    plan = write_plan([{"do": "replace", "find": "Growth", "with": "Croissance é"}], encoding=encoding)
    body = run(SKILL, DECK, "edit", sample, plan, "-o", tmp_path / "out.pptx").json()
    assert h.titles(tmp_path / "out.pptx")[1] == "Croissance é"
    assert ("encoding_notes" in body) == (encoding == "cp1252")


@pytest.mark.parametrize("plan, says", [
    ([{"do": "explode"}], "isn't a step"),
    ([{"do": "replace", "find": "a", "replace_with": "b"}], "doesn't take replace_with"),
    ([{"do": "delete", "slides": "9"}], "past the end"),
    ([{"do": "move", "slides": "1", "to": 9}], '"to" runs from 1 to 6'),
    ([{"do": "text", "slide": 2, "shape": "Nope", "text": "x"}], "no shape 'Nope'"),
    ([{"do": "add", "layout": "Title Only", "shapes": [{"type": "text", "x": 1, "y": 1, "w": -2, "h": 1}]}], "a size is above 0"),
    ([{"do": "add", "layout": "Title Only", "shapes": [{"type": "picture", "path": "missing.png", "x": 1, "y": 1, "w": 2}]}], "no file at"),
    ([{"do": "add", "layout": "Title Only", "title": [{"text": "x", "size": 0}]}], "out of range"),
    ([{"do": "replace", "find": "a", "with": "b\nc"}], "line break"),
    ({"size": "16:9", "steps": []}, "only for new decks"),
])
def test_plan_mistakes_are_one_line_and_write_nothing(run, write_plan, sample, tmp_path, plan, says, h):
    out = tmp_path / "out.pptx"
    r = run(SKILL, DECK, "edit", sample, write_plan(plan), "-o", out, ok=False)
    assert r.code == 2 and h.one_line(r.err) and says in r.err, r.err
    assert r.out == "" and not out.exists()


def test_bad_files_are_one_line(run, write_plan, sample, tmp_path, h):
    (tmp_path / "broken.json").write_text("{not json", encoding="utf-8")
    r = run(SKILL, DECK, "edit", sample, tmp_path / "broken.json", "-o", tmp_path / "o.pptx", ok=False)
    assert r.code == 2 and h.one_line(r.err) and "isn't valid JSON" in r.err
    plan = write_plan([])
    (tmp_path / "taken.pptx").mkdir()
    r = run(SKILL, DECK, "edit", sample, plan, "-o", tmp_path / "taken.pptx", ok=False)
    assert r.code == 2 and h.one_line(r.err) and "folder" in r.err
    (tmp_path / "old.ppt").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 600)
    r = run(SKILL, DECK, "edit", tmp_path / "old.ppt", plan, "-o", tmp_path / "o.pptx", ok=False)
    assert r.code == 2 and h.one_line(r.err) and "soffice.py convert" in r.err
    h.png(tmp_path / "pic.webp")
    (tmp_path / "pic.webp").write_bytes((tmp_path / "pic.webp").read_bytes())
    from PIL import Image

    Image.new("RGB", (10, 10)).save(tmp_path / "real.webp", format="WEBP")
    r = run(SKILL, DECK, "edit", sample, write_plan([{"do": "picture", "slide": 5, "shape": "Logo", "path": "real.webp"}]), "-o", tmp_path / "o.pptx", ok=False)
    assert r.code == 2 and h.one_line(r.err) and "PNG, JPEG" in r.err


def test_the_result_opens_in_libreoffice(run, write_plan, sample, tmp_path, libreoffice):
    """A deck after deletes, moves, copies and chart changes still converts: LibreOffice reads it as a whole."""
    out = tmp_path / "out.pptx"
    plan = write_plan([{"do": "delete", "slides": "3"}, {"do": "duplicate", "slide": 2}, {"do": "move", "slides": "5", "to": 1},
                       {"do": "chart", "slide": 5, "add": {"East": [0.1, 0.1, 0.1]}}, {"do": "replace", "find": "Acme", "with": "Globex"}])
    run(SKILL, DECK, "edit", sample, plan, "-o", out)
    body = run(SKILL, TOOL, "render", out, "--out-dir", tmp_path / "looks", "--width", "320").json()
    assert [f["slide"] for f in body["files"]] == [1, 2, 3, 4, 5, 6]


def test_every_example_in_the_plan_reference_runs(run, sample, tmp_path, h):
    """The JSON in references/deck-spec.md is what agents copy: each plan runs, and each chart and table works as a
    shape."""
    import re

    from PIL import Image

    Image.new("RGB", (800, 600), (90, 140, 60)).save(tmp_path / "store.jpg")
    spec = (h.scripts.parent / "references" / "deck-spec.md").read_text(encoding="utf-8")
    blocks = [json.loads(b) for b in re.findall(r"```json\n(.*?)```", spec, re.S)]
    assert len(blocks) >= 5
    for k, block in enumerate(blocks):
        plan = tmp_path / f"example{k}.json"
        if isinstance(block, list):  # an edit plan, for a deck like the sample
            plan.write_text(json.dumps(block), encoding="utf-8")
            r = run(SKILL, DECK, "edit", sample, plan, "-o", tmp_path / f"example{k}.pptx", ok=False)
        else:
            if "steps" not in block:
                kind = "table" if "rows" in block else "chart"
                block = {"steps": [{"do": "add", "layout": "Title Only", "title": "Example",
                                    "shapes": [{"type": kind, "x": 1, "y": 1.5, "w": 8, "h": 4, kind: block}]}]}
            plan.write_text(json.dumps(block), encoding="utf-8")
            r = run(SKILL, DECK, "new", plan, "-o", tmp_path / f"example{k}.pptx", ok=False)
        assert r.code in (0, 1) and r.err == "", (k, r.err)


def test_smartart_words_are_read_and_replaced(run, write_plan, sample, tmp_path, h):
    """SmartArt keeps its words in a data part and a saved drawing; outline reads them and replace changes both."""
    from lxml import etree
    from pptx.opc.package import Part
    from pptx.opc.packuri import PackURI

    prs = h.open(sample)
    slide = prs.slides[2]
    words = ('<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" '
             'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>'
             '<dgm:pt modelId="1"><dgm:t><a:bodyPr/><a:p><a:r><a:t>Plan at Ac</a:t></a:r><a:r><a:t>me</a:t></a:r></a:p></dgm:t></dgm:pt>'
             '<dgm:pt modelId="2"><dgm:t><a:bodyPr/><a:p><a:r><a:t>Ship</a:t></a:r></a:p></dgm:t></dgm:pt>'
             '</dgm:ptLst></dgm:dataModel>')
    drawing = ('<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram" '
               'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dsp:spTree><dsp:sp><dsp:txBody>'
               '<a:p><a:r><a:t>Plan at Acme</a:t></a:r></a:p></dsp:txBody></dsp:sp></dsp:spTree></dsp:drawing>')
    data_part = Part(PackURI("/ppt/diagrams/data1.xml"), "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml", prs.part.package, words.encode())
    drawing_part = Part(PackURI("/ppt/diagrams/drawing1.xml"), "application/vnd.ms-office.drawingml.diagramDrawing+xml", prs.part.package, drawing.encode())
    rid = slide.part.relate_to(data_part, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/diagramData")
    slide.part.relate_to(drawing_part, "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing")
    frame = etree.fromstring(
        '<p:graphicFrame xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<p:nvGraphicFramePr><p:cNvPr id="40" name="Diagram 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
        '<p:xfrm><a:off x="914400" y="4572000"/><a:ext cx="4572000" cy="1371600"/></p:xfrm>'
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">'
        f'<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="{rid}" r:lo="" r:qs="" r:cs=""/>'
        '</a:graphicData></a:graphic></p:graphicFrame>')
    slide.shapes._spTree.append(frame)
    smart = tmp_path / "smart.pptx"
    prs.save(smart)
    shapes = run(SKILL, TOOL, "outline", smart, "--slides", "3").json()["slides"][0]["shapes"]
    assert next(s for s in shapes if s["kind"] == "smartart")["text"] == ["Plan at Acme", "Ship"]
    out = tmp_path / "out.pptx"
    body = run(SKILL, DECK, "edit", smart, write_plan([{"do": "replace", "find": "Acme", "with": "Globex", "slides": "3"}]), "-o", out).json()
    assert body["steps"][0]["by_place"]["smartart"] == 2
    assert "Plan at Globex" in h.read_part(out, "ppt/diagrams/drawing1.xml")
    shapes = run(SKILL, TOOL, "outline", out, "--slides", "3").json()["slides"][0]["shapes"]
    assert next(s for s in shapes if s["kind"] == "smartart")["text"] == ["Plan at Globex", "Ship"]


def test_a_picture_into_an_empty_placeholder_and_xy_chart_data(run, write_plan, tmp_path, h):
    h.png(tmp_path / "photo.png", size=(300, 200))
    plan = write_plan({"size": [10, 5.625], "steps": [
        {"do": "add", "layout": "Picture with Caption", "title": "Pic", "keep_empty": True},
        {"do": "picture", "slide": 1, "shape": "Picture Placeholder 2", "path": "photo.png", "alt": "blue"},
        {"do": "add", "layout": "Title Only", "title": "Fit", "shapes": [{"type": "chart", "name": "XY", "x": 0.5, "y": 1.2, "w": 9, "h": 4,
                                                                         "chart": {"type": "scatter", "series": {"A": [[1, 2], [3, 4]]}}}]},
        {"do": "chart", "slide": 2, "shape": "XY", "series": {"A": [[0, 0], [5, 5]], "B": [[1, 1]]}},
    ]})
    out = tmp_path / "out.pptx"
    body = run(SKILL, DECK, "new", plan, "-o", out).json()
    assert body["size_in"] == [10.0, 5.62] and body["steps"][1]["shape"] == "Picture Placeholder 2"
    slides = run(SKILL, TOOL, "outline", out).json()["slides"]
    pic = next(s for s in slides[0]["shapes"] if s["kind"] == "picture")
    assert pic["alt"] == "blue" and pic["placeholder"]["type"] == "PICTURE"
    chart = next(s for s in slides[1]["shapes"] if s["kind"] == "chart")["chart"]
    assert chart["series"] == [{"name": "A", "points": [[0.0, 0.0], [5.0, 5.0]]}, {"name": "B", "points": [[1.0, 1.0]]}]
    r = run(SKILL, DECK, "edit", out, write_plan([{"do": "chart", "slide": 2, "set": {"A": [1, 2]}}], name="p2.json"), "-o", tmp_path / "o2.pptx", ok=False)
    assert r.code == 2 and "whole data" in r.err
