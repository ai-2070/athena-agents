"""pdf_tool.py: every subcommand on real PDFs."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from pypdf import PdfReader

SKILL, TOOL = "pdf", "pdf_tool.py"
COMMANDS = ["info", "text", "tables", "merge", "pick", "split", "rotate", "stamp", "encrypt", "decrypt", "meta",
            "attach", "attachments", "images", "render", "compress"]


def page_texts(path: Path) -> list[str]:
    return [p.extract_text() or "" for p in PdfReader(str(path)).pages]


@pytest.mark.parametrize("command", COMMANDS)
def test_every_command_has_help(run, command):
    r = run(SKILL, TOOL, command, "--help")
    assert "usage:" in r.out and "example:" in r.out


def test_info_reports_pages_metadata_and_scanned_pages(run, report_pdf, report_title):
    info = run(SKILL, TOOL, "info", report_pdf).json()
    assert info["pages"] == 3
    assert info["metadata"]["Title"] == report_title
    assert info["encrypted"] is False
    assert info["no_text_pages"] == [3]
    assert info["scanned_pages"] == [3]
    first = info["page_details"][0]
    assert first["page"] == 1 and round(first["width_pt"]) == 595 and first["rotation"] == 0
    assert "note" in info


@pytest.mark.parametrize("engine", ["pdfplumber", "pypdf"])
def test_text_pages_are_numbered_from_one(run, report_pdf, engine):
    r = run(SKILL, TOOL, "text", report_pdf, "--pages", "2", "--engine", engine).json()
    assert [p["page"] for p in r["pages"]] == [2]
    assert "BETAMARK" in r["pages"][0]["text"]
    assert r["engine"] == engine


def test_text_can_go_to_a_file(run, report_pdf, tmp_path):
    out = tmp_path / "report.txt"
    r = run(SKILL, TOOL, "text", report_pdf, "--out", out).json()
    body = out.read_text(encoding="utf-8")
    assert "--- page 1 ---" in body and "ALPHAMARK" in body and "--- page 2 ---" in body
    assert "text" not in r["pages"][0]
    assert r["no_text_pages"] == [3]


def test_bad_page_numbers_are_refused(run, report_pdf):
    r = run(SKILL, TOOL, "text", report_pdf, "--pages", "0", ok=False)
    assert r.code == 2 and "numbered from 1" in r.err
    r = run(SKILL, TOOL, "text", report_pdf, "--pages", "2-9", ok=False)
    assert r.code == 2 and "past the end" in r.err


def test_tables_give_rows_and_csv(run, report_pdf, tmp_path):
    r = run(SKILL, TOOL, "tables", report_pdf, "--pages", "1", "--csv-dir", tmp_path / "csv").json()
    assert r["tables"], r
    table = r["tables"][0]
    assert table["page"] == 1
    assert table["rows"][0] == ["Region", "Units"]
    assert ["North", "1250"] in table["rows"]
    assert "Region,Units" in Path(table["csv"]).read_text(encoding="utf-8-sig")


def test_merge_keeps_order_and_adds_bookmarks(run, report_pdf, form_pdf, tmp_path):
    out = tmp_path / "merged.pdf"
    r = run(SKILL, TOOL, "merge", report_pdf, form_pdf, "-o", out, "--bookmarks").json()
    assert r["pages"] == 4
    assert [i["first_page"] for i in r["inputs"]] == [1, 4]
    titles = [item.title for item in PdfReader(str(out)).outline]
    assert titles == ["report", "form"]


def test_pick_reorders_and_drop_leaves_out(run, report_pdf, tmp_path):
    out = tmp_path / "picked.pdf"
    r = run(SKILL, TOOL, "pick", report_pdf, "--pages", "2,1", "-o", out).json()
    assert r["from_pages"] == [2, 1]
    texts = page_texts(out)
    assert "BETAMARK" in texts[0] and "ALPHAMARK" in texts[1]
    out2 = tmp_path / "dropped.pdf"
    run(SKILL, TOOL, "pick", report_pdf, "--drop", "1,3", "-o", out2)
    assert len(PdfReader(str(out2)).pages) == 1 and "BETAMARK" in page_texts(out2)[0]


def test_split_refuses_the_same_range_twice(run, report_pdf, tmp_path):
    r = run(SKILL, TOOL, "split", report_pdf, "--ranges", "1-2,1-2", "--out-dir", tmp_path / "parts", ok=False)
    assert r.code == 2 and "twice" in r.err


def test_split_by_page_and_by_range(run, report_pdf, tmp_path):
    r = run(SKILL, TOOL, "split", report_pdf, "--out-dir", tmp_path / "each").json()
    assert [f["pages"] for f in r["files"]] == [[1], [2], [3]]
    assert Path(r["files"][1]["file"]).name == "report_p2.pdf"
    r = run(SKILL, TOOL, "split", report_pdf, "--ranges", "1-2,3", "--out-dir", tmp_path / "ranges").json()
    assert [f["pages"] for f in r["files"]] == [[1, 2], [3]]
    assert len(PdfReader(r["files"][0]["file"]).pages) == 2


@pytest.mark.parametrize("args, option", [
    (["stamp", "--text", "X", "--size", "0"], "--size"),
    (["stamp", "--text", "X", "--size", "-5"], "--size"),
    (["stamp", "--image", "IMAGE", "--width", "0"], "--width"),
    (["stamp", "--image", "IMAGE", "--width", "-50"], "--width"),
    (["split", "--every", "0"], "--every"),
])
def test_number_options_below_one_are_refused(run, report_pdf, png, tmp_path, args, option):
    """A zero or negative size drew nothing or a mirror image, and --every 0 quietly split one page per file."""
    args = [str(png) if a == "IMAGE" else a for a in args]
    where = ["--out-dir", tmp_path / "parts"] if args[0] == "split" else ["-o", tmp_path / "out.pdf"]
    r = run(SKILL, TOOL, args[0], report_pdf, *args[1:], *where, ok=False)
    assert r.code == 2 and option in r.err and "Traceback" not in r.err
    assert not (tmp_path / "out.pdf").exists() and not (tmp_path / "parts").exists()


def test_rotate_turns_only_the_chosen_pages(run, report_pdf, tmp_path):
    out = tmp_path / "turned.pdf"
    run(SKILL, TOOL, "rotate", report_pdf, "--degrees", "90", "--pages", "2", "-o", out)
    assert [p.rotation for p in PdfReader(str(out)).pages] == [0, 90, 0]
    r = run(SKILL, TOOL, "rotate", report_pdf, "--degrees", "45", "-o", tmp_path / "x.pdf", ok=False)
    assert r.code == 2 and "multiple of 90" in r.err


def test_never_writes_over_its_input_unless_told(run, report_pdf):
    before = report_pdf.read_bytes()
    r = run(SKILL, TOOL, "rotate", report_pdf, "--degrees", "90", "-o", report_pdf, ok=False)
    assert r.code == 2 and "won't write over the input" in r.err
    assert report_pdf.read_bytes() == before
    run(SKILL, TOOL, "rotate", report_pdf, "--degrees", "90", "-o", report_pdf, "--overwrite")
    assert [p.rotation for p in PdfReader(str(report_pdf)).pages] == [90, 90, 90]
    assert not list(report_pdf.parent.glob("*.part"))


def test_stamp_text_on_chosen_pages(run, report_pdf, tmp_path):
    out = tmp_path / "stamped.pdf"
    r = run(SKILL, TOOL, "stamp", report_pdf, "--text", "STAMPMARK", "--x", "72", "--y", "300", "--pages", "1",
            "-o", out).json()
    assert r["stamped_pages"] == [1]
    texts = page_texts(out)
    assert "STAMPMARK" in texts[0] and "STAMPMARK" not in texts[1]


def test_stamp_watermark_centred_and_rotated(run, report_pdf, tmp_path):
    out = tmp_path / "draft.pdf"
    run(SKILL, TOOL, "stamp", report_pdf, "--text", "DRAFT", "--size", "72", "--angle", "45", "--opacity", "0.25", "-o", out)
    assert all("DRAFT" in t for t in page_texts(out))


def ink_box(pdf: Path, page: int = 1) -> tuple[tuple[int, int], tuple[int, int, int, int]]:
    """The page's size as shown (in points) and the box around everything drawn darker than light grey."""
    pdfium = pytest.importorskip("pypdfium2")
    doc = pdfium.PdfDocument(str(pdf))
    try:
        image = doc[page - 1].render(scale=1).to_pil().convert("L")
    finally:
        doc.close()
    return image.size, image.point(lambda v: 255 if v < 200 else 0).getbbox()


