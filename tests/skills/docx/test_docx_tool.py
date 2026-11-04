"""docx_tool.py: reading, editing across runs, filling templates, tracked changes, comments and the health check, on
real documents made in the tests. Every run goes through a cp1252 pipe, as on Windows."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

SKILL, TOOL = "docx", "docx_tool.py"
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CYRILLIC = "Отчёт о продажах"


def para_texts(path: Path) -> list[str]:
    """Body paragraph texts from the saved XML (w:t only, so deleted text is left out), read without the scripts."""
    from lxml import etree

    with zipfile.ZipFile(path) as z:
        root = etree.fromstring(z.read("word/document.xml"))
    return ["".join(t.text or "" for t in p.iter(f"{{{W}}}t")) for p in root.iter(f"{{{W}}}p")]


def part(path: Path, name: str) -> str:
    with zipfile.ZipFile(path) as z:
        return z.read(name).decode("utf-8")


def bold_of(path: Path, text: str) -> bool | None:
    import docx

    for p in docx.Document(path).paragraphs:
        for r in p.runs:
            if text in r.text:
                return r.bold
    return None


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


def write_json(path: Path, data, encoding: str = "utf-8") -> Path:
    path.write_bytes(json.dumps(data, ensure_ascii=False).encode(encoding))
    return path


# ---------------------------------------------------------------- reading


@pytest.mark.parametrize("args", [[], ["info"], ["text"], ["images"], ["check"], ["edit"], ["fill"], ["revisions"],
                                  ["revisions", "accept"], ["comments"], ["comments", "add"], ["comments", "delete"]])
def test_every_command_has_help(run, args):
    r = run(SKILL, TOOL, *args, "--help")
    assert r.out.startswith("usage:") and r.err == ""


def test_info(run, report_docx, tracked_docx, template_docx):
    info = run(SKILL, TOOL, "info", report_docx).json()
    assert info["paragraphs"] == 5 and info["tables"] == 1 and info["kind"] == ".docx"
    assert info["headings"] == [{"paragraph": 1, "style": "Heading 1", "text": "Agreement"}]
    assert info["tracked_changes"] == {} and info["comments"] == 0
    changes = run(SKILL, TOOL, "info", tracked_docx).json()["tracked_changes"]
    assert changes["insert"] >= 3 and changes["delete"] == 2 and changes["row_insert"] == 1 and changes["move_from"] == 1
    t = run(SKILL, TOOL, "info", template_docx).json()
    assert t["template_tokens"] == ["address", "client", "item", "order_no", "price"]
    assert {c["tag"] for c in t["content_controls"]} == {"client_name", "agree", "size"}
    assert t["fields"] == {"MERGEFIELD": 2}


def test_text_reads_runs_tables_headers_and_non_latin_text_through_a_cp1252_pipe(run, report_docx):
    r = run(SKILL, TOOL, "text", report_docx)
    data = r.json()
    texts = [b.get("text") for b in data["blocks"] if "paragraph" in b]
    assert texts[1] == "The buyer, Acme Ltd, pays Acme Ltd later." and texts[2] == CYRILLIC
    assert data["blocks"][4] == {"table": 1, "rows": [["Item", "Price"], ["Widget", "10"]]}
    assert data["headers"] == [{"part": "header1", "text": "Header: Acme Ltd"}]
    assert data["footers"][0]["text"] == "Footer text"


def test_text_shows_tracked_changes_accepted_and_says_so(run, tracked_docx):
    data = run(SKILL, TOOL, "text", tracked_docx).json()
    texts = [b["text"] for b in data["blocks"] if "paragraph" in b]
    assert texts[0] == "Base added end." and "Old paragraph." not in texts[2]
    assert "Alpha omega." in texts and "Start Moved finish." in texts
    assert "accepted" in data["view"]


def test_text_into_a_file(run, report_docx, tmp_path):
    r = run(SKILL, TOOL, "text", report_docx, "--out", tmp_path / "work" / "report.txt")
    text = (tmp_path / "work" / "report.txt").read_text(encoding="utf-8")
    assert CYRILLIC in text and "[table 1]" in text and "Widget\t10" in text and "[header header1]" in text
    assert r.json()["paragraphs"] == 5
    again = run(SKILL, TOOL, "text", report_docx, "--out", report_docx, ok=False)
    assert again.code == 2 and "won't write over" in again.err


def test_images_get_safe_unique_names(run, tmp_path):
    import docx
    from PIL import Image

    Image.new("RGB", (40, 30), (200, 30, 30)).save(tmp_path / "pic.png")
    d = docx.Document()
    d.add_picture(str(tmp_path / "pic.png"))
    d.save(tmp_path / "pics.docx")
    out = tmp_path / "pictures"
    out.mkdir()
    (out / "image1.png").write_bytes(b"already here")
    data = run(SKILL, TOOL, "images", tmp_path / "pics.docx", "--out-dir", out).json()
    assert data["count"] == 1
    saved = Path(data["images"][0]["saved_as"])
    assert saved.name == "image1-2.png" and saved.read_bytes()[:4] == b"\x89PNG"
    assert (out / "image1.png").read_bytes() == b"already here"


# ---------------------------------------------------------------- edit


def test_replace_across_runs_keeps_the_first_runs_formatting(run, report_docx, tmp_path):
    ops = write_json(tmp_path / "ops.json", [{"op": "replace", "find": "Acme Ltd", "replace": "Beta GmbH", "expect": 3}])
    out = tmp_path / "out.docx"
    r = run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", out).json()
    assert r["done"][0]["matches"] == 3 and r["runs_joined"] >= 1
    texts = para_texts(out)
    assert texts[1] == "The buyer, Beta GmbH, pays Beta GmbH later."
    import docx

    runs = [(r.text, r.bold, r.italic) for r in docx.Document(out).paragraphs[1].runs]
    # the two bold runs Word split were joined, and each replacement took the look of the run its match began in
    assert runs == [("The buyer, ", None, None), ("Beta GmbH", True, None), (", pays ", None, None),
                    ("Beta GmbH", None, True), (" later.", None, None)]
    assert "Header: Beta GmbH" in part(out, "word/header1.xml")
    assert para_texts(report_docx)[1] == "The buyer, Acme Ltd, pays Acme Ltd later."  # the input is unchanged


def test_paragraph_and_cell_operations(run, report_docx, tmp_path):
    ops = write_json(tmp_path / "ops.json", [
        {"op": "insert", "after": 1, "text": "Inserted first", "style": "Normal"},
        {"op": "insert", "after": 1, "text": "Inserted second\twith a tab"},
        {"op": "insert", "before": 5, "text": "Before closing"},
        {"op": "delete", "paragraph": 4},
        {"op": "style", "paragraph": 3, "style": "Heading 2"},
        {"op": "cell", "table": 1, "row": 2, "col": 2, "text": "12.50"},
    ])
    out = tmp_path / "out.docx"
    run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", out)
    data = run(SKILL, TOOL, "text", out).json()
    paras = [(b["style"], b["text"]) for b in data["blocks"] if "paragraph" in b]
    assert [t for _, t in paras] == ["Agreement", "Inserted first", "Inserted second\twith a tab",
                                     "The buyer, Acme Ltd, pays Acme Ltd later.", CYRILLIC, "Before closing", "Closing words."]
    assert paras[4] == ("Heading 2", CYRILLIC)
    assert paras[2][0] == "Heading 1"  # no style given: it takes the look of the paragraph it follows
    table = next(b for b in data["blocks"] if "table" in b)
    assert table["rows"][1] == ["Widget", "12.50"]
    assert bold_of(out, "Inserted first") is None
    import docx

    cell = docx.Document(out).tables[0].cell(1, 1)
    assert cell.paragraphs[0].runs[0].bold is True  # the cell kept the look of its old text


def test_problems_write_nothing_and_say_what_fits(run, report_docx, tmp_path):
    ops = write_json(tmp_path / "ops.json", [
        {"op": "replace", "find": 'Signed in "quotes"', "replace": "x"},
        {"op": "replace", "find": "Acme Ltd", "replace": "B", "expect": 2},
        {"op": "style", "paragraph": 1, "style": "No Such Style"},
        {"op": "delete", "paragraph": 99},
        {"op": "cell", "table": 1, "row": 3, "col": 1, "text": "x"},
        {"op": "move"},
    ])
    out = tmp_path / "out.docx"
    r = run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", out, ok=False)
    assert r.code == 1 and not out.exists()
    problems = {p["op"]: p for p in r.json()["problems"]}
    assert problems[1]["did_you_mean"].startswith("Signed in “quotes”")
    assert "expected 2" in problems[2]["problem"]
    assert "Heading 1" in problems[3]["problem"] and "no style" in problems[3]["problem"]
    assert "1 to 5" in problems[4]["problem"] and "1 to 2" in problems[5]["problem"]
    assert "replace, insert" in problems[6]["problem"]


def test_never_over_the_input_unless_asked(run, report_docx, tmp_path):
    ops = write_json(tmp_path / "ops.json", [{"op": "replace", "find": "Closing", "replace": "Final"}])
    before = report_docx.read_bytes()
    r = run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", report_docx, ok=False)
    assert r.code == 2 and one_line(r.err) and "--overwrite" in r.err
    assert report_docx.read_bytes() == before
    run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", report_docx, "--overwrite")
    assert "Final words." in para_texts(report_docx)


def test_tracked_edits_accept_to_the_edit_and_reject_to_the_original(run, report_docx, tmp_path):
    ops = write_json(tmp_path / "ops.json", [
        {"op": "replace", "find": "Acme Ltd", "replace": "Beta GmbH"},
        {"op": "insert", "after": 3, "text": "A new clause."},
        {"op": "delete", "paragraph": 5},
        {"op": "style", "paragraph": 1, "style": "Title"},
        {"op": "cell", "table": 1, "row": 2, "col": 2, "text": "12"},
    ])
    plain, tracked = tmp_path / "plain.docx", tmp_path / "tracked.docx"
    run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", plain)
    r = run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", tracked, "--track", "--author", "Sam Lee").json()
    assert r["tracked_as"] == "Sam Lee"
    listed = run(SKILL, TOOL, "revisions", "list", tracked).json()
    assert listed["authors"] == ["Sam Lee"] and listed["by_kind"]["delete"] >= 3 and listed["by_kind"]["paragraph_format"] == 1
    accepted, rejected = tmp_path / "accepted.docx", tmp_path / "rejected.docx"
    run(SKILL, TOOL, "revisions", "accept", tracked, "-o", accepted)
    run(SKILL, TOOL, "revisions", "reject", tracked, "-o", rejected)

    def view(path):
        data = run(SKILL, TOOL, "text", path).json()
        return [(b.get("style"), b.get("text") or b.get("rows")) for b in data["blocks"]]

    assert view(accepted) == view(plain)
    assert view(rejected) == view(report_docx)
    assert run(SKILL, TOOL, "revisions", "list", accepted).json()["count"] == 0


# ---------------------------------------------------------------- fill


def test_fill_tokens_controls_and_merge_fields(run, template_docx, tmp_path):
    values = write_json(tmp_path / "values.json", {
        "client": "Zoë & Co", "order_no": 1042, "address": "1 High St\nLeeds", "item": "Widget", "price": "£10",
        "client_name": "Анна Петрова", "agree": True, "size": "L", "City": "Leeds", "Country": "UK", "extra": "unused"})
    out = tmp_path / "filled.docx"
    r = run(SKILL, TOOL, "fill", template_docx, values, "-o", out).json()
    assert r["filled"]["client"] == 2 and r["missing"] == [] and r["unused"] == ["extra"] and r["tokens_left"] == {}
    data = run(SKILL, TOOL, "text", out).json()
    texts = [b["text"] for b in data["blocks"] if "paragraph" in b]
    assert texts[0] == "Dear Zoë & Co, your order 1042 ships to 1 High St\nLeeds."
    assert texts[1:] == ["Name: Анна Петрова", "☒ I agree", "Large", "City: Leeds", "Country: UK"]
    assert data["blocks"][1]["rows"] == [["Widget", "£10"]]
    assert data["headers"][0]["text"] == "For Zoë & Co"
    doc_xml = part(out, "word/document.xml")
    assert "MERGEFIELD" not in doc_xml and "showingPlcHdr" not in doc_xml and "PlaceholderText" not in doc_xml
    assert 'w14:checked w14:val="1"' in doc_xml and "<w:br/>" in doc_xml


def test_fill_stops_on_tokens_without_values_unless_partial(run, template_docx, tmp_path):
    values = write_json(tmp_path / "values.json", {"client": "Acme"})
    out = tmp_path / "filled.docx"
    r = run(SKILL, TOOL, "fill", template_docx, values, "-o", out, ok=False)
    assert r.code == 1 and not out.exists()
    assert r.json()["missing"] == ["City", "Country", "address", "agree", "client_name", "item", "order_no", "price", "size"]
    r = run(SKILL, TOOL, "fill", template_docx, values, "-o", out, "--partial").json()
    assert r["written"] and r["tokens_left"] == {"order_no": 1, "address": 1, "item": 1, "price": 1}
    assert "Dear Acme," in para_texts(out)[0]


def test_fill_refuses_a_value_a_dropdown_doesnt_have(run, template_docx, tmp_path):
    values = write_json(tmp_path / "values.json", {"size": "Huge", "agree": "maybe"})
    r = run(SKILL, TOOL, "fill", template_docx, values, "-o", tmp_path / "f.docx", "--partial", ok=False)
    assert r.code == 1
    problems = {p.get("control"): p["problem"] for p in r.json()["problems"]}
    assert "Large" in problems["size"] and "true or false" in problems["agree"]


def test_values_saved_by_windows_powershell(run, template_docx, tmp_path):
    """Windows PowerShell 5.1's > writes UTF-16 with a byte-order mark; Set-Content writes the ANSI code page."""
    utf16 = write_json(tmp_path / "v16.json", {"client": "Zoë Ł", "order_no": 1, "address": "a", "item": "i", "price": "p"}, "utf-16")
    r = run(SKILL, TOOL, "fill", template_docx, utf16, "-o", tmp_path / "a.docx", "--partial").json()
    assert "Dear Zoë Ł," in para_texts(tmp_path / "a.docx")[0] and "encoding_notes" not in r
    ansi = write_json(tmp_path / "v1252.json", {"client": "Zoë", "order_no": 1, "address": "a", "item": "i", "price": "p"}, "cp1252")
    r = run(SKILL, TOOL, "fill", template_docx, ansi, "-o", tmp_path / "b.docx", "--partial").json()
    assert "Dear Zoë," in para_texts(tmp_path / "b.docx")[0] and "isn't UTF-8" in r["encoding_notes"][0]


