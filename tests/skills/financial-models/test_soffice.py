"""soffice.py: finding LibreOffice, converting, and recalculating a workbook with an error scan.

The tests marked with the libreoffice fixture run the real program and skip when it isn't installed; the rest use a
stand-in that answers like soffice --convert-to.
"""

from __future__ import annotations

import time
import zipfile
from pathlib import Path

import pytest
from openpyxl import Workbook, load_workbook
from openpyxl.worksheet.formula import DataTableFormula

SKILL, SOFFICE = "financial-models", "soffice.py"


def scratch_left(folder: Path) -> list[str]:
    return [p.name for p in folder.iterdir() if p.name.startswith(".soffice-")]


def failed(r) -> str:
    """A run that couldn't do the job: exit 2, nothing on stdout, one line on stderr, no traceback."""
    assert r.code == 2, r.err
    assert r.out == ""
    lines = r.err.strip().splitlines()
    assert len(lines) == 1 and lines[0].startswith("soffice.py "), r.err
    return lines[0]


def load_module(name: str):
    import importlib.util
    import sys

    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[3] / "skills" / "athena" / SKILL / "scripts" / SOFFICE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def small_book(path: Path, broken: bool = False) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Model"
    ws["A1"] = 5
    ws["A2"] = "=A1*2"
    ws["A3"] = "=1/0" if broken else "=A2+1"
    ws["A4"] = "=_xlfn.QUARTILE.INC(B1:B4,1)" if not broken else "=QUARTILE.INC(B1:B4,1)"
    for i, v in enumerate([1, 3, 5, 7], start=1):
        ws.cell(row=i, column=2, value=v)
    wb.save(path)
    return path


def test_help(run):
    r = run(SKILL, SOFFICE, "--help")
    assert "usage:" in r.out and "recalc" in r.out


def test_find_honours_an_explicit_path(run, fake_soffice):
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "find")
    assert r.json() == {"ok": True, "soffice": str(fake_soffice), "found_by": "--soffice"}
    assert run(SKILL, SOFFICE, "find", "--soffice", fake_soffice).json()["found_by"] == "--soffice"
    r = run(SKILL, SOFFICE, "find", env={"SOFFICE": str(fake_soffice)})
    assert r.json()["found_by"] == "SOFFICE"


def test_a_wrong_explicit_path_is_an_error_not_a_fallback(run, tmp_path):
    r = run(SKILL, SOFFICE, "find", env={"SOFFICE": str(tmp_path / "nowhere" / "soffice")}, ok=False)
    assert "SOFFICE" in failed(r)


def test_not_installed_is_one_line_naming_the_ways_to_install(tmp_path, monkeypatch, capsys):
    module = load_module("soffice_under_test")
    monkeypatch.delenv("SOFFICE", raising=False)
    monkeypatch.setattr(module.shutil, "which", lambda name: None)
    monkeypatch.setattr(module, "known_locations", lambda: [str(tmp_path / "missing" / "soffice")])
    monkeypatch.setattr(module.sys, "argv", ["soffice.py", "find"])
    with pytest.raises(SystemExit) as stop:
        module.main()
    assert stop.value.code == 2
    out, err = capsys.readouterr()
    assert out == "" and len(err.strip().splitlines()) == 1
    for said in ("isn't installed", "ask them first", "--soffice", "winget", "brew", "apt", "libreoffice.org/download"):
        assert said in err


def test_convert_writes_the_output_and_leaves_the_input_alone(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    before = src.read_bytes()
    out = tmp_path / "out" / "model.pdf"
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "pdf", "-o", out)
    assert r.json()["ok"] is True
    assert out.read_bytes() == before  # the stand-in copies its input
    assert src.read_bytes() == before
    assert scratch_left(out.parent) == []


def test_convert_refuses_to_overwrite_its_input(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    before = src.read_bytes()
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "xlsx", "-o", src, ok=False)
    assert "overwrite the input" in failed(r)
    assert src.read_bytes() == before


