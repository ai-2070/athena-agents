"""pdf_forms.py: listing, filling, flattening and building forms."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pypdf import PdfReader

SKILL, FORMS = "pdf", "pdf_forms.py"

SPEC = {
    "page_size": "A4",
    "title": "Membership form",
    "texts": [{"page": 1, "at": [72, 780], "text": "Membership form", "size": 18}],
    "fields": [
        {"name": "full_name", "type": "text", "box": [160, 700, 420, 720], "label": "Full name"},
        {"name": "notes", "type": "text", "multiline": True, "box": [160, 600, 420, 680], "label": "Notes"},
        {"name": "member", "type": "checkbox", "box": [160, 570, 174, 584], "label": "Existing member"},
        {"name": "plan", "type": "radio", "label": "Plan", "value": "basic", "options": [
            {"value": "basic", "box": [160, 540, 174, 554], "label": "Basic"},
            {"value": "pro", "box": [240, 540, 254, 554], "label": "Pro"}]},
        {"name": "country", "type": "dropdown", "box": [160, 500, 300, 518], "label": "Country",
         "options": ["UK", "Ireland"], "value": "UK"},
    ],
}


def write_json(folder: Path, name: str, data: object) -> Path:
    path = folder / name
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def by_name(result: dict) -> dict:
    return {f["name"]: f for f in result["fields"]}


@pytest.mark.parametrize("command", ["fields", "fill", "flatten", "layout", "check", "build"])
def test_every_command_has_help(run, command):
    r = run(SKILL, FORMS, command, "--help")
    assert "usage:" in r.out and "example:" in r.out


def test_fields_lists_names_types_and_accepted_values(run, form_pdf):
    r = run(SKILL, FORMS, "fields", form_pdf).json()
    assert r["count"] == 4 and r["xfa"] is False
    f = by_name(r)
    assert f["surname"]["type"] == "text" and f["surname"]["pages"] == [1]
    assert f["surname"]["rect"] == [72.0, 700.0, 372.0, 720.0]
    assert f["agree"]["type"] == "checkbox" and f["agree"]["on_value"] == "/Yes" and f["agree"]["value"] == "/Off"
    assert f["color"]["type"] == "radio" and f["color"]["options"] == ["/red", "/blue"] and f["color"]["value"] == "/blue"
    assert [w["option"] for w in f["color"]["widgets"]] == ["/red", "/blue"]
    assert f["size"]["type"] == "dropdown" and [o["value"] for o in f["size"]["options"]] == ["small", "large"]


def test_fields_shows_what_numbered_buttons_stand_for(run, tmp_path):
    """Some forms name each button's state /0, /1... and keep what it means in the field's /Opt list: fields shows
    those labels, and fill takes a label as well as a state's name."""
    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, NameObject, TextStringObject
    from reportlab.pdfgen import canvas

    plain = tmp_path / "plain.pdf"
    c = canvas.Canvas(str(plain))
    c.drawString(72, 760, "Numbered form")
    form = c.acroForm
    for name, y in (("title", 620), ("swap", 560)):
        for i, x in enumerate((72, 110)):
            form.radio(name=name, value=str(i), x=x, y=y, size=20, selected=False, fieldFlags="noToggleToOff radio")
    form.checkbox(name="agree", x=72, y=660, size=20, buttonStyle="check", fieldFlags="")
    c.save()
    writer = PdfWriter(clone_from=str(plain))
    opts = {"title": ["Ms", "Mr"], "swap": ["1", "0"], "agree": ["I agree"]}
    for ref in writer.root_object["/AcroForm"]["/Fields"]:
        field = ref.get_object()
        field[NameObject("/Opt")] = ArrayObject(TextStringObject(o) for o in opts[field["/T"]])
    form_pdf = tmp_path / "numbered.pdf"
    writer.write(str(form_pdf))

    f = by_name(run(SKILL, FORMS, "fields", form_pdf).json())
    assert f["title"]["options"] == ["/0", "/1"] and f["title"]["labels"] == {"/0": "Ms", "/1": "Mr"}
    assert [w["label"] for w in f["title"]["widgets"]] == ["Ms", "Mr"]
    assert f["agree"]["on_value"] == "/Yes" and f["agree"]["labels"] == {"/Yes": "I agree"}

    values = write_json(tmp_path, "v.json", {"title": "Mr", "agree": True})
    r = run(SKILL, FORMS, "fill", form_pdf, values, "-o", tmp_path / "filled.pdf").json()
    assert r["mismatches"] == [] and r["read_back"] == {"title": "/1", "agree": "/Yes"}
    # "1" is the label of /0 and the name of /1: refused, not guessed
    r = run(SKILL, FORMS, "fill", form_pdf, write_json(tmp_path, "a.json", {"swap": "1"}), "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "/1 or /0" in r.err and not (tmp_path / "x.pdf").exists()
    r = run(SKILL, FORMS, "fill", form_pdf, write_json(tmp_path, "b.json", {"swap": "/1"}), "-o", tmp_path / "x.pdf")
    assert r.json()["read_back"] == {"swap": "/1"}
    r = run(SKILL, FORMS, "fill", form_pdf, write_json(tmp_path, "c.json", {"title": "Dr"}), "-o", tmp_path / "y.pdf", ok=False)
    assert r.code == 2 and "/0 (Ms), /1 (Mr)" in r.err


def test_fill_then_read_back(run, form_pdf, tmp_path):
    surname = "Жукова-Smith"  # Cyrillic: printed back through the cp1252 pipe
    values = write_json(tmp_path, "values.json", {"surname": surname, "agree": True, "color": "red", "size": "large"})
    out = tmp_path / "filled.pdf"
    r = run(SKILL, FORMS, "fill", form_pdf, values, "-o", out).json()
    assert r["mismatches"] == []
    assert r["read_back"] == {"surname": surname, "agree": "/Yes", "color": "/red", "size": "large"}
    assert any("font" in w for w in r["warnings"])  # Helvetica has no Cyrillic: said in plain words
    f = by_name(run(SKILL, FORMS, "fields", out).json())
    assert f["surname"]["value"] == surname and f["color"]["value"] == "/red"
    # the radio choice is stored as a PDF name, and each button shows its own state
    reader = PdfReader(str(out))
    color = next(x.get_object() for x in reader.trailer["/Root"]["/AcroForm"]["/Fields"] if x.get_object()["/T"] == "color")
    assert type(color["/V"]).__name__ == "NameObject"
    assert [k.get_object()["/AS"] for k in color["/Kids"]] == ["/red", "/Off"]


def test_values_file_saved_by_windows_powershell(run, form_pdf, tmp_path):
    # Windows PowerShell 5.1: > and Out-File write UTF-16 with a byte-order mark; Set-Content the ANSI code page
    values = json.dumps({"surname": "Zoë Brontë"}, ensure_ascii=False)
    for name, data in (("utf16.json", values.encode("utf-16")), ("ansi.json", values.encode("cp1252"))):
        (tmp_path / name).write_bytes(data)
        r = run(SKILL, FORMS, "fill", form_pdf, tmp_path / name, "-o", tmp_path / (name + ".pdf")).json()
        assert r["read_back"] == {"surname": "Zoë Brontë"}, name
        assert ("encoding_notes" in r) == (name == "ansi.json")


def test_fill_warns_when_a_value_wont_fit_its_box(run, tmp_path):
    spec = write_json(tmp_path, "form.json", {"fields": [
        {"name": "notes", "type": "text", "multiline": True, "box": [72, 500, 272, 560]},
        {"name": "short", "type": "text", "box": [72, 450, 172, 470]}]})
    form = tmp_path / "form.pdf"
    run(SKILL, FORMS, "build", spec, "-o", form)
    long_values = write_json(tmp_path, "long.json", {
        "notes": "1\n2\n3\n4\n5\n6\n7",  # seven lines of 10 pt text in a 60 pt box
        "short": "A value that is far too long for this small box"})
    r = run(SKILL, FORMS, "fill", form, long_values, "-o", tmp_path / "filled.pdf", "--flatten").json()
    said = " | ".join(r["warnings"])
    assert "notes: the value is more lines than its box holds" in said
    assert "short: the value is wider than its box" in said
    fitting = write_json(tmp_path, "fits.json", {"notes": "1\n2\n3", "short": "Ada"})
    assert run(SKILL, FORMS, "fill", form, fitting, "-o", tmp_path / "ok.pdf").json()["warnings"] == []


def test_password_protected_form(run, form_pdf, tmp_path):
    locked = tmp_path / "locked.pdf"
    run(SKILL, "pdf_tool.py", "encrypt", form_pdf, "--user-password", "pw 1", "-o", locked)
    r = run(SKILL, FORMS, "fields", locked, ok=False)
    assert r.code == 2 and "--password-file" in r.err
    pw = tmp_path / "pw.txt"
    pw.write_text("pw 1\n", encoding="utf-8")
    assert run(SKILL, FORMS, "fields", locked, "--password-file", pw).json()["count"] == 4
    values = write_json(tmp_path, "v.json", {"surname": "Locked"})
    r = run(SKILL, FORMS, "fill", locked, values, "--password-file", pw, "-o", tmp_path / "filled.pdf").json()
    assert r["mismatches"] == [] and "password-protected" in r["unprotected_copy"]  # said as pdf_tool.py says it


def test_fill_refuses_unknown_names_and_values_it_cant_take(run, form_pdf, tmp_path):
    out = tmp_path / "filled.pdf"
    values = write_json(tmp_path, "bad.json", {"surnme": "x", "color": "green", "size": "huge"})
    r = run(SKILL, FORMS, "fill", form_pdf, values, "-o", out, ok=False)
    assert r.code == 2
    assert "'surname'" in r.err  # did you mean
    assert "/red" in r.err and "small" in r.err
    assert not out.exists()


def test_fill_refuses_to_write_over_the_form(run, form_pdf, tmp_path):
    values = write_json(tmp_path, "v.json", {"surname": "x"})
    before = form_pdf.read_bytes()
    r = run(SKILL, FORMS, "fill", form_pdf, values, "-o", form_pdf, ok=False)
    assert r.code == 2 and "won't write over the input" in r.err
    assert form_pdf.read_bytes() == before


def centre_darkness(pdf: Path, box: list[float], page: int = 1) -> float:
    """Mean darkness (0 white .. 255 black) of the middle of a box on a rendered page."""
    pdfium = pytest.importorskip("pypdfium2")
    doc = pdfium.PdfDocument(str(pdf))
    try:
        p = doc[page - 1]
        height = p.get_height()
        image = p.render(scale=4).to_pil().convert("L")
    finally:
        doc.close()
    cx, cy = (box[0] + box[2]) / 2 * 4, (height - (box[1] + box[3]) / 2) * 4
    crop = image.crop((int(cx - 4), int(cy - 4), int(cx + 4), int(cy + 4)))
    pixels = crop.tobytes()
    return 255 - sum(pixels) / len(pixels)


def test_flatten_really_flattens(run, form_pdf, tmp_path):
    values = write_json(tmp_path, "values.json", {"surname": "Smith & Sons", "agree": True, "color": "red", "size": "large"})
    filled = tmp_path / "filled.pdf"
    run(SKILL, FORMS, "fill", form_pdf, values, "-o", filled)
    flat = tmp_path / "flat.pdf"
    r = run(SKILL, FORMS, "flatten", filled, "-o", flat).json()
    assert r["fields_left"] == 0 and r["widgets_flattened"] == 5

    reader = PdfReader(str(flat))
    assert "/AcroForm" not in reader.trailer["/Root"]
    assert not [a for a in reader.pages[0].get("/Annots", []) if a.get_object().get("/Subtype") == "/Widget"]
    text = reader.pages[0].extract_text()
    assert "Smith & Sons" in text and "large" in text
    # only the chosen radio button is drawn as chosen (pypdf's own flatten draws both)
    red, blue = [72, 620, 92, 640], [110, 620, 130, 640]
    assert centre_darkness(flat, red) > 100 > centre_darkness(flat, blue)


def test_flatten_leaves_out_buttons_that_dont_print(run, form_pdf, tmp_path):
    """A "Print form" button is an on-screen control: Acrobat doesn't print it, and a flattened copy leaves it out."""
    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, TextStringObject

    writer = PdfWriter(clone_from=str(form_pdf))
    look = DecodedStreamObject()
    look.set_data(b"0 0 0 rg 0 0 100 30 re f")
    look.update({NameObject("/Type"): NameObject("/XObject"), NameObject("/Subtype"): NameObject("/Form"),
                 NameObject("/BBox"): ArrayObject([NumberObject(0), NumberObject(0), NumberObject(100), NumberObject(30)])})
    button = DictionaryObject({
        NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"),
        NameObject("/FT"): NameObject("/Btn"), NameObject("/Ff"): NumberObject(1 << 16), NameObject("/F"): NumberObject(0),
        NameObject("/T"): TextStringObject("print_button"),
        NameObject("/Rect"): ArrayObject([NumberObject(400), NumberObject(100), NumberObject(500), NumberObject(130)]),
        NameObject("/AP"): DictionaryObject({NameObject("/N"): writer._add_object(look)})})
    ref = writer._add_object(button)
    writer.pages[0]["/Annots"].append(ref)
    writer.root_object["/AcroForm"]["/Fields"].append(ref)
    with_button = tmp_path / "with-button.pdf"
    writer.write(str(with_button))
    assert "print_button" in by_name(run(SKILL, FORMS, "fields", with_button).json())

    flat = tmp_path / "flat.pdf"
    r = run(SKILL, FORMS, "flatten", with_button, "-o", flat).json()
    assert r["fields_left"] == 0 and r["widgets_flattened"] == 5  # the form's own five, not the button
    assert centre_darkness(flat, [400, 100, 500, 130]) < 10


def test_fill_and_flatten_in_one_go(run, form_pdf, tmp_path):
    values = write_json(tmp_path, "values.json", {"surname": "Lovelace", "color": "blue"})
    out = tmp_path / "done.pdf"
    r = run(SKILL, FORMS, "fill", form_pdf, values, "-o", out, "--flatten").json()
    assert r["flattened"] is True and r["values_on_page"] == {"surname": True}
    assert PdfReader(str(out)).get_fields() is None


def test_form_without_fields_points_to_layout(run, tmp_path):
    from reportlab.pdfgen import canvas

    plain = tmp_path / "plain.pdf"
    c = canvas.Canvas(str(plain))
    c.drawString(72, 700, "Name:")
    c.save()
    r = run(SKILL, FORMS, "fields", plain).json()
    assert r["count"] == 0 and "layout" in r["note"]
    values = write_json(tmp_path, "v.json", {"name": "x"})
    r = run(SKILL, FORMS, "fill", plain, values, "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "no fillable fields" in r.err


def test_check_passes_a_good_spec_and_draws_it(run, tmp_path):
    pytest.importorskip("PIL")
    spec = write_json(tmp_path, "form.json", SPEC)
    overlay = tmp_path / "check.png"
    r = run(SKILL, FORMS, "check", spec, "--overlay", overlay, "--grid", "50", "--dpi", "72").json()
    assert r["ok"] is True and r["errors"] == 0 and r["fields"] == 6  # the radio group is two boxes
    from PIL import Image

    with Image.open(overlay) as im:
        assert abs(im.width - 595) <= 1 and abs(im.height - 842) <= 1


def test_check_finds_the_usual_mistakes(run, tmp_path):
    bad = {"page_size": "A4", "fields": [
        {"name": "wide", "type": "text", "box": [100, 700, 900, 720]},
        {"name": "one", "type": "text", "box": [100, 600, 300, 620]},
        {"name": "two", "type": "text", "box": [200, 610, 400, 630]},
        {"name": "one", "type": "checkbox", "box": [100, 500, 110, 510]},
        {"name": "solo", "type": "radio", "options": [{"value": "a", "box": [100, 400, 110, 410]}]},
        {"name": "pick", "type": "dropdown", "box": [100, 300, 200, 320], "options": ["x"], "value": "y"},
        {"name": "flat", "type": "text", "box": [100, 200, 300, 205]},
        {"name": "far", "type": "text", "page": 3, "box": [100, 100, 200, 120]},
        {"name": "Имя", "type": "text", "box": [100, 150, 200, 170], "label": "Имя"},
    ]}
    r = run(SKILL, FORMS, "check", write_json(tmp_path, "bad.json", bad), ok=False)
    assert r.code == 1
    report = r.json()
    assert report["ok"] is False
    said = " | ".join(f"{p['where']}: {p['message']}" for p in report["problems"])
    assert "(wide)" in said and "runs off the page" in said
    assert "(two)" in said and "overlaps 'one'" in said
    assert "used twice" in said
    assert "at least two options" in said
    assert "isn't one of the options" in said
    assert "pt tall" in said
    assert "page 3 doesn't exist" not in said  # page 3 makes the form three pages long
    assert "can't draw" in said


def test_build_a_new_form_then_fill_it(run, tmp_path):
    spec = write_json(tmp_path, "form.json", SPEC)
    out = tmp_path / "membership.pdf"
    r = run(SKILL, FORMS, "build", spec, "-o", out).json()
    assert r["built"] is True and r["missing"] == []
    assert r["fields"] == {"full_name": "text", "notes": "text", "member": "checkbox", "plan": "radio", "country": "dropdown"}
    text = PdfReader(str(out)).pages[0].extract_text()
    assert "Full name" in text and "Membership form" in text and "Existing member" in text

    f = by_name(run(SKILL, FORMS, "fields", out).json())
    assert f["plan"]["value"] == "/basic" and f["plan"]["options"] == ["/basic", "/pro"]
    assert f["notes"]["multiline"] is True and f["full_name"]["max_length"] is None

    values = write_json(tmp_path, "v.json", {"full_name": "Ada", "member": True, "plan": "pro", "country": "Ireland"})
    r = run(SKILL, FORMS, "fill", out, values, "-o", tmp_path / "filled.pdf").json()
    assert r["mismatches"] == [] and r["read_back"]["plan"] == "/pro"


def test_check_refuses_a_grid_or_resolution_below_one(run, tmp_path):
    spec = write_json(tmp_path, "s.json", {"fields": [{"name": "a", "type": "text", "box": [100, 700, 300, 720]}]})
    r = run(SKILL, FORMS, "check", spec, "--overlay", tmp_path / "o.png", "--grid", "-5", ok=False)  # it never ended
    assert r.code == 2 and "--grid" in r.err
    r = run(SKILL, FORMS, "check", spec, "--overlay", tmp_path / "o.png", "--dpi", "0", ok=False)
    assert r.code == 2 and "--dpi" in r.err


def test_build_writes_an_empty_value_for_null(run, tmp_path):
    spec = write_json(tmp_path, "s.json", {"fields": [{"name": "a", "type": "text", "box": [100, 700, 300, 720], "value": None}]})
    out = tmp_path / "x.pdf"
    run(SKILL, FORMS, "build", spec, "-o", out)
    assert by_name(run(SKILL, FORMS, "fields", out).json())["a"]["value"] == ""


def test_skip_check_doesnt_get_past_a_field_with_parts_missing(run, tmp_path):
    spec = write_json(tmp_path, "s.json", {"fields": [{"name": "a", "type": "text"}]})
    out = tmp_path / "x.pdf"
    r = run(SKILL, FORMS, "build", spec, "-o", out, "--skip-check", ok=False)
    assert r.code == 2 and "field 1" in r.err and "Traceback" not in r.err
    assert not out.exists()


def test_build_stops_when_the_check_finds_errors(run, tmp_path):
    bad = {"fields": [{"name": "a", "type": "text", "box": [100, 700, 300, 720]},
                      {"name": "b", "type": "text", "box": [150, 705, 350, 725]}]}
    out = tmp_path / "x.pdf"
    r = run(SKILL, FORMS, "build", write_json(tmp_path, "bad.json", bad), "-o", out, ok=False)
    assert r.code == 1 and r.json()["built"] is False
    assert not out.exists()


def test_layout_then_build_over_a_printed_form(run, tmp_path):
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    paper = tmp_path / "paper.pdf"
    c = canvas.Canvas(str(paper), pagesize=letter)
    c.setFont("Helvetica", 11)
    c.drawString(72, 700, "Name:")
    c.line(120, 698, 400, 698)
    c.drawString(72, 670, "Company:")
    c.rect(140, 664, 260, 18)
    c.save()

    layout = run(SKILL, FORMS, "layout", paper).json()["pages"][0]
    name = next(ln for ln in layout["text_lines"] if ln["text"] == "Name:")
    assert name["box"][0] == 72.0 and name["box"][1] < 700 < name["box"][3]
    assert {"box": [140.0, 664.0, 400.0, 682.0]} in layout["boxes"]
    assert {"box": [120.0, 698.0, 400.0, 698.0]} in layout["rules"]

    spec = write_json(tmp_path, "fields.json", {"fields": [
        {"name": "name", "type": "text", "box": [122, 699, 400, 715]},
        {"name": "company", "type": "text", "box": [141, 665, 399, 681]},
    ]})
    out = tmp_path / "fillable.pdf"
    r = run(SKILL, FORMS, "build", spec, "--on", paper, "-o", out).json()
    assert r["fields"] == {"name": "text", "company": "text"}
    reader = PdfReader(str(out))
    assert round(float(reader.pages[0].mediabox.width)) == 612
    assert "Company:" in reader.pages[0].extract_text()  # the printed page is still there, under the fields

    values = write_json(tmp_path, "v.json", {"name": "Ada Lovelace", "company": "R&D <Ltd>"})
    done = tmp_path / "done.pdf"
    r = run(SKILL, FORMS, "fill", out, values, "-o", done, "--flatten").json()
    assert r["values_on_page"] == {"name": True, "company": True}


def test_check_overlay_over_the_pdf(run, form_pdf, tmp_path):
    pytest.importorskip("pypdfium2")
    spec = write_json(tmp_path, "s.json", {"fields": [{"name": "extra", "type": "text", "box": [300, 400, 500, 420]}]})
    overlay = tmp_path / "over.png"
    r = run(SKILL, FORMS, "check", spec, "--on", form_pdf, "--overlay", overlay, "--dpi", "50").json()
    assert r["overlay"]["notes"] == [] and overlay.is_file()
    # --pdf is the older name for the same thing
    assert run(SKILL, FORMS, "check", spec, "--pdf", form_pdf, "--overlay", overlay, "--dpi", "50").json()["ok"]


def test_build_refuses_a_page_that_doesnt_start_at_the_origin(run, tmp_path):
    """A page whose MediaBox starts at (100, 100): building over it shifted the printed page against the fields."""
    from pypdf import PdfWriter
    from pypdf.generic import RectangleObject

    paper = tmp_path / "offset.pdf"
    writer = PdfWriter()
    writer.add_blank_page(400, 200).mediabox = RectangleObject([100, 100, 500, 300])
    writer.write(str(paper))
    spec = write_json(tmp_path, "s.json", {"fields": [{"name": "n", "type": "text", "box": [150, 160, 300, 175]}]})
    out = tmp_path / "x.pdf"
    r = run(SKILL, FORMS, "build", spec, "--on", paper, "-o", out, ok=False)
    assert r.code == 1 and not out.exists()
    assert any("(100, 100)" in p["message"] for p in r.json()["check"]["problems"])
