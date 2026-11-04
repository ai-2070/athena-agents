"""kernel.py, on a real ipykernel started by the script in the background.

Each test starts its kernel in tmp_path and stops it at the end; the teardown fails the test if any kernel it started is
still running. The run fixture captures the script's output through pipes, so a start that let the kernel hold on to
them would never return: every passing start shows the kernel is detached from the shell command.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

pytest.importorskip("ipykernel", reason="the kernel tests need ipykernel (python -m pip install ipykernel)")
pytest.importorskip("jupyter_client", reason="kernel.py needs jupyter_client")
psutil = pytest.importorskip("psutil", reason="kernel.py needs psutil")

SKILL = "jupyter-notebook"
SKILL_DIR = Path(__file__).resolve().parents[3] / "skills" / "athena" / SKILL
KERNEL = SKILL_DIR / "scripts" / "kernel.py"
COMMANDS = ["start", "run", "vars", "interrupt", "restart", "stop", "status"]


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


class Kernel:
    """Runs kernel.py commands from tmp_path and remembers every kernel process they start."""

    def __init__(self, run: Any, tmp_path: Path) -> None:
        self._run = run
        self.tmp = tmp_path
        self.folder = tmp_path / "jupyter-work"
        self.procs: list[Any] = []

    def __call__(self, *args: object, ok: bool = True) -> Any:
        return self._run(SKILL, "kernel.py", *args, ok=ok)

    def track(self, pid: int) -> None:
        try:
            self.procs.append(psutil.Process(pid))
        except psutil.NoSuchProcess:
            pass

    def start(self, *args: object) -> dict[str, Any]:
        info = self("start", *args).json()
        self.track(info["pid"])
        return info

    def code(self, text: str, name: str = "step.py", encoding: str = "utf-8") -> Path:
        self.folder.mkdir(exist_ok=True)
        path = self.folder / name
        path.write_bytes(text.encode(encoding))
        return path

    def cell(self, text: str, *args: object, ok: bool = True) -> Any:
        return self("run", "--code-file", self.code(text), *args, ok=ok)

    def background(self, text: str, *args: object) -> subprocess.Popen:
        """A run in its own process, still going while the test does other things."""
        env = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0", "PYTHONDONTWRITEBYTECODE": "1"}
        path = self.code(text, "background.py")
        return subprocess.Popen([sys.executable, str(KERNEL), "run", "--code-file", str(path), *map(str, args)],
                                cwd=self.tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def running(self) -> list[Any]:
        left = []
        for proc in self.procs:
            try:
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    left.append(proc)
            except psutil.Error:
                pass
        return left


@pytest.fixture
def k(run, tmp_path):
    kernel = Kernel(run, tmp_path)
    yield kernel
    kernel("stop", ok=False)
    left = kernel.running()
    for proc in left:
        proc.kill()
    assert not left, f"kernels left running after the test: {[p.pid for p in left]}"


@pytest.fixture
def started(k):
    k.start()
    return k


def wait_until(check: Any, seconds: float = 30) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.2)
    return False


# ---------------------------------------------------------------- start and the work folder


@pytest.mark.parametrize("command", COMMANDS)
def test_every_command_has_help(k, command):
    r = k(command, "--help")
    assert "usage:" in r.out and "example:" in r.out and "--dir" in r.out


def test_start_reports_the_kernel_and_keeps_its_key_private(k):
    info = k.start()
    assert info["state"] == "idle"
    assert Path(info["connection_file"]) == k.folder / "kernel.json"
    assert Path(info["cwd"]).resolve() == k.tmp.resolve()
    assert info["python_version"].count(".") == 2 and info["python"]
    assert {p.name for p in k.folder.iterdir()} >= {"kernel.json", "kernel-state.json", "kernel.log"}
    if os.name == "posix":
        assert (k.folder / "kernel.json").stat().st_mode & 0o077 == 0, "the connection file is readable by others"
    again = k("start").json()
    assert again["already_running"] is True and again["pid"] == info["pid"]


def test_the_kernel_works_in_the_folder_it_was_given(k):
    (k.tmp / "data").mkdir()
    (k.tmp / "data" / "numbers.txt").write_text("3\n4\n", encoding="utf-8")
    k.start("--cwd", k.tmp / "data")
    r = k("run", "--code", "sum(int(n) for n in open('numbers.txt'))")
    assert r.json()["outputs"][0]["text"] == "7"


# ---------------------------------------------------------------- run


def test_variables_stay_from_one_run_to_the_next(started):
    first = started.cell("import math\nx = 41\nprint('Отчёт: Łódź')\n").json()
    assert first["status"] == "ok" and first["stdout"] == "Отчёт: Łódź\n"
    second = started("run", "--code", "x + 1").json()
    assert second["status"] == "ok"
    assert second["outputs"] == [{"kind": "result", "text": "42"}]
    assert second["execution_count"] == first["execution_count"] + 1


def test_an_error_comes_back_as_json_without_colour_codes(started):
    r = started.cell("prices = {'a': 1}\nprint('before')\nprices['price']\n", ok=False)
    assert r.code == 1 and r.err == ""
    result = r.json()
    assert result["status"] == "error"
    assert result["stdout"] == "before\n"
    assert result["error"]["ename"] == "KeyError" and result["error"]["evalue"] == "'price'"
    assert "\x1b" not in result["error"]["traceback"]
    assert "prices['price']" in result["error"]["traceback"]
    # the kernel is fine afterwards, and kept what ran before the error
    assert started("run", "--code", "prices").json()["outputs"][0]["text"] == "{'a': 1}"


def test_a_run_past_its_timeout_is_interrupted_and_keeps_earlier_variables(started):
    begun = time.monotonic()
    r = started.cell("import time\nmark = 7\nwhile True:\n    time.sleep(0.05)\n", "--timeout", "3", ok=False)
    assert r.code == 1 and r.err == ""
    result = r.json()
    assert result["status"] == "timeout"
    assert result["error"]["ename"] == "KeyboardInterrupt"
    assert "interrupted after 3 seconds" in result["note"]
    assert time.monotonic() - begun < 60
    assert started("run", "--code", "mark").json()["outputs"][0]["text"] == "7"


def test_interrupt_stops_code_a_run_in_another_process_left_running(started):
    slow = started.background("import time\nfor i in range(2400):\n    time.sleep(0.05)\n", "--timeout", "250")
    try:
        assert wait_until(lambda: started("status").json()["state"] == "busy"), "the kernel never got busy"
        busy = started("run", "--code", "1", ok=False)
        assert busy.code == 2 and one_line(busy.err) and "still running earlier code" in busy.err
        stopped = started("interrupt").json()
        assert stopped == {"interrupted": True, "state": "idle"}
        out, err = slow.communicate(timeout=60)
    finally:
        if slow.poll() is None:
            slow.kill()
            slow.communicate()
    assert slow.returncode == 1, err
    result = json.loads(out.decode("utf-8"))
    assert result["status"] == "error" and result["error"]["ename"] == "KeyboardInterrupt"
    assert started("status").json()["state"] == "idle"


def test_pictures_are_saved_as_files_in_the_work_folder(started):
    from PIL import Image

    png = started.tmp / "red.png"
    Image.new("RGB", (30, 20), (200, 10, 10)).save(png)
    code = ("from IPython.display import Image, HTML, display\n"
            f"display(Image(filename={str(png)!r}))\n"
            f"display(Image(filename={str(png)!r}))\n"
            "display(HTML('<b>bold</b>'))\n")
    result = started.cell(code).json()
    first, second, html = result["outputs"]
    assert Path(first["image"]).parent == started.folder / "images"
    assert Path(first["image"]).read_bytes() == png.read_bytes()
    assert first["image"] != second["image"] and Path(second["image"]).is_file()
    assert "text" not in first  # the default "<... object>" text says nothing
    assert html == {"kind": "display", "formats": ["text/html"]}


def test_long_output_is_cut_in_the_middle(started):
    result = started.cell("print('start ' + 'x' * 50000 + ' end')\n", "--max-chars", "2000").json()
    assert result["cut"] is True
    assert result["stdout"].startswith("start ") and result["stdout"].rstrip().endswith(" end")
    assert "characters cut" in result["stdout"] and len(result["stdout"]) < 2500


def test_progress_bars_keep_only_their_last_state(started):
    code = "import sys\nfor i in range(5):\n    sys.stderr.write(f'\\r{i * 20}%')\nsys.stderr.write('\\r100%\\n')\n"
    assert started.cell(code).json()["stderr"] == "100%\n"


def test_a_code_file_saved_by_windows_powershell_is_read(started):
    utf16 = started.code("print('Łódź Отчёт')\n", "utf16.py", encoding="utf-16")  # what PowerShell 5.1's > writes
    assert utf16.read_bytes()[:2] in (b"\xff\xfe", b"\xfe\xff")
    assert started("run", "--code-file", utf16).json()["stdout"] == "Łódź Отчёт\n"
    ansi = started.code("print('café')\n", "ansi.py", encoding="cp1252")  # what Set-Content writes
    result = started("run", "--code-file", ansi).json()
    assert result["stdout"] == "café\n"
    assert "isn't UTF-8" in result["encoding_notes"][0]


def test_code_that_takes_the_kernel_down_is_reported(started):
    r = started("run", "--code", "import os; os._exit(3)", ok=False)
    assert r.code == 1
    assert r.json()["status"] == "died" and "variables are gone" in r.json()["note"]
    after = started("run", "--code", "1", ok=False)
    assert after.code == 2 and one_line(after.err) and "has stopped" in after.err
    assert started("status").json()["running"] is False
    fresh = started.start()
    assert fresh["state"] == "idle" and "earlier kernel" in fresh["note"]


# ---------------------------------------------------------------- vars, restart, stop


def test_vars_lists_variables_without_adding_any(started):
    started.cell(
        "import json, os as operating\n"
        "class Frame:\n"
        "    shape = (2, 3)\n"
        "    columns = ['region', 'units', 'price']\n"
        "    dtypes = ['object', 'int64', 'float64']\n"
        "frame = Frame()\n"
        "nums = list(range(100))\n"
        "label = 'q' * 500\n"
        "def helper(a):\n"
        "    return a\n"
    )
    before = started("run", "--code", "1").json()["execution_count"]
    listing = started("vars").json()
    found = {v["name"]: v for v in listing["variables"]}
    assert set(found) == {"Frame", "frame", "nums", "label", "helper"}
    assert listing["count"] == 5 and listing["modules"] == ["json", "operating"]
    assert found["frame"]["shape"] == [2, 3]
    assert found["frame"]["columns"] == ["region (object)", "units (int64)", "price (float64)"]
    assert found["nums"]["len"] == 100 and found["nums"]["preview"].startswith("[0, 1, 2")
    assert found["label"]["len"] == 500 and len(found["label"]["preview"]) < 100
    assert found["helper"] == {"name": "helper", "type": "function"}
    assert found["Frame"] == {"name": "Frame", "type": "type"}
    # listing them ran no cell and left nothing behind
    assert started("run", "--code", "2").json()["execution_count"] == before + 1
    assert started("vars").json()["count"] == 5


def test_restart_starts_over_with_no_variables(started):
    old = started("status").json()["pid"]
    started("run", "--code", "x = 1")
    new = started("restart").json()
    started.track(new["pid"])
    assert new["restarted"] is True and new["pid"] != old
    assert not psutil.pid_exists(old) or psutil.Process(old).status() == psutil.STATUS_ZOMBIE
    r = started("run", "--code", "x", ok=False)
    assert r.code == 1 and r.json()["error"]["ename"] == "NameError"


def test_stop_ends_the_kernel_and_removes_its_files(started):
    started.cell("x = 1\n")  # leaves the code file in the work folder
    started("run", "--code", "from IPython.display import Image")
    result = started("stop").json()
    assert result["was_running"] is True and result["forced"] is False
    assert {"kernel.json", "kernel-state.json", "kernel.log"} <= set(result["removed"])
    assert result["left_in_folder"] == ["step.py"]
    assert started.running() == []
    (started.folder / "step.py").unlink()
    again = started("stop").json()
    assert again["was_running"] is False and again["folder_removed"] is True
    assert not started.folder.exists()


def test_stop_kills_a_kernel_that_will_not_shut_down(started):
    slow = started.background("import time\nwhile True:\n    try:\n        time.sleep(0.05)\n    except BaseException:\n"
                              "        pass\n", "--timeout", "250")
    try:
        assert wait_until(lambda: started("status").json()["state"] == "busy")
        result = started("stop", "--wait", "2").json()
        # a kernel stops only between cells, so one stuck in a cell is killed
        assert result["was_running"] is True and result["forced"] is True
        assert started.running() == []
        slow.communicate(timeout=60)
    finally:
        if slow.poll() is None:
            slow.kill()
            slow.communicate()


# ---------------------------------------------------------------- mistakes


def test_commands_without_a_kernel_say_so_in_one_line(k):
    for args in (["run", "--code", "1"], ["vars"], ["interrupt"], ["restart"]):
        r = k(*args, ok=False)
        assert r.code == 2 and one_line(r.err) and r.out == "", (args, r.err)
        assert "start" in r.err
    assert k("status").json()["running"] is False
    assert k("stop").json()["was_running"] is False


@pytest.mark.parametrize("args, says", [
    ([], "needs a command"),
    (["run"], "required"),
    (["run", "--code", "1", "--code-file", "x.py"], "not allowed with"),
    (["run", "--code", "1", "--timeout", "0"], "above 0"),
    (["run", "--code", "1", "--timeout", "-5"], "above 0"),
    (["run", "--code", "1", "--timeout", "nan"], "above 0"),
    (["run", "--code", "1", "--timeout", "soon"], "isn't a number"),
    (["run", "--code", "1", "--max-chars", "0"], "1 or more"),
    (["start", "--wait", "0"], "above 0"),
    (["stop", "--wait", "-1"], "above 0"),
    (["run", "--code-file", "missing.py"], "can't read the code file"),
    (["start", "--python", "no-such-python-here"], "no Python at"),
    (["start", "--cwd", "no-such-folder"], "no folder"),
    (["start", "--dir", str(SKILL_DIR / "work")], "skill's own folder"),
    (["start", "--dir", "."], "not the current folder"),
    (["stop", "--dir", ".."], "not the current folder"),
    (["start", "--cwd", "jupyter-work"], "kernel's own folder"),
])
def test_mistakes_are_one_line_with_exit_code_2(k, args, says):
    r = k(*args, ok=False)
    assert r.code == 2 and one_line(r.err) and says in r.err, r.err
    assert r.out == ""


def test_a_work_folder_that_is_a_file_is_one_line(k):
    (k.tmp / "jupyter-work").write_text("not a folder", encoding="utf-8")
    r = k("start", ok=False)
    assert r.code == 2 and one_line(r.err) and "jupyter-work" in r.err


def test_files_in_the_work_folder_that_are_not_the_kernels_are_left_alone(k):
    k.folder.mkdir()
    (k.folder / "kernel.json").write_text('{"argv": ["python"]}', encoding="utf-8")  # a kernel spec, say
    r = k("start", ok=False)
    assert r.code == 2 and one_line(r.err) and "someone else's" in r.err
    assert (k.folder / "kernel.json").read_text(encoding="utf-8") == '{"argv": ["python"]}'
    (k.folder / "kernel.json").unlink()
    (k.folder / "images").mkdir()
    (k.folder / "images" / "logo.png").write_bytes(b"mine")
    k.start()
    k("run", "--code", "from IPython.display import SVG, display; display(SVG('<svg xmlns=\"http://www.w3.org/2000/svg\"/>'))")
    assert sorted(p.name for p in (k.folder / "images").iterdir()) == ["cell1.svg", "logo.png"]
    result = k("stop").json()
    assert (k.folder / "images" / "logo.png").read_bytes() == b"mine"
    assert result["left_in_folder"] == ["images"]


def test_a_damaged_state_file_is_reported_and_stop_clears_it(k):
    k.folder.mkdir()
    (k.folder / "kernel-state.json").write_text("{not json", encoding="utf-8")
    r = k("run", "--code", "1", ok=False)
    assert r.code == 2 and one_line(r.err) and "damaged" in r.err
    result = k("stop").json()
    assert result["folder_removed"] is True and "damaged" in result["note"]


def test_a_python_without_ipykernel_is_named(k):
    bare = k.tmp / "bare"
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(bare)], check=True, timeout=120)
    python = bare / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    r = k("start", "--python", python, ok=False)
    assert r.code == 2 and one_line(r.err) and "has no ipykernel" in r.err, r.err
    assert not (k.folder / "kernel.json").exists()
