"""Real decks for the powerpoint skill's tests, built with python-pptx and a little XML (not with the scripts under
test)."""

from __future__ import annotations

import json
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "skills" / "athena" / "powerpoint" / "scripts"
TITLE = "Отчёт 2026 — 销售"  # Cyrillic and Chinese: not in Windows-1252, so printing it proves the output is UTF-8
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"


def png(path: Path, colour=(30, 120, 200), size=(160, 90)) -> Path:
    from PIL import Image

    Image.new("RGB", size, colour).save(path)
    return path


def split_runs(paragraph, pieces) -> None:
    """Write a paragraph as several runs, the way PowerPoint splits text at spell-check and edit points. Each piece
    is (text, bold, extra rPr attributes)."""
    for r in list(paragraph.runs):
        r._r.getparent().remove(r._r)
    for text, bold, attrs in pieces:
        run = paragraph.add_run()
        run.text = text
        if bold is not None:
            run.font.bold = bold
        rpr = run._r.get_or_add_rPr()
        for k, v in attrs.items():
            rpr.set(k, v)


def add_sections(prs, groups) -> None:
    """A section list in presentation.xml, as PowerPoint writes it: groups are (name, [slide numbers])."""
    from lxml import etree

    ids = [s.get("id") for s in prs.slides._sldIdLst]
    root = prs.part._element
    ext_lst = root.find(f"{{{root.nsmap['p']}}}extLst")
    if ext_lst is None:
        ext_lst = etree.SubElement(root, f"{{{root.nsmap['p']}}}extLst")
    ext = etree.SubElement(ext_lst, f"{{{root.nsmap['p']}}}ext", uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}")
    lst = etree.SubElement(ext, f"{{{P14}}}sectionLst", nsmap={"p14": P14})
    for k, (name, numbers) in enumerate(groups):
        section = etree.SubElement(lst, f"{{{P14}}}section", name=name, id="{%08d-0000-0000-0000-000000000000}" % k)
        ids_el = etree.SubElement(section, f"{{{P14}}}sldIdLst")
        for n in numbers:
            etree.SubElement(ids_el, f"{{{P14}}}sldId", id=ids[n - 1])


def build_sample(path: Path, tmp: Path) -> Path:
    """Six 16:9 slides:
    1 title slide: TITLE / "Acme Ltd"
    2 bullets: "Revenue at Acme grew" split over three runs that look alike (bold, spell-check marks differ), a
      paragraph "Acme" + "Corp" in two runs that look different (bold, plain), and a level-1 bullet; notes "Ask Acme"
    3 a group holding a text box "Acme in a group" and a nested group holding "Deep Acme"
    4 a column chart, two series in "0%", titled "Acme share"
    5 a table with {{client}} split over runs, and a picture with alt text
    6 a blank slide, hidden
    Sections: "Intro" (1-2) and "Detail" (3-6). The master has a text box "Acme Ltd footer line"."""
    from pptx import Presentation
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from pptx.enum.shapes import MSO_SHAPE
    from pptx.util import Inches, Pt

    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    layouts = prs.slide_layouts

    s1 = prs.slides.add_slide(layouts[0])
    s1.shapes.title.text = TITLE
    s1.placeholders[1].text = "Acme Ltd"

    s2 = prs.slides.add_slide(layouts[1])
    s2.shapes.title.text = "Growth"
    body = s2.placeholders[1].text_frame
    split_runs(body.paragraphs[0], [("Revenue at Ac", True, {"lang": "en-US"}), ("m", True, {"lang": "en-US", "err": "1"}), ("e grew", True, {"lang": "en-GB", "dirty": "0"})])
    p2 = body.add_paragraph()
    split_runs(p2, [("Ac", True, {}), ("me Corp", False, {})])
    p3 = body.add_paragraph()
    p3.level = 1
    p3.text = "Second level"
    s2.notes_slide.notes_text_frame.text = "Ask Acme about the numbers"

    s3 = prs.slides.add_slide(layouts[5])
    s3.shapes.title.text = "Grouped"
    outer = s3.shapes.add_group_shape()
    box = outer.shapes.add_textbox(Inches(1), Inches(2), Inches(4), Inches(1))
    box.text_frame.text = "Acme in a group"
    inner = outer.shapes.add_group_shape()
    deep = inner.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(6), Inches(2), Inches(4), Inches(1))
    deep.text_frame.text = "Deep Acme"

    s4 = prs.slides.add_slide(layouts[5])
    s4.shapes.title.text = "Share"
    data = CategoryChartData(number_format="0%")
    data.categories = ["Q1", "Q2", "Q3"]
    data.add_series("North", (0.1, 0.2, 0.3))
    data.add_series("South", (0.4, 0.5, 0.6))
    data.add_series("West", (0.2, 0.2, 0.2))
    frame = s4.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(1.5), Inches(8), Inches(5), data)
    frame.name = "Share chart"
    chart = frame.chart
    chart.has_title = True
    chart.chart_title.text_frame.text = "Acme share"
    from pptx.dml.color import RGBColor

    for s, rgb in zip(chart.plots[0].series, ("1F4E79", "C55A11", "548235")):
        s.format.fill.solid()
        s.format.fill.fore_color.rgb = RGBColor.from_string(rgb)

    s5 = prs.slides.add_slide(layouts[5])
    s5.shapes.title.text = "Table"
    table = s5.shapes.add_table(3, 2, Inches(1), Inches(1.5), Inches(6), Inches(1.5)).table
    for r, row in enumerate([["Client", "Units"], ["x", "1,250"], ["Total", "1,250"]]):
        for c, value in enumerate(row):
            table.cell(r, c).text = value
    split_runs(table.cell(1, 0).text_frame.paragraphs[0], [("{{cli", None, {}), ("ent}}", None, {"err": "1"})])
    pic = s5.shapes.add_picture(str(png(tmp / "logo.png")), Inches(8), Inches(1.5), Inches(3))
    pic.name = "Logo"
    pic._element.find(".//{http://schemas.openxmlformats.org/presentationml/2006/main}cNvPr").set("descr", "Company logo")
    s5.notes_slide.notes_text_frame.text = "Prepared for {{client}}"

    s6 = prs.slides.add_slide(layouts[6])
    s6._element.set("show", "0")

    # a master has no add_textbox: make the text box on slide 6, then move it onto the master
    line = s6.shapes.add_textbox(Inches(0.3), Inches(7.0), Inches(4), Inches(0.4))
    line.text_frame.text = "Acme Ltd footer line"
    line.text_frame.paragraphs[0].runs[0].font.size = Pt(10)
    line._element.find(".//{http://schemas.openxmlformats.org/presentationml/2006/main}cNvPr").set("id", "99")
    prs.slide_masters[0].shapes._spTree.append(line._element)

    add_sections(prs, [("Intro", [1, 2]), ("Detail", [3, 4, 5, 6])])
    prs.save(path)
    return path