# ---------------------------------------------------------------- tracked changes


def test_revisions_list(run, tracked_docx):
    data = run(SKILL, TOOL, "revisions", "list", tracked_docx).json()
    assert data["authors"] == ["Ana", "Ben"]
    kinds = {c["id"]: c["kind"] for c in data["changes"]}
    assert kinds["1"] == "insert" and kinds["2"] == "delete" and kinds["3"] == "paragraph_insert"
    assert kinds["5"] == "paragraph_delete" and kinds["7"] == "format" and kinds["9"] == "row_insert"
    assert kinds["12"] == "move_from" and kinds["14"] == "move_to"
    deleted = next(c for c in data["changes"] if c["id"] == "2")
    assert deleted["text"] == "removed " and deleted["author"] == "Ben" and deleted["where"] == "paragraph 1"
    assert next(c for c in data["changes"] if c["id"] == "10")["where"] == "table 1"


def test_accept_all(run, tracked_docx, tmp_path):
    out = tmp_path / "accepted.docx"
    r = run(SKILL, TOOL, "revisions", "accept", tracked_docx, "-o", out).json()
    assert r["left"] == [] and r["changes_left_in_file"] == 0
    assert para_texts(out) == ["Base added end.", "New paragraph.", "Keep bold now", "Row one cell add", "Inserted row",
                               "Alpha omega.", "Start Moved finish."]
    assert bold_of(out, "bold now") is True
    xml = part(out, "word/document.xml")
    assert "w:ins " not in xml and "w:del " not in xml and "rPrChange" not in xml and "moveFromRange" not in xml


