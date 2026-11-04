"""Real Word documents for the docx skill's tests, made with python-docx and, where python-docx can't write something
(tracked changes, content controls, mail-merge fields, comment threads), with the XML Word itself writes."""

from __future__ import annotations

import importlib
import sys
import zipfile
from pathlib import Path

import pytest

# This folder is named after the skill, docx, which is also the name python-docx imports as, and pytest has just
# registered the folder as a module of that name. Put the real package in its place so the tests can use it.
if not hasattr(sys.modules.get("docx"), "Document"):
    sys.modules.pop("docx", None)
    importlib.import_module("docx")

SKILL = "docx"
CYRILLIC = "Отчёт о продажах"  # not in Windows-1252, so printing it proves the scripts switch their output to UTF-8
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
W15 = "http://schemas.microsoft.com/office/word/2012/wordml"


def add_xml(doc, inner: str) -> None:
    """Append a paragraph (or table) written as Word's XML, before the body's section settings."""
    from docx.oxml import parse_xml

    el = parse_xml(f'<w:root xmlns:w="{W}" xmlns:w14="{W14}">{inner}</w:root>')
    body = doc.element.body
    for child in list(el):
        body.insert(len(body) - 1, child)


@pytest.fixture
def report_docx(tmp_path: Path) -> Path:
    """A heading, text split into runs as Word leaves it, a table, a header and a footer, and Cyrillic text."""
    import docx

    d = docx.Document()
    d.add_heading("Agreement", 1)
    p = d.add_paragraph()
    p.add_run("The buyer, ")
    a = p.add_run("Ac")
    a.bold = True
    b = p.add_run("me Ltd")
    b.bold = True
    p.add_run(", pays ")
    p.add_run("Acme ").italic = True
    p.add_run("Ltd later.")
    d.add_paragraph(CYRILLIC)
    d.add_paragraph("Signed in “quotes” here.")
    t = d.add_table(rows=2, cols=2)
    t.cell(0, 0).text, t.cell(0, 1).text = "Item", "Price"
    t.cell(1, 0).text, t.cell(1, 1).text = "Widget", "10"
    t.cell(1, 1).paragraphs[0].runs[0].bold = True
    d.add_paragraph("Closing words.")
    d.sections[0].header.paragraphs[0].text = "Header: Acme Ltd"
    d.sections[0].footer.paragraphs[0].text = "Footer text"
    path = tmp_path / "report.docx"
    d.save(path)
    return path


@pytest.fixture
def template_docx(tmp_path: Path) -> Path:
    """{{tokens}} split across runs, in the body, a table and the header; content controls; mail-merge fields."""
    import docx

    d = docx.Document()
    p = d.add_paragraph()
    p.add_run("Dear {{cli")
    p.add_run("ent}},").bold = True
    p.add_run(" your order {{ order_no }} ships to {{address}}.")
    t = d.add_table(rows=1, cols=2)
    t.cell(0, 0).text = "{{item}}"
    t.cell(0, 1).text = "{{price}}"
    d.sections[0].header.paragraphs[0].text = "For {{client}}"
    add_xml(d, (
        '<w:p><w:r><w:t xml:space="preserve">Name: </w:t></w:r><w:sdt><w:sdtPr><w:alias w:val="Client name"/>'
        '<w:tag w:val="client_name"/><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rStyle w:val="PlaceholderText"/>'
        '</w:rPr><w:t>Click here to enter text.</w:t></w:r></w:sdtContent></w:sdt></w:p>'
        '<w:p><w:sdt><w:sdtPr><w:tag w:val="agree"/><w14:checkbox><w14:checked w14:val="0"/>'
        '<w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/>'
        '</w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☐</w:t></w:r></w:sdtContent></w:sdt>'
        '<w:r><w:t xml:space="preserve"> I agree</w:t></w:r></w:p>'
        '<w:p><w:sdt><w:sdtPr><w:tag w:val="size"/><w:dropDownList><w:listItem w:displayText="Small" w:value="S"/>'
        '<w:listItem w:displayText="Large" w:value="L"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>Choose an item.</w:t>'
        '</w:r></w:sdtContent></w:sdt></w:p>'
        '<w:p><w:r><w:t xml:space="preserve">City: </w:t></w:r><w:fldSimple w:instr=" MERGEFIELD City \\* MERGEFORMAT ">'
        '<w:r><w:t>«City»</w:t></w:r></w:fldSimple></w:p>'
        '<w:p><w:r><w:t xml:space="preserve">Country: </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> MERGEFIELD "Country" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        '<w:r><w:rPr><w:i/></w:rPr><w:t>«Country»</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    ))
    path = tmp_path / "template.docx"
    d.save(path)
    return path


def rev(tag: str, i: int, author: str, inner: str) -> str:
    return f'<w:{tag} w:id="{i}" w:author="{author}" w:date="2026-01-02T03:04:05Z">{inner}</w:{tag}>'