@pytest.fixture
def sample(tmp_path: Path) -> Path:
    return build_sample(tmp_path / "sample.pptx", tmp_path)


@pytest.fixture
def title_text() -> str:
    return TITLE


def as_template(src: Path, dst: Path, macro: bool = False) -> Path:
    """The same package with the main part's content type a template's (.potx), or a macro deck's (.pptm)."""
    main = "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"
    new = ("application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml" if macro
           else "application/vnd.openxmlformats-officedocument.presentationml.template.main+xml")
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "[Content_Types].xml":
                data = data.replace(main.encode(), new.encode())
            zout.writestr(item, data)
    return dst


@pytest.fixture
def brand(tmp_path: Path) -> Path:
    """A .potx: python-pptx's design with its layouts renamed 'Brand ...', one sample slide, a section, and the
    'Brand Blank' layout without footer placeholders."""
    from pptx import Presentation

    prs = Presentation()
    for layout in prs.slide_layouts:
        layout._element.cSld.set("name", "Brand " + layout.name)
    blank = prs.slide_layouts[6]
    for ph in list(blank.placeholders):
        ph._element.getparent().remove(ph._element)
    sample = prs.slides.add_slide(prs.slide_layouts[0])
    sample.shapes.title.text = "Sample slide from the brand team"
    add_sections(prs, [("Examples", [1])])
    plain = tmp_path / "brand-src.pptx"
    prs.save(plain)
    return as_template(plain, tmp_path / "brand.potx")


@pytest.fixture
def write_plan(tmp_path: Path):
    """write_plan(steps or plan, name=..., encoding=...) -> path of a plan file in tmp_path."""

    def _write(plan, name: str = "plan.json", encoding: str = "utf-8") -> Path:
        if isinstance(plan, list):
            plan = {"steps": plan}
        path = tmp_path / name
        path.write_bytes(json.dumps(plan, ensure_ascii=False, indent=1).encode(encoding))
        return path

    return _write


def open_deck(path: Path):
    from pptx import Presentation

    return Presentation(str(path))


def texts(path: Path) -> list[str]:
    """All text on each slide, groups and tables included, one string per slide."""
    out = []
    for slide in open_deck(path).slides:
        out.append(" | ".join(t.text for t in slide._element.iter(f"{{{A}}}t") if t.text))
    return out


def titles(path: Path) -> list[str]:
    out = []
    for slide in open_deck(path).slides:
        title = slide.shapes.title
        out.append(title.text if title is not None else "")
    return out


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


@pytest.fixture(scope="session")
def libreoffice() -> str:
    """The real soffice, found the way soffice.py finds it; the test skips when there's none."""
    proc = subprocess.run([sys.executable, str(SCRIPTS / "soffice.py"), "find"], capture_output=True, timeout=60)
    if proc.returncode != 0:
        pytest.skip("LibreOffice isn't installed here (soffice.py find found none); set SOFFICE to run these tests")
    return json.loads(proc.stdout.decode("utf-8"))["soffice"]


def zip_names(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        return z.namelist()


def read_part(path: Path, name: str) -> str:
    with zipfile.ZipFile(path) as z:
        return z.read(name).decode("utf-8")


@pytest.fixture
def h():
    """The helpers above, for the test modules (which can't import this file)."""
    return SimpleNamespace(png=png, split_runs=split_runs, add_sections=add_sections, as_template=as_template,
                           open=open_deck, texts=texts, titles=titles, one_line=one_line, zip_names=zip_names,
                           read_part=read_part, build_sample=build_sample, scripts=SCRIPTS, title=TITLE)