def test_reject_all(run, tracked_docx, tmp_path):
    out = tmp_path / "rejected.docx"
    run(SKILL, TOOL, "revisions", "reject", tracked_docx, "-o", out)
    assert para_texts(out) == ["Base removed end.", "Old paragraph.", "Keep bold now", "Row one ", "Alpha Moved omega.",
                               "Start finish."]
    assert bold_of(out, "bold now") is None


def test_accept_or_reject_some(run, tracked_docx, tmp_path):
    out = tmp_path / "some.docx"
    run(SKILL, TOOL, "revisions", "reject", tracked_docx, "-o", out, "--author", "Ben")
    left = run(SKILL, TOOL, "revisions", "list", out).json()
    assert left["authors"] == ["Ana"]
    assert para_texts(out)[:3] == ["Base added removed end.", "New paragraph.", "Old paragraph."]
    run(SKILL, TOOL, "revisions", "accept", tracked_docx, "-o", out, "--ids", "1,2", "--overwrite")
    assert {c["id"] for c in run(SKILL, TOOL, "revisions", "list", out).json()["changes"]} >= {"3", "5"}
    assert para_texts(out)[0] == "Base added end."
    r = run(SKILL, TOOL, "revisions", "accept", tracked_docx, "-o", out, "--ids", "77", "--overwrite", ok=False)
    assert r.code == 2 and one_line(r.err) and "77" in r.err
    r = run(SKILL, TOOL, "revisions", "accept", tracked_docx, "-o", out, "--author", "Nobody", "--overwrite", ok=False)
    assert r.code == 2 and "Ana, Ben" in r.err