def test_stamp_reads_upright_on_a_turned_page(run, tmp_path):
    """A scan put upright with /Rotate gets its watermark the right way up, and --x/--y count from the corner
    the reader sees."""
    from pypdf import PdfWriter

    turned = tmp_path / "turned.pdf"
    writer = PdfWriter()
    writer.add_blank_page(400, 200).rotate(90)  # shown 200 wide, 400 tall
    writer.write(str(turned))
    out = tmp_path / "stamped.pdf"
    run(SKILL, TOOL, "stamp", turned, "--text", "WWWWWW", "--size", "30", "-o", out)
    size, (x0, y0, x1, y1) = ink_box(out)
    assert size == (200, 400) and x1 - x0 > 3 * (y1 - y0)  # wide and flat: the text runs across
    out2 = tmp_path / "corner.pdf"
    run(SKILL, TOOL, "stamp", turned, "--text", "WWW", "--size", "30", "--x", "10", "--y", "20", "-o", out2)
    _, (x0, y0, x1, y1) = ink_box(out2)
    assert x0 < 20 and 400 - y1 < 30 and x1 - x0 > y1 - y0  # near the lower-left corner as shown, upright


def test_stamp_letters_outside_helvetica_need_a_font(run, report_pdf, tmp_path, vera_ttf):
    out = tmp_path / "pl.pdf"
    r = run(SKILL, TOOL, "stamp", report_pdf, "--text", "Łask π ≤ 2", "-o", out, ok=False)
    assert r.code == 2 and "--font" in r.err and "Ł" in r.err
    assert not out.exists()
    run(SKILL, TOOL, "stamp", report_pdf, "--text", "Łask π ≤ 2", "--font", vera_ttf, "--x", "72", "--y", "300", "-o", out)
    text = run(SKILL, TOOL, "text", out, "--pages", "1").json()["pages"][0]["text"]
    assert "Łask" in text and "π" in text