def test_convert_wants_the_output_to_match_the_format(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "pdf", "-o", tmp_path / "x.xlsx", ok=False)
    assert ".pdf" in failed(r)


def test_no_output_is_reported(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "pdf", "-o", tmp_path / "m.pdf", env={"FAKE_SOFFICE": "silent"}, ok=False)
    line = failed(r)
    assert "LibreOffice produced no file (it exited 0)" in line
    assert "convert done" in line  # what LibreOffice said
    assert scratch_left(tmp_path) == []


def test_a_hung_conversion_is_stopped(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    started = time.monotonic()
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "pdf", "-o", tmp_path / "m.pdf", "--timeout", "3", env={"FAKE_SOFFICE": "hang"}, ok=False)
    assert "didn't finish within 3 seconds" in failed(r)
    assert time.monotonic() - started < 60
    assert not (tmp_path / "m.pdf").exists()


def test_timeout_and_limit_must_make_sense(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    for bad in (["--timeout", "0"], ["--timeout", "-5"], ["--limit", "-1"]):
        r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "recalc", src, "-o", tmp_path / "c.xlsx", *bad, ok=False)
        assert r.code == 2 and bad[0] in r.err and "Traceback" not in r.err
    assert not (tmp_path / "c.xlsx").exists()


def test_a_file_problem_is_one_line_naming_the_path(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    (tmp_path / "a-file").write_text("x", encoding="utf-8")
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "pdf", "-o", tmp_path / "a-file" / "m.pdf", ok=False)
    assert "a-file" in failed(r)
    # the output path is taken by a folder
    (tmp_path / "taken.pdf").mkdir()
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "pdf", "-o", tmp_path / "taken.pdf", ok=False)
    assert "taken.pdf" in failed(r)
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", tmp_path / "missing.xlsx", "--to", "pdf", "-o", tmp_path / "m.pdf", ok=False)
    assert "missing.xlsx" in failed(r)
    assert scratch_left(tmp_path) == []


def test_convert_replaces_an_older_output_and_says_what_it_left_out(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    out = tmp_path / "model.html"
    out.write_text("old", encoding="utf-8")
    body = run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "html", "-o", out, env={"FAKE_SOFFICE": "extra"}).json()
    assert out.read_bytes() == src.read_bytes()
    assert body["not_kept"] == ["model_img0.png"] and "note" in body
    assert sorted(p.name for p in tmp_path.iterdir() if p.is_file()) == ["model.html", "model.xlsx"]
    assert "not_kept" not in run(SKILL, SOFFICE, "--soffice", fake_soffice, "convert", src, "--to", "html", "-o", out).json()


def test_the_windows_registry_entry_is_one_of_the_places_looked(tmp_path, monkeypatch):
    import sys
    import types

    module = load_module("soffice_registry")
    folder = str(tmp_path / "D-drive" / "LibreOffice" / "program")

    class Key:
        def __init__(self, hive: str, path: str) -> None:
            if (hive, path) != ("HKLM", r"SOFTWARE\LibreOffice\UNO\InstallPath"):
                raise OSError("no such key")

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    fake = types.SimpleNamespace(HKEY_CURRENT_USER="HKCU", HKEY_LOCAL_MACHINE="HKLM", OpenKey=Key,
                                 QueryValueEx=lambda key, name: (folder, 1))
    monkeypatch.setitem(sys.modules, "winreg", fake)
    assert module.registered_install() == [str(Path(folder) / "soffice.exe")]
    monkeypatch.setattr(module.sys, "platform", "win32")
    assert module.known_locations()[0] == str(Path(folder) / "soffice.exe")


def test_recalc_only_writes_xlsx(run, tmp_path, fake_soffice):
    src = small_book(tmp_path / "model.xlsx")
    r = run(SKILL, SOFFICE, "--soffice", fake_soffice, "recalc", src, "-o", tmp_path / "model.ods", ok=False)
    assert ".xlsx" in failed(r)