def test_a_move_on_its_own_and_a_join_are_left_for_word(run, tracked_docx, joined_docx, tmp_path):
    out = tmp_path / "out.docx"
    r = run(SKILL, TOOL, "revisions", "accept", tracked_docx, "-o", out, "--ids", "12", ok=False)
    assert r.code == 1 and not out.exists() and "two halves" in r.json()["left"][0]["why"]
    r = run(SKILL, TOOL, "revisions", "accept", joined_docx, "-o", out, ok=False)
    assert r.code == 1 and not out.exists()
    assert r.json()["left"][0]["kind"] == "paragraph_delete" and r.json()["done"] == {"insert": 1}
    r = run(SKILL, TOOL, "revisions", "accept", joined_docx, "-o", out, "--partial", ok=False)
    assert r.code == 1 and r.json()["written"] and r.json()["changes_left_in_file"] == 1
    assert para_texts(out) == ["First half", " second half!"]


# ---------------------------------------------------------------- comments


def test_comments_list_reads_threads_and_resolved(run, commented_docx):
    data = run(SKILL, TOOL, "comments", "list", commented_docx).json()
    assert data["count"] == 3
    c0, c1, c2 = data["comments"]
    assert c0["resolved"] is True and c0["anchored_to"] == "The price is final." and c0["where"] == "paragraph 1"
    assert c1["reply_to"] == 0 and c1["author"] == "Ben" and "resolved" not in c1
    assert c2["text"] == "Which year?" and c2["anchored_to"] == "Delivery in May."


