"""Real PDFs for the pdf skill's tests, drawn with reportlab (not with the scripts under test)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

TITLE = "Отчёт о продажах"  # not in Windows-1252, so printing it proves the scripts switch their output to UTF-8


def _png(path: Path, colour: tuple[int, int, int] = (30, 120, 200), size: tuple[int, int] = (120, 80)) -> Path:
    from PIL import Image

    Image.new("RGB", size, colour).save(path)
    return path


@pytest.fixture
def report_title() -> str:
    return TITLE


@pytest.fixture
def png(tmp_path: Path) -> Path:
    return _png(tmp_path / "picture.png")


@pytest.fixture
def report_pdf(tmp_path: Path) -> Path:
    """Three A4 pages: text and a ruled table and a picture; text only; a picture and no text (like a scan)."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    picture = _png(tmp_path / "embedded.png", (200, 60, 40))
    path = tmp_path / "report.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle(TITLE)
    c.setAuthor("Test author")
    c.setFont("Helvetica", 12)
    c.drawString(72, 780, "Alpha page ALPHAMARK")
    rows = [("Region", "Units"), ("North", "1250"), ("South", "980")]
    x0, x1, x2, top, step = 72, 200, 300, 740, 20
    for i, (a, b) in enumerate(rows):
        y = top - i * step
        c.drawString(x0 + 4, y - 14, a)
        c.drawString(x1 + 4, y - 14, b)
    for i in range(len(rows) + 1):
        c.line(x0, top - i * step, x2, top - i * step)
    for x in (x0, x1, x2):
        c.line(x, top, x, top - len(rows) * step)
    c.drawImage(str(picture), 72, 500, width=120, height=80)
    c.showPage()
    c.setFont("Helvetica", 12)
    c.drawString(72, 780, "Beta page BETAMARK")
    c.showPage()
    c.drawImage(str(picture), 0, 0, width=A4[0], height=A4[1])
    c.showPage()
    c.save()
    return path


@pytest.fixture
def form_pdf(tmp_path: Path) -> Path:
    """A fillable form: a text field, a checkbox, a two-button radio group and a dropdown."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    path = tmp_path / "form.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.drawString(72, 760, "Example form")
    form = c.acroForm
    form.textfield(name="surname", x=72, y=700, width=300, height=20, value="", maxlen=None, fieldFlags="")
    form.checkbox(name="agree", x=72, y=660, size=20, buttonStyle="check", fieldFlags="")
    form.radio(name="color", value="red", x=72, y=620, size=20, selected=False, fieldFlags="noToggleToOff radio")
    form.radio(name="color", value="blue", x=110, y=620, size=20, selected=True, fieldFlags="noToggleToOff radio")
    form.choice(name="size", x=72, y=580, width=120, height=20, options=["small", "large"], value="small")
    c.save()
    return path


@pytest.fixture
def vera_ttf() -> str:
    """Bitstream Vera, which reportlab ships: it has Ł, π and ≤ (outside Windows-1252) but no Cyrillic."""
    import reportlab

    path = os.path.join(os.path.dirname(reportlab.__file__), "fonts", "Vera.ttf")
    assert os.path.isfile(path)
    return path


@pytest.fixture
def hide(tmp_path: Path):
    """hide('pypdf', ...) -> env that makes those packages fail to import in the script's process."""

    def _hide(*modules: str) -> dict[str, str]:
        stubs = tmp_path / "hidden-packages"
        for name in modules:
            pkg = stubs / name
            pkg.mkdir(parents=True, exist_ok=True)
            (pkg / "__init__.py").write_text(f"raise ImportError('{name} is hidden for this test')\n", encoding="utf-8")
        return {"PYTHONPATH": str(stubs)}

    return _hide