@pytest.fixture
def tracked_docx(tmp_path: Path) -> Path:
    """Tracked changes by Ana and Ben: text inserted and deleted, a paragraph inserted and one deleted, a format
    change, a table row inserted, a cell edit, and a move."""
    import docx

    d = docx.Document()
    add_xml(d, (
        '<w:p><w:r><w:t xml:space="preserve">Base </w:t></w:r>'
        + rev("ins", 1, "Ana", '<w:r><w:t xml:space="preserve">added </w:t></w:r>')
        + rev("del", 2, "Ben", '<w:r><w:delText xml:space="preserve">removed </w:delText></w:r>')
        + '<w:r><w:t>end.</w:t></w:r></w:p>'
        + '<w:p><w:pPr><w:rPr>' + rev("ins", 3, "Ana", "") + '</w:rPr></w:pPr>'
        + rev("ins", 4, "Ana", '<w:r><w:t>New paragraph.</w:t></w:r>') + '</w:p>'
        + '<w:p><w:pPr><w:rPr>' + rev("del", 5, "Ben", "") + '</w:rPr></w:pPr>'
        + rev("del", 6, "Ben", '<w:r><w:delText>Old paragraph.</w:delText></w:r>') + '</w:p>'
        + '<w:p><w:r><w:t xml:space="preserve">Keep </w:t></w:r><w:r><w:rPr><w:b/>'
        + rev("rPrChange", 7, "Ana", "<w:rPr/>") + '</w:rPr><w:t>bold now</w:t></w:r></w:p>'
        + '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid>'
        + '<w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">Row one </w:t></w:r>'
        + rev("ins", 10, "Ana", '<w:r><w:t>cell add</w:t></w:r>') + '</w:p></w:tc></w:tr>'
        + '<w:tr><w:trPr>' + rev("ins", 9, "Ana", "") + '</w:trPr><w:tc><w:p>'
        + rev("ins", 8, "Ana", '<w:r><w:t>Inserted row</w:t></w:r>') + '</w:p></w:tc></w:tr></w:tbl>'
        + '<w:p><w:r><w:t xml:space="preserve">Alpha </w:t></w:r><w:moveFromRangeStart w:id="11" w:author="Ana" w:date="2026-01-02T03:04:05Z" w:name="move1"/>'
        + rev("moveFrom", 12, "Ana", '<w:r><w:t xml:space="preserve">Moved </w:t></w:r>')
        + '<w:moveFromRangeEnd w:id="11"/><w:r><w:t>omega.</w:t></w:r></w:p>'
        + '<w:p><w:r><w:t xml:space="preserve">Start </w:t></w:r><w:moveToRangeStart w:id="13" w:author="Ana" w:date="2026-01-02T03:04:05Z" w:name="move1"/>'
        + rev("moveTo", 14, "Ana", '<w:r><w:t xml:space="preserve">Moved </w:t></w:r>')
        + '<w:moveToRangeEnd w:id="13"/><w:r><w:t>finish.</w:t></w:r></w:p>'
    ))
    path = tmp_path / "tracked.docx"
    d.save(path)
    return path


@pytest.fixture
def joined_docx(tmp_path: Path) -> Path:
    """Two paragraphs that both keep text, joined by deleting the first one's mark: left for Word to decide."""
    import docx

    d = docx.Document()
    add_xml(d, '<w:p><w:pPr><w:rPr>' + rev("del", 1, "Ana", "") + '</w:rPr></w:pPr><w:r><w:t>First half</w:t></w:r></w:p>'
               '<w:p><w:r><w:t xml:space="preserve"> second half</w:t></w:r>' + rev("ins", 2, "Ana", '<w:r><w:t>!</w:t></w:r>') + '</w:p>')
    path = tmp_path / "joined.docx"
    d.save(path)
    return path


@pytest.fixture
def commented_docx(tmp_path: Path) -> Path:
    """Three comments as Word saves them: comment 0 resolved, comment 1 a reply to it, comment 2 on its own, with
    the threads in commentsExtended.xml."""
    import docx

    d = docx.Document()
    p1 = d.add_paragraph("The price is final.")
    p2 = d.add_paragraph("Delivery in May.")
    d.add_comment(p1.runs, text="Is it?", author="Ana", initials="A")
    d.add_comment(p1.runs, text="Yes, agreed.", author="Ben", initials="B")
    d.add_comment(p2.runs, text="Which year?", author="Ana", initials="A")
    plain = tmp_path / "plain.docx"
    d.save(plain)
    path = tmp_path / "commented.docx"
    para_ids = ["10000001", "10000002", "10000003"]
    with zipfile.ZipFile(plain) as zin, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "word/comments.xml":
                text = data.decode("utf-8")
                for pid in para_ids:
                    text = text.replace("<w:p>", f'<w:p xmlns:w14="{W14}" w14:paraId="{pid}">', 1)
                data = text.encode("utf-8")
            elif item.filename == "word/_rels/document.xml.rels":
                data = data.replace(b"</Relationships>", b'<Relationship Id="rIdX1" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/></Relationships>')
            elif item.filename == "[Content_Types].xml":
                data = data.replace(b"</Types>", b'<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/></Types>')
            zout.writestr(item, data)
        zout.writestr("word/commentsExtended.xml", (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="{W15}">'
            f'<w15:commentEx w15:paraId="10000001" w15:done="1"/>'
            f'<w15:commentEx w15:paraId="10000002" w15:paraIdParent="10000001" w15:done="0"/>'
            f'<w15:commentEx w15:paraId="10000003" w15:done="0"/></w15:commentsEx>'))
    return path


@pytest.fixture
def libreoffice(run, tmp_path: Path) -> str:
    """The real soffice, found the way the skill's soffice.py finds it; the test skips when there's none."""
    r = run(SKILL, "soffice.py", "find", ok=False)
    if r.code != 0:
        pytest.skip("LibreOffice isn't installed here (soffice.py find found none); set SOFFICE to run these tests")
    return r.json()["soffice"]