def test_add_comments_anchored_inside_runs(run, report_docx, tmp_path):
    out = tmp_path / "commented.docx"
    r = run(SKILL, TOOL, "comments", "add", report_docx, "--at", "pays Acme", "--text", "Check the payer.", "-o", out).json()
    assert r["added"][0]["author"] == "Reviewer" and r["added"][0]["matches"] == 1
    listed = run(SKILL, TOOL, "comments", "list", out).json()["comments"]
    assert listed[0]["anchored_to"] == "pays Acme" and listed[0]["initials"] == "R"
    assert para_texts(out)[1] == para_texts(report_docx)[1]  # the text is the same, only split around the comment
    import docx

    runs = [(r.text, r.italic) for r in docx.Document(out).paragraphs[1].runs if r.text]
    assert ("Acme", True) in runs and (" ", True) in runs  # the italic run kept its look when the anchor split it


def test_add_many_comments_from_a_utf16_file(run, report_docx, tmp_path):
    wanted = write_json(tmp_path / "comments.json", [
        {"at": "Acme Ltd", "occurrence": 2, "text": "Second mention."},
        {"at": "продажах", "text": "Какой период?", "author": "Анна"},
    ], "utf-16")
    out = tmp_path / "c.docx"
    r = run(SKILL, TOOL, "comments", "add", report_docx, "--from", wanted, "-o", out, "--author", "Sam Lee").json()
    assert [a["author"] for a in r["added"]] == ["Sam Lee", "Анна"] and r["added"][0]["matches"] == 2  # the body only
    listed = run(SKILL, TOOL, "comments", "list", out).json()["comments"]
    assert [c["anchored_to"] for c in listed] == ["Acme Ltd", "продажах"] and listed[1]["text"] == "Какой период?"
    assert listed[0]["where"] == "paragraph 2"