def test_stamp_image_and_pdf_underneath(run, report_pdf, png, tmp_path):
    out = tmp_path / "signed.pdf"
    run(SKILL, TOOL, "stamp", report_pdf, "--image", png, "--x", "400", "--y", "60", "--width", "100", "--pages", "2",
        "-o", out)
    pages = PdfReader(str(out)).pages
    assert len(pages[1].images) == 1 and len(pages[0].images) == 1  # page 1 already had one picture

    from reportlab.pdfgen import canvas

    letterhead = tmp_path / "letterhead.pdf"
    c = canvas.Canvas(str(letterhead))
    c.drawString(72, 810, "LETTERHEADMARK")
    c.save()
    out2 = tmp_path / "headed.pdf"
    r = run(SKILL, TOOL, "stamp", report_pdf, "--pdf", letterhead, "--under", "--pages", "1-2", "-o", out2).json()
    assert r["under"] is True
    texts = page_texts(out2)
    assert "LETTERHEADMARK" in texts[0] and "LETTERHEADMARK" not in texts[2]


def test_encrypt_and_decrypt(run, report_pdf, tmp_path):
    locked = tmp_path / "locked.pdf"
    r = run(SKILL, TOOL, "encrypt", report_pdf, "--user-password", "open sesame", "--owner-password", "owner-only",
            "--allow", "print", "-o", locked).json()
    assert r["algorithm"] == "AES-256" and r["needs_password_to_open"] is True

    r = run(SKILL, TOOL, "info", locked, ok=False)
    assert r.code == 2 and "needs a password" in r.err
    r = run(SKILL, TOOL, "info", locked, "--password", "wrong", ok=False)
    assert r.code == 2 and "wrong password" in r.err

    pw = tmp_path / "pw.txt"
    pw.write_text("open sesame\n", encoding="utf-8")
    info = run(SKILL, TOOL, "info", locked, "--password-file", pw).json()
    assert info["encrypted"] is True
    assert info["permissions"]["print"] is True and info["permissions"]["modify"] is False

    opened = tmp_path / "opened.pdf"
    run(SKILL, TOOL, "decrypt", locked, "--password", "open sesame", "-o", opened)
    assert PdfReader(str(opened)).is_encrypted is False
    assert "ALPHAMARK" in page_texts(opened)[0]


def test_password_file_saved_by_windows_powershell(run, report_pdf, tmp_path):
    # Windows PowerShell 5.1: > and Out-File write UTF-16 with a byte-order mark; Set-Content the ANSI code page
    locked = tmp_path / "locked.pdf"
    run(SKILL, TOOL, "encrypt", report_pdf, "--user-password", "café 1", "-o", locked)
    for name, data in (("utf16.txt", "café 1\r\n".encode("utf-16")), ("ansi.txt", "café 1\r\n".encode("cp1252"))):
        (tmp_path / name).write_bytes(data)
        info = run(SKILL, TOOL, "info", locked, "--password-file", tmp_path / name).json()
        assert info["pages"] == 3
        assert "café" not in json.dumps(info)  # the password never comes back in the output


