"""Fixtures for the financial-models tests: workbooks with results written in, a stand-in for LibreOffice, and the real
one when it's installed."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

import pytest

SCRIPTS = Path(__file__).resolve().parents[3] / "skills" / "athena" / "financial-models" / "scripts"
MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"


def _with_results(src: Path, dst: Path, results: dict) -> Path:
    """Copy an openpyxl workbook, writing cached results into its cells the way a spreadsheet program saves them.

    results maps (sheet title, cell) to a number, a bool, a string, or an error value such as "#DIV/0!".
    """
    from openpyxl import load_workbook

    titles = [ws.title for ws in load_workbook(src).worksheets]
    ElementTree.register_namespace("", MAIN)
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            name = item.filename
            if name.startswith("xl/worksheets/sheet") and name.endswith(".xml"):
                title = titles[int(name[len("xl/worksheets/sheet"):-4]) - 1]
                root = ElementTree.fromstring(data)
                for c in root.iter(f"{{{MAIN}}}c"):
                    key = (title, c.get("r"))
                    if key not in results:
                        continue
                    value = results[key]
                    for old in c.findall(f"{{{MAIN}}}v"):
                        c.remove(old)
                    v = ElementTree.SubElement(c, f"{{{MAIN}}}v")
                    if isinstance(value, bool):
                        c.set("t", "b")
                        v.text = "1" if value else "0"
                    elif isinstance(value, str) and value.startswith("#"):
                        c.set("t", "e")
                        v.text = value
                    elif isinstance(value, str):
                        c.set("t", "str")
                        v.text = value
                    else:
                        c.attrib.pop("t", None)
                        v.text = repr(value)
                data = ElementTree.tostring(root, xml_declaration=True, encoding="UTF-8")
            zout.writestr(item, data)
    return dst


@pytest.fixture
def with_results():
    return _with_results


FAKE = r'''
import os, shutil, sys, time
from urllib.parse import urlparse
from urllib.request import url2pathname
args = sys.argv[1:]
profile = next(a for a in args if a.startswith("-env:UserInstallation="))
folder = url2pathname(urlparse(profile.split("=", 1)[1]).path)
with open(os.path.join(folder, "user", "registrymodifications.xcu"), encoding="utf-8") as fh:
    if "OOXMLRecalcMode" not in fh.read():
        sys.exit(3)
to = args[args.index("--convert-to") + 1].split(":", 1)[0]
outdir = args[args.index("--outdir") + 1]
src = args[-1]
mode = os.environ.get("FAKE_SOFFICE", "ok")
if mode == "hang":
    time.sleep(120)
stem = os.path.splitext(os.path.basename(src))[0]
if mode in ("ok", "extra"):
    shutil.copyfile(src, os.path.join(outdir, stem + "." + to))
if mode == "extra":  # as an HTML export writes its pictures beside the page
    open(os.path.join(outdir, stem + "_img0.png"), "wb").close()
print("convert done")
'''


@pytest.fixture
def fake_soffice(tmp_path: Path) -> Path:
    """A program that answers like soffice --convert-to: copies the input (FAKE_SOFFICE=ok), also writes a picture
    (extra), hangs, or writes nothing."""
    folder = tmp_path / "fake"
    folder.mkdir()
    if os.name == "nt":
        script = folder / "fake_soffice.py"
        script.write_text(FAKE, encoding="utf-8")
        launcher = folder / "soffice.cmd"
        launcher.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        launcher = folder / "soffice"
        launcher.write_text(f"#!{sys.executable}\n" + FAKE, encoding="utf-8")
        launcher.chmod(launcher.stat().st_mode | stat.S_IXUSR)
    return launcher


@pytest.fixture(scope="session")
def libreoffice() -> str:
    """The real soffice, found the way the script finds it; the test skips when there's none."""
    proc = subprocess.run([sys.executable, str(SCRIPTS / "soffice.py"), "find"], capture_output=True, timeout=60)
    if proc.returncode != 0:
        pytest.skip("LibreOffice isn't installed here (soffice.py find found none); set SOFFICE to run these tests")
    return json.loads(proc.stdout.decode("utf-8"))["soffice"]