def test_a_phrase_not_found_writes_nothing(run, report_docx, tmp_path):
    wanted = write_json(tmp_path / "comments.json", [{"at": "Closing", "text": "ok"}, {"at": "nowhere at all", "text": "x"},
                                                     {"at": "Acme Ltd", "occurrence": 9, "text": "y"}])
    out = tmp_path / "c.docx"
    r = run(SKILL, TOOL, "comments", "add", report_docx, "--from", wanted, "-o", out, ok=False)
    assert r.code == 1 and not out.exists()
    assert [p["comment"] for p in r.json()["problems"]] == [2, 3]


def test_delete_a_comment_takes_its_replies_and_thread_entries(run, commented_docx, tmp_path):
    out = tmp_path / "out.docx"
    r = run(SKILL, TOOL, "comments", "delete", commented_docx, "--ids", "0", "-o", out).json()
    assert r["deleted"] == [0, 1] and r["comments_left"] == 1
    xml, ext = part(out, "word/document.xml"), part(out, "word/commentsExtended.xml")
    assert 'w:id="0"' not in xml and 'w:id="1"' not in xml and 'commentRangeStart w:id="2"' in xml
    assert "10000001" not in ext and "10000002" not in ext and "10000003" in ext
    assert para_texts(out) == para_texts(commented_docx)
    run(SKILL, TOOL, "comments", "delete", commented_docx, "--all", "-o", out, "--overwrite")
    assert run(SKILL, TOOL, "comments", "list", out).json()["count"] == 0
    assert "commentReference" not in part(out, "word/document.xml")
    assert run(SKILL, TOOL, "check", out).json()["errors"] == 0


# ---------------------------------------------------------------- check and failures


def test_check_passes_healthy_files(run, report_docx, tracked_docx, commented_docx):
    for path in (report_docx, tracked_docx, commented_docx):
        data = run(SKILL, TOOL, "check", path).json()
        assert data["ok"] and data["errors"] == 0, data["problems"]