def test_file_problems_are_one_line(run, report_pdf, tmp_path):
    (tmp_path / "taken.pdf").mkdir()
    r = run(SKILL, TOOL, "rotate", report_pdf, "--degrees", "90", "-o", tmp_path / "taken.pdf", ok=False)
    assert r.code == 2 and "taken.pdf" in r.err and "Traceback" not in r.err
    assert not list(tmp_path.glob(".pdf_tool-*"))
    (tmp_path / "a-file").write_text("x", encoding="utf-8")
    r = run(SKILL, TOOL, "rotate", report_pdf, "--degrees", "90", "-o", tmp_path / "a-file" / "out.pdf", ok=False)
    assert r.code == 2 and "Traceback" not in r.err and len(r.err.strip().splitlines()) == 1


def test_lifting_restrictions_needs_saying_so(run, report_pdf, tmp_path):
    restricted = tmp_path / "restricted.pdf"
    r = run(SKILL, TOOL, "encrypt", report_pdf, "--owner-password", "author-only", "--allow", "print", "-o", restricted).json()
    assert r["needs_password_to_open"] is False
    assert run(SKILL, TOOL, "info", restricted).json()["permissions"]["extract"] is False
    out = tmp_path / "free.pdf"
    r = run(SKILL, TOOL, "decrypt", restricted, "-o", out, ok=False)
    assert r.code == 2 and "--lift-restrictions" in r.err and not out.exists()
    run(SKILL, TOOL, "decrypt", restricted, "-o", out, "--lift-restrictions")
    assert PdfReader(str(out)).is_encrypted is False


def test_a_copy_of_a_locked_file_says_it_is_unprotected(run, report_pdf, tmp_path):
    locked = tmp_path / "locked.pdf"
    run(SKILL, TOOL, "encrypt", report_pdf, "--user-password", "pw", "-o", locked)
    r = run(SKILL, TOOL, "rotate", locked, "--password", "pw", "--degrees", "180", "-o", tmp_path / "turned.pdf").json()
    assert "unprotected_copy" in r


def test_meta_sets_and_clears(run, report_pdf, tmp_path):
    out = tmp_path / "meta.pdf"
    r = run(SKILL, TOOL, "meta", report_pdf, "--title", "Ζήτω Q3", "--author", "Finance", "-o", out).json()
    assert r["metadata"]["Title"] == "Ζήτω Q3" and r["metadata"]["Author"] == "Finance"
    cleared = tmp_path / "cleared.pdf"
    r = run(SKILL, TOOL, "meta", out, "--clear", "-o", cleared).json()
    assert "Title" not in r["metadata"] and "Author" not in r["metadata"]


def test_attach_list_and_extract(run, report_pdf, tmp_path):
    data = tmp_path / "данные.csv"
    data.write_text("a,b\n1,2\n", encoding="utf-8")
    out = tmp_path / "with-data.pdf"
    r = run(SKILL, TOOL, "attach", report_pdf, "--add", data, "-o", out).json()
    assert r["attachments"] == ["данные.csv"]
    r = run(SKILL, TOOL, "attachments", out, "--out-dir", tmp_path / "got").json()
    assert r["attachments"][0]["name"] == "данные.csv"
    assert r["saved"][0]["name"] == "данные.csv"
    assert Path(r["saved"][0]["file"]).read_text(encoding="utf-8") == "a,b\n1,2\n"


def test_attachment_names_never_replace_a_file(run, report_pdf, tmp_path):
    """The names come from inside the PDF: one named like the PDF itself, like each other (Windows and macOS ignore
    case), or like a Windows device must not replace anything."""
    from pypdf import PdfWriter

    folder = tmp_path / "work"
    folder.mkdir()
    pdf = folder / "invoice.pdf"
    writer = PdfWriter(clone_from=str(report_pdf))
    attached = {"invoice.pdf": b"one", "../../escape.txt": b"two", "a:b.txt": b"three", "a_b.txt": b"four",
                "A_B.TXT": b"five", "CON": b"six", "nul.txt": b"seven"}
    for name, data in attached.items():
        writer.add_attachment(name, data)
    writer.write(str(pdf))
    before = pdf.read_bytes()
    r = run(SKILL, TOOL, "attachments", pdf, "--out-dir", folder).json()
    assert pdf.read_bytes() == before
    saved = {e["name"]: Path(e["file"]) for e in r["saved"]}
    assert len({p.name.lower() for p in saved.values()}) == 7
    assert all(p.parent == folder for p in saved.values())
    assert {name: p.read_bytes() for name, p in saved.items()} == attached
    assert saved["invoice.pdf"].name == "invoice_2.pdf"
    assert saved["CON"].name == "_CON" and saved["nul.txt"].name == "_nul.txt"