# --- with the real LibreOffice


def test_recalc_fills_in_results(run, tmp_path, libreoffice):
    src = small_book(tmp_path / "model.xlsx")
    out = tmp_path / "model-calc.xlsx"
    r = run(SKILL, SOFFICE, "recalc", src, "-o", out)
    body = r.json()
    assert body["ok"] is True and body["error_count"] == 0 and body["formulas"] == 3
    values = load_workbook(out, data_only=True)["Model"]
    assert (values["A2"].value, values["A3"].value, values["A4"].value) == (10, 11, 2.5)
    assert load_workbook(src, data_only=True)["Model"]["A2"].value is None  # the input keeps no results
    assert scratch_left(tmp_path) == []


def test_recalc_lists_error_cells_with_hints(run, tmp_path, libreoffice):
    src = small_book(tmp_path / "broken.xlsx", broken=True)
    r = run(SKILL, SOFFICE, "recalc", src, "-o", tmp_path / "broken-calc.xlsx", ok=False)
    assert r.code == 1 and r.err == ""  # the job ran: what it found is the result, on stdout
    body = r.json()
    assert body["ok"] is False and body["error_count"] == 2
    found = {(e["cell"], e["error"]) for e in body["errors"]}
    assert found == {("A3", "#DIV/0!"), ("A4", "#NAME?")}
    assert body["errors"][0]["sheet"] == "Model" and body["errors"][0]["formula"].startswith("=")
    assert "_xlfn." in body["hints"]["#NAME?"]


def test_recalc_recalculates_stale_results(run, tmp_path, libreoffice, with_results):
    plain = small_book(tmp_path / "plain.xlsx")
    stale = with_results(plain, tmp_path / "stale.xlsx", {("Model", "A2"): 999, ("Model", "A3"): 1000, ("Model", "A4"): 0})
    assert load_workbook(stale, data_only=True)["Model"]["A2"].value == 999
    out = tmp_path / "fresh.xlsx"
    run(SKILL, SOFFICE, "recalc", stale, "-o", out)
    assert load_workbook(out, data_only=True)["Model"]["A2"].value == 10


def test_recalc_warns_about_excel_data_tables(run, tmp_path, libreoffice):
    wb = Workbook()
    ws = wb.active
    ws["A1"], ws["A2"], ws["A3"], ws["C3"] = 2, 3, "=A1*A2", "=A3"
    for i, v in enumerate([1, 2, 3]):
        ws.cell(row=4 + i, column=3, value=v)
        ws.cell(row=3, column=4 + i, value=10 * v)
    ws["D4"] = DataTableFormula(ref="D4:F6", dt2D=True, r1="A2", r2="A1")
    src = tmp_path / "table.xlsx"
    wb.save(src)
    r = run(SKILL, SOFFICE, "recalc", src, "-o", tmp_path / "table-calc.xlsx")
    assert "data tables" in r.json()["warnings"][0]


def test_convert_to_pdf(run, tmp_path, libreoffice):
    src = small_book(tmp_path / "model.xlsx")
    out = tmp_path / "model.pdf"
    run(SKILL, SOFFICE, "convert", src, "--to", "pdf", "-o", out)
    assert out.read_bytes()[:5] == b"%PDF-"
    assert zipfile.is_zipfile(src)


def test_format_names_and_paths_as_people_write_them(run, tmp_path, libreoffice):
    # LibreOffice itself has no export filter called "PDF"; spaces, # and accents in folders and names are common
    folder = tmp_path / "Q3 #2 Prüfung"
    folder.mkdir()
    src = small_book(folder / "Modèle 100%.xlsx")
    out = tmp_path / "out é" / "Modèle 100%.PDF"
    run(SKILL, SOFFICE, "convert", src, "--to", "PDF", "-o", out)
    assert out.read_bytes()[:5] == b"%PDF-"