def test_check_finds_broken_links_parts_styles_and_comments(run, report_docx, commented_docx, tmp_path):
    bad = tmp_path / "bad.docx"
    with zipfile.ZipFile(report_docx) as zin, zipfile.ZipFile(bad, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/_rels/document.xml.rels":
                data = data.replace(b"</Relationships>", b'<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/gone.png"/></Relationships>')
            if item.filename == "word/document.xml":
                data = data.replace(b"<w:body>", b'<w:body><w:p><w:pPr><w:pStyle w:val="Fancy"/></w:pPr><w:r><w:commentReference w:id="5"/></w:r></w:p>', 1)
            zout.writestr(item, data)
        zout.writestr("word/stray.bin", b"x")
    r = run(SKILL, TOOL, "check", bad, ok=False)
    assert r.code == 1
    found = " | ".join(p["problem"] for p in r.json()["problems"])
    assert "media/gone.png" in found and "no content type" in found and "comment 5" in found and "style Fancy" in found


def test_check_on_a_file_that_isnt_a_zip(run, tmp_path):
    cut = tmp_path / "cut.docx"
    cut.write_bytes(b"PK\x03\x04 not really a zip")
    r = run(SKILL, TOOL, "check", cut, ok=False)
    assert r.code == 1 and "zip" in r.json()["problems"][0]["problem"]


@pytest.mark.parametrize("command", [["info"], ["text"], ["revisions", "list"], ["comments", "list"]])
def test_files_that_arent_docx_are_one_line(run, tmp_path, report_docx, command):
    old = tmp_path / "old.doc"
    old.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\0" * 100)
    cut = tmp_path / "cut.docx"
    cut.write_bytes(report_docx.read_bytes()[:400])
    from openpyxl import Workbook

    Workbook().save(tmp_path / "book.xlsx")
    for path, says in ((old, "old-style .doc"), (cut, "damaged"), (tmp_path / "book.xlsx", "isn't a Word document"),
                       (tmp_path / "missing.docx", "no such file")):
        r = run(SKILL, TOOL, *command, path, ok=False)
        assert r.code == 2 and one_line(r.err) and says in r.err and r.out == "", (path, r.err)


def test_mistakes_are_one_line(run, report_docx, tmp_path):
    folder = tmp_path / "a-folder.docx"
    folder.mkdir()
    ops = tmp_path / "ops.json"
    ops.write_text("[{not json", encoding="utf-8")
    good = write_json(tmp_path / "good.json", [{"op": "replace", "find": "Closing", "replace": "End"}])
    for args, says in (
        ([], "needs a command"),
        (["revisions", report_docx], "invalid choice"),
        (["edit", report_docx, "--ops", ops, "-o", tmp_path / "o.docx"], "isn't valid JSON"),
        (["edit", report_docx, "--ops", good, "-o", folder], "is a folder"),
        (["edit", report_docx, "--ops", good, "-o", tmp_path / "o.pdf"], "must end in .docx"),
        (["comments", "add", report_docx, "--at", "x", "--text", "y", "-o", tmp_path / "o.docx", "--occurrence", "0"], "1 or more"),
        (["comments", "delete", report_docx, "--ids", "1", "-o", tmp_path / "o.docx"], "no comment with id 1"),
        (["fill", report_docx, good, "-o", tmp_path / "o.docx"], "JSON object"),
    ):
        r = run(SKILL, TOOL, *args, ok=False)
        assert r.code == 2 and one_line(r.err) and says in r.err and r.out == "", (args, r.err)


def test_templates_and_macro_files_keep_the_right_type(run, report_docx, tmp_path):
    import docx

    tpl = tmp_path / "letter.dotx"
    with zipfile.ZipFile(report_docx) as zin, zipfile.ZipFile(tpl, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(b"document.main+xml", b"template.main+xml")
            zout.writestr(item, data)
    with pytest.raises(ValueError):
        docx.Document(tpl)  # python-docx alone refuses a template
    ops = write_json(tmp_path / "ops.json", [{"op": "replace", "find": "Closing", "replace": "Final"}])
    run(SKILL, TOOL, "edit", tpl, "--ops", ops, "-o", tmp_path / "letter.docx")
    assert "document.main+xml" in part(tmp_path / "letter.docx", "[Content_Types].xml")
    assert docx.Document(tmp_path / "letter.docx").paragraphs[-1].text == "Final words."
    macro = tmp_path / "macro.docm"
    with zipfile.ZipFile(report_docx) as zin, zipfile.ZipFile(macro, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(b"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                                    b"application/vnd.ms-word.document.macroEnabled.main+xml")
            zout.writestr(item, data)
    r = run(SKILL, TOOL, "edit", macro, "--ops", ops, "-o", tmp_path / "macro.docx", ok=False)
    assert r.code == 2 and ".docm" in r.err
    run(SKILL, TOOL, "edit", macro, "--ops", ops, "-o", tmp_path / "macro2.docm")


def test_without_python_docx_it_says_how_to_install(run, report_docx, tmp_path):
    stub = tmp_path / "hidden" / "docx"
    stub.mkdir(parents=True)
    (stub / "__init__.py").write_text("raise ImportError('hidden')\n", encoding="utf-8")
    r = run(SKILL, TOOL, "info", report_docx, ok=False, env={"PYTHONPATH": str(stub.parent)})
    assert r.code == 2 and one_line(r.err) and "pip install python-docx" in r.err


def test_a_tracked_copy_renders_in_libreoffice(run, report_docx, tmp_path, libreoffice):
    ops = write_json(tmp_path / "ops.json", [{"op": "replace", "find": "Closing", "replace": "Final"}])
    tracked = tmp_path / "tracked.docx"
    run(SKILL, TOOL, "edit", report_docx, "--ops", ops, "-o", tracked, "--track")
    roundtrip = tmp_path / "work" / "roundtrip.docx"
    run(SKILL, "soffice.py", "convert", tracked, "--to", "docx", "-o", roundtrip)
    kinds = run(SKILL, TOOL, "revisions", "list", roundtrip).json()["by_kind"]
    assert kinds.get("delete") == 1 and kinds.get("insert") == 1  # LibreOffice read them as tracked changes


def test_text_sees_what_python_docx_paragraphs_miss(run, tmp_path):
    """python-docx's Document.paragraphs skips paragraphs inside a content control, and Paragraph.text skips tracked
    insertions; the skill's reference says so, and `text` reads both."""
    import docx

    d = docx.Document()
    d.add_paragraph("Before")
    body = d.element.body
    from docx.oxml import parse_xml

    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body.insert(len(body) - 1, parse_xml(
        f'<w:sdt xmlns:w="{w}"><w:sdtPr><w:tag w:val="block"/></w:sdtPr><w:sdtContent>'
        f'<w:p><w:r><w:t>Inside a control</w:t></w:r></w:p></w:sdtContent></w:sdt>'))
    body.insert(len(body) - 1, parse_xml(
        f'<w:p xmlns:w="{w}"><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" w:author="A" '
        f'w:date="2026-01-01T00:00:00Z"><w:r><w:t>inserted</w:t></w:r></w:ins></w:p>'))
    path = tmp_path / "hidden.docx"
    d.save(path)
    assert [p.text for p in docx.Document(path).paragraphs] == ["Before", "Kept "]
    texts = [b["text"] for b in run(SKILL, TOOL, "text", path).json()["blocks"]]
    assert texts == ["Before", "Inside a control", "Kept inserted"]


def test_track_refuses_a_match_running_into_a_link(run, tmp_path):
    import docx

    d = docx.Document()
    p = d.add_paragraph("Visit ")
    from docx.oxml import parse_xml

    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    p._p.append(parse_xml(f'<w:hyperlink xmlns:w="{w}" w:anchor="top"><w:r><w:t>our site</w:t></w:r></w:hyperlink>'))
    path = tmp_path / "link.docx"
    d.save(path)
    ops = write_json(tmp_path / "ops.json", [{"op": "replace", "find": "Visit our", "replace": "See our"}])
    r = run(SKILL, TOOL, "edit", path, "--ops", ops, "-o", tmp_path / "out.docx", "--track", ok=False)
    assert r.code == 1 and not (tmp_path / "out.docx").exists() and "across a link" in r.json()["problems"][0]["problem"]
    run(SKILL, TOOL, "edit", path, "--ops", ops, "-o", tmp_path / "out.docx")
    assert para_texts(tmp_path / "out.docx") == ["See our site"]


def test_odd_braces_are_a_warning(run, tmp_path):
    import docx

    d = docx.Document()
    d.add_paragraph("Hello {{name}}.")
    p = d.add_paragraph("Code: {{")
    p.add_run().add_tab()
    p.add_run("x}}")
    d.save(tmp_path / "t.docx")
    values = write_json(tmp_path / "v.json", {"name": "Ada"})
    r = run(SKILL, TOOL, "fill", tmp_path / "t.docx", values, "-o", tmp_path / "out.docx").json()
    assert r["written"] and r["odd_braces"]["paragraphs"] == ["Code: {{\tx}}"]
    assert para_texts(tmp_path / "out.docx")[0] == "Hello Ada."


def test_check_needs_only_lxml(run, report_docx, tmp_path):
    stub = tmp_path / "hidden" / "docx"
    stub.mkdir(parents=True)
    (stub / "__init__.py").write_text("raise ImportError('hidden')\n", encoding="utf-8")
    r = run(SKILL, TOOL, "check", report_docx, env={"PYTHONPATH": str(stub.parent)}).json()
    assert r["ok"] and "python-docx isn't installed" in r["not_checked"]


def test_replace_runs_across_the_end_of_a_comment(run, report_docx, tmp_path):
    """A comment that ends inside the words leaves its mark between them; Word finds the words anyway, and so must
    replace, tracked or not, with the comment still in place afterwards."""
    commented = tmp_path / "commented.docx"
    run(SKILL, TOOL, "comments", "add", report_docx, "--at", "pays Acme", "--text", "Who pays?", "-o", commented)
    ops = write_json(tmp_path / "ops.json", [{"op": "replace", "find": "Acme Ltd", "replace": "Beta GmbH", "expect": 3}])
    for extra in ([], ["--track"]):
        out = tmp_path / f"out{len(extra)}.docx"
        run(SKILL, TOOL, "edit", commented, "--ops", ops, "-o", out, *extra)
        accepted = tmp_path / f"accepted{len(extra)}.docx"
        run(SKILL, TOOL, "revisions", "accept", out, "-o", accepted)
        texts = [b["text"] for b in run(SKILL, TOOL, "text", accepted).json()["blocks"] if "paragraph" in b]
        assert texts[1] == "The buyer, Beta GmbH, pays Beta GmbH later."
        listed = run(SKILL, TOOL, "comments", "list", accepted).json()["comments"]
        assert len(listed) == 1 and listed[0]["anchored_to"].startswith("pays ")
        assert run(SKILL, TOOL, "check", accepted).json()["errors"] == 0