def test_images_are_saved(run, report_pdf, tmp_path):
    r = run(SKILL, TOOL, "images", report_pdf, "--pages", "1", "--out-dir", tmp_path / "pics").json()
    assert len(r["images"]) == 1
    image = r["images"][0]
    assert image["page"] == 1 and (image["width_px"], image["height_px"]) == (120, 80)
    assert Path(image["file"]).stat().st_size > 0


def test_render_draws_pages_at_the_asked_resolution(run, report_pdf, tmp_path):
    pytest.importorskip("pypdfium2")
    r = run(SKILL, TOOL, "render", report_pdf, "--pages", "2", "--dpi", "72", "--out-dir", tmp_path / "png").json()
    assert r["renderer"] == "pypdfium2" and r["pixels_per_point"] == 1
    page = r["files"][0]
    assert page["page"] == 2 and abs(page["width_px"] - 595) <= 1 and Path(page["file"]).name == "report_p2.png"


def test_render_refuses_a_resolution_below_one(run, report_pdf, tmp_path):
    r = run(SKILL, TOOL, "render", report_pdf, "--dpi", "0", "--out-dir", tmp_path / "png", ok=False)
    assert r.code == 2 and "--dpi" in r.err and "Traceback" not in r.err


def test_render_without_a_renderer_says_what_to_install(run, report_pdf, tmp_path, hide):
    empty = tmp_path / "empty-path"
    empty.mkdir()
    env = {**hide("pypdfium2"), "PATH": str(empty)}
    r = run(SKILL, TOOL, "render", report_pdf, "--out-dir", tmp_path / "png", ok=False, env=env)
    assert r.code == 2
    assert "pip install pypdfium2" in r.err and "pdftoppm" in r.err


@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="Poppler's pdftoppm isn't installed")
def test_render_falls_back_to_pdftoppm(run, report_pdf, tmp_path, hide):
    r = run(SKILL, TOOL, "render", report_pdf, "--pages", "1", "--dpi", "50", "--out-dir", tmp_path / "png",
            env=hide("pypdfium2")).json()
    assert r["renderer"] == "pdftoppm" and Path(r["files"][0]["file"]).is_file()


def test_missing_pypdf_gives_an_install_hint(run, report_pdf, hide):
    r = run(SKILL, TOOL, "info", report_pdf, ok=False, env=hide("pypdf"))
    assert r.code == 2 and "python -m pip install pypdf" in r.err


def test_an_old_pypdf_is_named(run, report_pdf, tmp_path):
    stub = tmp_path / "old-packages" / "pypdf"
    stub.mkdir(parents=True)
    (stub / "__init__.py").write_text('__version__ = "5.9.0"\n', encoding="utf-8")
    r = run(SKILL, TOOL, "info", report_pdf, ok=False, env={"PYTHONPATH": str(stub.parent)})
    assert r.code == 2 and "pypdf 6 or newer" in r.err and "--upgrade pypdf" in r.err


def test_compress_never_makes_a_picture_bigger_and_does_each_once(run, tmp_path):
    from PIL import Image
    from reportlab.pdfgen import canvas

    noise = Image.effect_noise((600, 400), 60).convert("RGB")
    noise.save(tmp_path / "photo.jpg", quality=30)
    pdf = tmp_path / "album.pdf"
    c = canvas.Canvas(str(pdf))
    for _ in range(3):  # the same picture on three pages is one object in the file
        c.drawImage(str(tmp_path / "photo.jpg"), 50, 300, width=300, height=200)
        c.showPage()
    c.save()
    r = run(SKILL, TOOL, "compress", pdf, "-o", tmp_path / "high.pdf", "--jpeg-quality", "95").json()
    assert r["images_recompressed"] == 0 and r["images_left_alone"] == 1
    assert r["bytes_after"] <= r["bytes_before"]
    r = run(SKILL, TOOL, "compress", pdf, "-o", tmp_path / "low.pdf", "--jpeg-quality", "10").json()
    assert r["images_recompressed"] == 1 and r["bytes_after"] < r["bytes_before"]


def test_compress_keeps_the_content(run, report_pdf, tmp_path):
    out = tmp_path / "small.pdf"
    r = run(SKILL, TOOL, "compress", report_pdf, "-o", out, "--jpeg-quality", "60").json()
    # the report's picture is one flat colour, which the file already stores smaller than a JPEG would be
    assert r["bytes_after"] > 0 and r["images_left_alone"] == 1 and r["images_recompressed"] == 0
    assert "ALPHAMARK" in page_texts(out)[0]
