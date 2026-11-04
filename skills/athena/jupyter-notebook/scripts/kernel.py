#!/usr/bin/env python3
"""A live Python kernel for work done a step at a time: start one in the background, run code in it again and again
with its variables kept from one run to the next, list them, interrupt it, restart it and stop it.

    python kernel.py start
    python kernel.py run --code-file jupyter-work/step.py
    python kernel.py vars
    python kernel.py stop

Packages: jupyter_client 8 or newer and psutil for this script, and ipykernel in the Python the kernel runs on (this
one, unless --python names another). ipykernel brings the other two: python -m pip install ipykernel

The kernel is ipykernel, Jupyter's own Python kernel, started on its own so it outlives the shell command that
started it. It listens on 127.0.0.1 only and checks every message against a key. Its files live in a work folder
(--dir, default jupyter-work in the current folder):
  kernel.json        Jupyter's connection file. It holds the key, which lets any program that reads it run code as
                     you: only you can read it, and it is never shared or committed.
  kernel-state.json  which process the kernel is and how it was started
  kernel.log         what the kernel printed outside its cells (why it didn't start, or died)
  images/            pictures that cells showed, such as charts, one file each
stop removes them all, and the folder too when nothing else is left in it.

Each command prints JSON on stdout. Exit codes: 0 done; 1 run's code raised an error, timed out, was skipped or took
the kernel down (its "status" says which); 2 the command couldn't do its job, and one line on stderr says why.
"""

from __future__ import annotations

import argparse
import ast
import base64
import codecs
import contextlib
import importlib
import json
import locale
import logging
import os
import queue
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import warnings
from datetime import datetime
from typing import Any, Callable, Iterator, NoReturn

DEFAULT_DIR = "jupyter-work"
CONNECTION, STATE, LOG, IMAGES = "kernel.json", "kernel-state.json", "kernel.log", "images"
START_WAIT = 60.0  # seconds for a new kernel to answer: as long as Jupyter waits (nbclient's startup_timeout)
RUN_TIMEOUT = 60.0
VARS_TIMEOUT = 30.0
STOP_WAIT = 5.0  # what Jupyter gives a kernel asked to shut down before killing it (shutdown_wait_time)
INTERRUPT_WAIT = 10.0  # for running code to stop once interrupted
BUSY_WAIT = 3.0  # an idle kernel answers in milliseconds; one that doesn't in this long is running earlier code
MAX_CHARS = 10000  # keeps a reply whole in shell tools that cut long output (the dashboard's keeps 20000)
MAX_VARS = 100
IMAGE_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
               "image/svg+xml": ".svg"}
SAVED_IMAGE = re.compile(r"cell\d+(?:_\d+)?\.(?:png|jpg|gif|webp|svg)")  # the names save_image gives
DEFAULT_REPR = re.compile(r"<[\w.]+ object(?: at 0x[0-9a-fA-F]+)?>")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)")
# the environment a kernel started from inside another Jupyter process would otherwise inherit: JPY_PARENT_PID makes
# the kernel quit when that process ends, which here is this short-lived script
INHERITED = ("JPY_PARENT_PID", "JPY_INTERRUPT_EVENT", "IPY_INTERRUPT_EVENT", "PYTHONEXECUTABLE")


# ---------------------------------------------------------------- helpers (as in the pdf skill's scripts)


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; cell output and file names often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


def need(module: str, package: str) -> Any:
    try:
        mod = importlib.import_module(module)
    except ImportError:
        raise Fail(f"needs the Python package {package}: python -m pip install {package}") from None
    if module == "jupyter_client" and int(str(getattr(mod, "__version__", "0")).split(".")[0]) < 8:
        raise Fail(f"needs jupyter_client 8 or newer (this is {mod.__version__}): "
                   "python -m pip install --upgrade jupyter_client")
    return mod


# What a result also says, gathered while the command runs: a code file read in an encoding other than UTF-8, and
# warnings the Jupyter libraries logged.
NOTES: dict[str, Any] = {}


def emit(data: dict[str, Any], indent: int | None = 2) -> None:
    """Print the result on stdout as JSON, with the notes gathered on the way."""
    for key, value in NOTES.items():
        data.setdefault(key, value)
    print(json.dumps(data, ensure_ascii=False, indent=indent))


class LibraryWarnings(logging.Handler):
    """Puts what the Jupyter libraries log into the result, and keeps it off stderr, which carries only the one line
    saying why a command failed."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)

    def emit(self, record: logging.LogRecord) -> None:
        message = " ".join(record.getMessage().split())
        found = NOTES.setdefault("library_warnings", [])
        if message not in found:
            found.append(message)


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], None]) -> int:
    """Run a command, and turn whatever stops it into one line on stderr and exit code 2, never a traceback. A
    command that ran and found problems prints its result and exits 1 itself."""
    logging.getLogger().addHandler(LibraryWarnings())
    logging.captureWarnings(True)
    warnings.simplefilter("ignore", DeprecationWarning)
    try:
        job()
        return 0
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file open in another program on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename  # for a move into place, the second name is the output
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
    except Exception as e:  # a library can fail deep inside
        why = f"stopped unexpectedly ({type(e).__name__}: {e})"
    print(f"{prog}: " + " ".join(why.split()), file=sys.stderr)
    return 2


def decode(raw: bytes, path: str) -> str:
    """The text of a file, whichever way Windows PowerShell 5.1 wrote it: > and Out-File write UTF-16, Set-Content
    the ANSI code page, -Encoding utf8 UTF-8 with a byte-order mark."""
    if raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return raw.decode("utf-16", "replace")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        ansi = locale.getpreferredencoding(False)
        if codecs.lookup(ansi).name == "utf-8":
            ansi = "cp1252"  # not this machine's code page, so most likely Windows' Western European one
        NOTES.setdefault("encoding_notes", []).append(f"{path} isn't UTF-8; read it as {ansi}")
        return raw.decode(ansi, "replace")


def read_text(path: str, what: str) -> str:
    try:
        with open(path, "rb") as fh:
            return decode(fh.read(), path)
    except OSError as e:
        raise Fail(f"can't read {what} {path}: {e.strerror}") from None


def write_atomic(out: str, write: Callable[[Any], None]) -> None:
    """Write to a temporary file beside the output, then move it into place, so a failure leaves no half file."""
    folder = os.path.dirname(os.path.abspath(out))
    script = os.path.splitext(os.path.basename(__file__))[0]
    fd, tmp = tempfile.mkstemp(prefix=f".{script}-", suffix=".part", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            write(fh)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def free_path(folder: str, name: str, taken: set[str]) -> str:
    """folder/name, or folder/name_2 and so on when that file exists already or another name in this run took it
    (compared without case, as Windows and macOS do)."""
    stem, ext = os.path.splitext(name)
    candidate, n = name, 1
    while candidate.lower() in taken or os.path.lexists(os.path.join(folder, candidate)):
        n += 1
        candidate = f"{stem}_{n}{ext}"
    taken.add(candidate.lower())
    return os.path.join(folder, candidate)


def positive(value: str) -> float:
    """An argparse type: a number of seconds above 0."""
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} isn't a number") from None
    if not number > 0 or number == float("inf"):
        raise argparse.ArgumentTypeError(f"{value} must be a number above 0")
    return number


def whole(value: str) -> int:
    """An argparse type: a whole number of 1 or more."""
    try:
        number = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} isn't a whole number") from None
    if number < 1:
        raise argparse.ArgumentTypeError(f"{value} must be 1 or more")
    return number


# ---------------------------------------------------------------- the work folder and the kernel's process


def inside(path: str, folder: str) -> bool:
    """Whether path is folder or somewhere in it, compared as the file system sees them."""
    path, folder = (os.path.normcase(os.path.realpath(p)) for p in (path, folder))
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def work_dir(path: str, create: bool) -> str:
    folder = os.path.abspath(path)
    if inside(folder, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))):
        raise Fail("the kernel's files go in the workspace, not in the skill's own folder: give --dir a folder there")
    if inside(os.getcwd(), folder):
        # stop deletes the kernel's files, and the folder once it's empty: never the folder you work in
        raise Fail("--dir is a folder of the kernel's own, such as jupyter-work, not the current folder or one above "
                   "it; --cwd sets where code runs")
    if create:
        os.makedirs(folder, exist_ok=True)
    return folder


def read_state(folder: str) -> dict[str, Any] | None:
    path = os.path.join(folder, STATE)
    if not os.path.isfile(path):
        return None
    try:
        state = json.loads(read_text(path, "the kernel's state file"))
    except ValueError:
        state = None
    if not isinstance(state, dict) or not isinstance(state.get("pid"), int):
        raise Fail(f"{path} is damaged: run kernel.py stop to clear the folder, then start a new kernel")
    return state


def write_state(folder: str, state: dict[str, Any]) -> None:
    write_atomic(os.path.join(folder, STATE), lambda fh: fh.write(json.dumps(state, indent=2).encode("utf-8")))


def kernel_process(state: dict[str, Any]) -> Any:
    """The kernel's process while it runs, or None. The start time recorded with the process id makes sure a new
    process that got the same id after the kernel ended is never taken for it."""
    psutil = need("psutil", "psutil")
    try:
        proc = psutil.Process(state["pid"])
        if abs(proc.create_time() - float(state.get("created", 0))) > 1 or proc.status() == psutil.STATUS_ZOMBIE:
            return None
        return proc
    except (psutil.Error, ValueError, TypeError):
        return None


def alive(proc: Any) -> bool:
    psutil = need("psutil", "psutil")
    try:
        return bool(proc.is_running()) and proc.status() != psutil.STATUS_ZOMBIE
    except psutil.Error:
        return False


def log_size(folder: str) -> int:
    try:
        return os.path.getsize(os.path.join(folder, LOG))
    except OSError:
        return 0


def log_tail(folder: str, since: int) -> str:
    """The last line the kernel printed outside its cells after a point in its log (past its start-up banner),
    which says why it didn't start or why it died."""
    try:
        with open(os.path.join(folder, LOG), "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(since, fh.tell() - 4000))
            lines = [ANSI.sub("", line).strip() for line in fh.read().decode("utf-8", "replace").splitlines()]
    except OSError:
        return ""
    lines = [line for line in lines if line]
    return lines[-1][:300] if lines else ""


def running_kernel(path: str) -> tuple[str, dict[str, Any], Any]:
    """The work folder, the state and the process of a kernel that is running, or a Fail saying what to do."""
    folder = work_dir(path, create=False)
    state = read_state(folder) if os.path.isdir(folder) else None
    if state is None:
        raise Fail(f"no kernel is running in {folder}: start one with kernel.py start")
    proc = kernel_process(state)
    if proc is None:
        tail = log_tail(folder, state.get("log_ready", 0))
        raise Fail(f"the kernel in {folder} has stopped, and its variables are gone"
                   + (f" (its log ends: {tail})" if tail else "") + ": start a new one with kernel.py start")
    return folder, state, proc


def remove(path: str) -> bool:
    """Delete a file, waiting a moment for Windows to let go of one a process that just ended had open."""
    for attempt in range(20):
        try:
            os.remove(path)
            return True
        except FileNotFoundError:
            return False
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.1)
    return False


def remove_kernel_files(folder: str, everything: bool) -> list[str]:
    removed = [name for name in (CONNECTION, STATE) if remove(os.path.join(folder, name))]
    if everything:
        if remove(os.path.join(folder, LOG)):
            removed.append(LOG)
        images = os.path.join(folder, IMAGES)
        if os.path.isdir(images):
            saved = [n for n in os.listdir(images) if SAVED_IMAGE.fullmatch(n)]
            for name in saved:
                remove(os.path.join(images, name))
            if saved:
                removed.append(f"{IMAGES}/ ({len(saved)} pictures)")
            if not os.listdir(images):
                os.rmdir(images)
    return removed


# ---------------------------------------------------------------- talking to the kernel


@contextlib.contextmanager
def client(folder: str) -> Iterator[Any]:
    jupyter_client = need("jupyter_client", "jupyter_client")
    path = os.path.join(folder, CONNECTION)
    kc = jupyter_client.BlockingKernelClient(connection_file=path)
    try:
        kc.load_connection_file()
    except (OSError, ValueError) as e:
        raise Fail(f"can't read the connection file {path}: {e}") from None
    kc.start_channels(shell=True, iopub=True, stdin=False, hb=False, control=True)
    try:
        yield kc
    finally:
        kc.stop_channels()


def reply_for(get: Callable[..., Any], msg_id: str, timeout: float) -> dict[str, Any] | None:
    """The reply to one request from a channel, skipping others, or None when it doesn't come in time."""
    deadline = time.monotonic() + timeout
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            return None
        try:
            msg = get(timeout=left)
        except queue.Empty:
            return None
        if msg.get("parent_header", {}).get("msg_id") == msg_id:
            return msg


def handshake(kc: Any, seconds: float) -> bool:
    """True once the kernel has answered on its shell channel and its output reaches us, so that code sent now runs
    at once and none of its output is missed (what Jupyter's wait_for_ready does)."""
    deadline = time.monotonic() + seconds
    while True:
        left = deadline - time.monotonic()
        if left <= 0:
            return False
        if reply_for(kc.get_shell_msg, kc.kernel_info(), min(1.0, left)) is None:
            continue
        try:
            kc.get_iopub_msg(timeout=0.5)
        except queue.Empty:
            continue
        while True:  # drop what's left over from the handshake
            try:
                kc.get_iopub_msg(timeout=0.05)
            except queue.Empty:
                return True


def probe(kc: Any, seconds: float) -> str:
    """'idle'; 'busy' when only the control channel answers, because a cell is still running; or 'not answering',
    as a kernel still starting doesn't, for up to seconds."""
    deadline = time.monotonic() + seconds
    while True:
        if handshake(kc, max(0.1, min(BUSY_WAIT, deadline - time.monotonic()))):
            return "idle"
        msg = kc.session.msg("kernel_info_request")
        kc.control_channel.send(msg)
        if reply_for(kc.get_control_msg, msg["header"]["msg_id"], 2.0):
            return "busy"
        if time.monotonic() >= deadline:
            return "not answering"


def ready(kc: Any) -> None:
    status = probe(kc, BUSY_WAIT)
    if status == "busy":
        raise Fail("the kernel is still running earlier code (a run that outlived its shell command?): wait and "
                   "try again, or stop that code with kernel.py interrupt")
    if status == "not answering":
        raise Fail("the kernel isn't answering: restart it with kernel.py restart (its variables will be lost)")


def ask(kc: Any, expressions: dict[str, str], timeout: float) -> dict[str, Any]:
    """Evaluate expressions in the kernel without running a cell: nothing is printed, added to its history or
    counted."""
    msg_id = kc.execute("", silent=True, store_history=False, user_expressions=expressions, allow_stdin=False)
    reply = reply_for(kc.get_shell_msg, msg_id, timeout)
    if reply is None:
        raise Fail(f"the kernel didn't answer within {timeout:g} seconds")
    answers: dict[str, Any] = {}
    for key, value in reply["content"].get("user_expressions", {}).items():
        if value.get("status") != "ok":
            raise Fail(f"the kernel couldn't work out {key}: {value.get('ename')}: {value.get('evalue')}")
        answers[key] = ast.literal_eval(value["data"]["text/plain"])
    return answers


def interrupt(state: dict[str, Any]) -> None:
    """What Jupyter does to interrupt a kernel: SIGINT to its process group, or on Windows the event the kernel
    watches, reached through the kernel's own copy of it since the process that made it has ended."""
    pid = state["pid"]
    if sys.platform == "win32":
        import _winapi

        from jupyter_client.win_interrupt import send_interrupt

        event = state.get("interrupt_event")
        if not event:
            raise Fail("this kernel can't be interrupted: restart it with kernel.py restart")
        source = _winapi.OpenProcess(_winapi.PROCESS_DUP_HANDLE, False, pid)
        try:
            handle = _winapi.DuplicateHandle(source, event, _winapi.GetCurrentProcess(), 0, False,
                                             _winapi.DUPLICATE_SAME_ACCESS)
        finally:
            _winapi.CloseHandle(source)
        try:
            send_interrupt(handle)
        finally:
            _winapi.CloseHandle(handle)
        return
    try:
        os.killpg(pid, signal.SIGINT)  # the kernel leads its own session, so this reaches programs it started too
    except OSError:
        os.kill(pid, signal.SIGINT)


def kill_tree(proc: Any) -> None:
    psutil = need("psutil", "psutil")
    try:
        family = proc.children(recursive=True)
    except psutil.Error:
        family = []
    family.append(proc)
    for member in family:
        try:
            member.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(family, timeout=5)


# ---------------------------------------------------------------- start, restart, stop


def launch(folder: str, python: str, cwd: str, wait: float) -> dict[str, Any]:
    """Start a kernel in the background and wait until it answers."""
    jupyter_client = need("jupyter_client", "jupyter_client")
    psutil = need("psutil", "psutil")
    from jupyter_client.connect import write_connection_file
    from jupyter_client.kernelspec import NATIVE_KERNEL_NAME

    connection = os.path.join(folder, CONNECTION)
    if os.path.exists(connection):
        try:
            found = json.loads(read_text(connection, "the file"))
        except (Fail, ValueError):
            found = None
        if not isinstance(found, dict) or "shell_port" not in found:
            raise Fail(f"{connection} is a file of someone else's: give --dir another folder")
    write_connection_file(connection, ip="127.0.0.1", key=secrets.token_hex(32).encode("ascii"),
                          kernel_name=NATIVE_KERNEL_NAME)
    cmd = [python, "-m", "ipykernel_launcher", "-f", os.path.realpath(connection)]
    env = {k: v for k, v in os.environ.items() if k not in INHERITED}
    event = None
    log_start = log_size(folder)
    # Its output goes to a log, not to this script's: a shell command ends only when everything holding its output
    # has let go, and on Windows only the handles named here are passed on (close_fds), for the same reason.
    with open(os.path.join(folder, LOG), "ab") as log:
        options: dict[str, Any] = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": subprocess.STDOUT,
                                   "cwd": cwd, "env": env, "close_fds": True}
        if sys.platform == "win32":
            from jupyter_client.win_interrupt import create_interrupt_event

            event = int(create_interrupt_event())
            if not event:
                raise Fail("Windows couldn't make the event that interrupts the kernel")
            env["JPY_INTERRUPT_EVENT"] = str(event)
            info = subprocess.STARTUPINFO()
            info.lpAttributeList = {"handle_list": [event]}
            # its own process group, and a console of its own with no window, so programs it runs open none
            flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
            try:
                proc = subprocess.Popen(cmd, startupinfo=info, creationflags=flags | subprocess.CREATE_BREAKAWAY_FROM_JOB,
                                        **options)
            except PermissionError:  # the shell's job doesn't let processes leave it
                proc = subprocess.Popen(cmd, startupinfo=info, creationflags=flags, **options)
        else:
            proc = subprocess.Popen(cmd, start_new_session=True, **options)
    state: dict[str, Any] = {
        "pid": proc.pid,
        "created": psutil.Process(proc.pid).create_time(),
        "python": python,
        "cwd": cwd,
        "started": datetime.now().isoformat(timespec="seconds"),
        "jupyter_client": jupyter_client.__version__,
    }
    if event:
        state["interrupt_event"] = event
    write_state(folder, state)  # before waiting, so a kernel slow to answer can still be found and stopped

    deadline = time.monotonic() + wait
    with client(folder) as kc:
        while not handshake(kc, min(2.0, max(0.1, deadline - time.monotonic()))):
            if proc.poll() is not None:
                tail = log_tail(folder, log_start)
                remove_kernel_files(folder, everything=False)
                if "No module named ipykernel" in tail:
                    raise Fail(f"{python} has no ipykernel; with the user's go-ahead, install it: "
                               f"{python} -m pip install ipykernel")
                raise Fail("the kernel stopped while starting" + (f": {tail}" if tail else ""))
            if time.monotonic() >= deadline:
                raise Fail(f"the kernel didn't answer within {wait:g} seconds (a first start can be slow while "
                           "Python fills its caches): run start again to keep waiting for it, or stop to give up")
        facts = ask(kc, {"python": "__import__('sys').executable",
                         "version": "__import__('platform').python_version()"}, VARS_TIMEOUT)
    state["kernel_python"], state["python_version"] = facts["python"], facts["version"]
    state["log_ready"] = log_size(folder)
    write_state(folder, state)
    return state


def shut_down(folder: str, state: dict[str, Any], wait: float) -> dict[str, Any]:
    """Ask the kernel to shut down, as Jupyter does, and kill it with whatever it started if it hasn't in time."""
    psutil = need("psutil", "psutil")
    proc = kernel_process(state)
    if proc is None:
        return {"was_running": False}
    try:
        with client(folder) as kc:
            reply_for(kc.get_control_msg, kc.shutdown(), min(wait, 2.0))
    except Fail:
        pass  # a missing connection file: the kill below still ends it
    try:
        proc.wait(timeout=wait)
        forced = False
    except psutil.TimeoutExpired:
        kill_tree(proc)
        forced = True
    return {"was_running": True, "forced": forced}


def describe(folder: str, state: dict[str, Any]) -> dict[str, Any]:
    return {
        "dir": folder,
        "connection_file": os.path.join(folder, CONNECTION),
        "pid": state["pid"],
        "python": state.get("kernel_python", state.get("python")),
        "python_version": state.get("python_version"),
        "cwd": state.get("cwd"),
        "started": state.get("started"),
    }


def python_for(value: str | None) -> str:
    if not value:
        return sys.executable
    found = value if os.path.isfile(value) else shutil.which(value)
    if not found:
        raise Fail(f"no Python at {value}")
    return os.path.abspath(found)


def cmd_start(args: argparse.Namespace) -> None:
    folder = work_dir(args.dir, create=True)
    cwd = os.path.abspath(args.cwd or os.getcwd())
    if not os.path.isdir(cwd):
        raise Fail(f"no folder {cwd} for --cwd")
    if inside(cwd, folder):
        raise Fail("--cwd can't be the kernel's own folder (--dir) or inside it")
    python = python_for(args.python)
    state = read_state(folder)
    if state is not None:
        if kernel_process(state) is not None:
            with client(folder) as kc:
                status = probe(kc, args.wait)
            if status == "not answering":
                raise Fail("a kernel is running here but isn't answering: restart it with kernel.py restart")
            emit({**describe(folder, state), "already_running": True, "state": status})
            return
        remove_kernel_files(folder, everything=False)
        NOTES["note"] = "an earlier kernel in this folder had stopped; this is a new one, with none of its variables"
    emit({**describe(folder, launch(folder, python, cwd, args.wait)), "state": "idle"})


def cmd_restart(args: argparse.Namespace) -> None:
    folder = work_dir(args.dir, create=False)
    state = read_state(folder) if os.path.isdir(folder) else None
    if state is None:
        raise Fail(f"no kernel to restart in {folder}: start one with kernel.py start")
    shut_down(folder, state, STOP_WAIT)
    remove_kernel_files(folder, everything=False)
    new = launch(folder, state.get("python") or sys.executable, state.get("cwd") or os.getcwd(), args.wait)
    emit({**describe(folder, new), "restarted": True, "state": "idle"})


def cmd_stop(args: argparse.Namespace) -> None:
    folder = work_dir(args.dir, create=False)
    result: dict[str, Any] = {"dir": folder}
    if not os.path.isdir(folder):
        emit({**result, "was_running": False})
        return
    try:
        state = read_state(folder)
    except Fail:
        state = None
        NOTES["note"] = f"{STATE} was damaged, so no process could be stopped; its files are removed"
    result.update(shut_down(folder, state, args.wait) if state else {"was_running": False})
    result["removed"] = remove_kernel_files(folder, everything=True)
    left = sorted(os.listdir(folder))
    if left:
        result["left_in_folder"] = left
    else:
        os.rmdir(folder)
        result["folder_removed"] = True
    emit(result)


def cmd_status(args: argparse.Namespace) -> None:
    folder = work_dir(args.dir, create=False)
    state = read_state(folder) if os.path.isdir(folder) else None
    if state is None:
        emit({"dir": folder, "running": False})
        return
    if kernel_process(state) is None:
        emit({"dir": folder, "running": False, "log_ends": log_tail(folder, state.get("log_ready", 0)),
              "note": "the kernel here has stopped and its variables are gone: start begins a new one, stop clears "
                      "its files"})
        return
    with client(folder) as kc:
        status = probe(kc, BUSY_WAIT)
    emit({**describe(folder, state), "running": True, "state": status})


# ---------------------------------------------------------------- run


def settle(text: str) -> str:
    """Text as a terminal leaves it: a carriage return (a progress bar redrawing itself) overwrites its line, and
    colour codes go."""
    text = ANSI.sub("", text).replace("\r\n", "\n")
    lines = []
    for line in text.split("\n"):
        parts = [p for p in line.split("\r") if p]
        lines.append(parts[-1] if parts else "")
    return "\n".join(lines)


def shorten(text: str, limit: int) -> str:
    limit = max(limit, 200)
    if len(text) <= limit + 200:  # cutting less would save little more than the note about it takes
        return text
    head = limit * 2 // 3
    tail = limit - head
    return f"{text[:head]}\n[... {len(text) - limit} characters cut; --max-chars shows more ...]\n{text[-tail:]}"


def fit(fields: list[tuple[dict[str, Any], str]], budget: int) -> bool:
    """Cut the longest texts, keeping each one's start and end, so all of them together fit in about budget
    characters. Short ones stay whole and leave their share to the long ones."""
    fields = sorted(fields, key=lambda f: len(f[0][f[1]]))
    cut = False
    for n, (holder, key) in enumerate(fields):
        share = budget // (len(fields) - n)
        text = holder[key]
        if len(text) > share:
            holder[key] = shorten(text, share)
            cut = True
            budget -= share
        else:
            budget -= len(text)
    return cut


def save_image(folder: str, payload: Any, mime: str, count: Any, taken: set[str]) -> str:
    images = os.path.join(folder, IMAGES)
    os.makedirs(images, exist_ok=True)
    if isinstance(payload, list):
        payload = "".join(payload)
    raw = payload.encode("utf-8") if mime == "image/svg+xml" else base64.b64decode(payload)
    path = free_path(images, f"cell{count if isinstance(count, int) else 0}{IMAGE_TYPES[mime]}", taken)
    write_atomic(path, lambda fh: fh.write(raw))
    return path


def output_of(content: dict[str, Any], kind: str, count: Any, folder: str, taken: set[str]) -> dict[str, Any]:
    data = content.get("data", {})
    item: dict[str, Any] = {"kind": "result" if kind == "execute_result" else "display"}
    for mime in IMAGE_TYPES:
        if mime in data:
            item["image"] = save_image(folder, data[mime], mime, count, taken)
            break
    text = data.get("text/plain")
    if isinstance(text, list):
        text = "".join(text)
    if text and not DEFAULT_REPR.fullmatch(text.strip()):
        item["text"] = ANSI.sub("", text)
    if "text" not in item and "image" not in item:
        # shown only as HTML, a widget or the like: nothing here reads as text
        item["formats"] = sorted(m for m in data if m != "text/plain")
    return item


def execute(kc: Any, code: str, timeout: float, state: dict[str, Any], proc: Any, folder: str) -> dict[str, Any]:
    started = time.monotonic()
    msg_id = kc.execute(code, store_history=True, allow_stdin=False, stop_on_error=True)
    streams: dict[str, list[str]] = {"stdout": [], "stderr": []}
    outputs: list[dict[str, Any]] = []
    taken: set[str] = set()
    error: dict[str, Any] | None = None
    count = None
    deadline = started + timeout
    interrupted = idle = died = clear_next = False
    unreachable = ""
    while not idle:
        now = time.monotonic()
        if now >= deadline:
            if interrupted:
                break  # it didn't stop when interrupted
            interrupted = True
            try:
                interrupt(state)
            except (Fail, OSError) as e:
                unreachable = f"{e}"
                break
            deadline = now + INTERRUPT_WAIT
            continue
        try:
            msg = kc.get_iopub_msg(timeout=min(1.0, deadline - now))
        except queue.Empty:
            if not alive(proc):
                died = True
                break
            continue
        if msg.get("parent_header", {}).get("msg_id") != msg_id:
            continue
        kind, content = msg["msg_type"], msg["content"]
        if clear_next and kind in ("stream", "execute_result", "display_data", "error"):
            streams, outputs, clear_next = {"stdout": [], "stderr": []}, [], False
        if kind == "status":
            idle = content.get("execution_state") == "idle"
        elif kind == "execute_input":
            count = content.get("execution_count")
        elif kind == "stream":
            streams.setdefault(content.get("name", "stdout"), []).append(content.get("text", ""))
        elif kind in ("execute_result", "display_data", "update_display_data"):
            outputs.append(output_of(content, kind, count, folder, taken))
        elif kind == "error":
            error = content
        elif kind == "clear_output":
            if content.get("wait"):
                clear_next = True
            else:
                streams, outputs = {"stdout": [], "stderr": []}, []
    reply = reply_for(kc.get_shell_msg, msg_id, 10.0) if idle else None
    replied = reply["content"] if reply else {}
    if error is None and replied.get("status") == "error":
        error = replied

    if died:
        status = "died"
    elif interrupted and replied.get("status") != "ok":
        status = "timeout"
    elif replied.get("status") == "aborted":
        status = "aborted"
    elif error is not None:
        status = "error"
    else:
        status = "ok"
    result: dict[str, Any] = {"status": status}
    if count or replied.get("execution_count"):
        result["execution_count"] = count or replied.get("execution_count")
    result["seconds"] = round(time.monotonic() - started, 2)
    for name, parts in streams.items():
        text = settle("".join(parts))
        if text.strip():
            result[name] = text
    if outputs:
        result["outputs"] = outputs
    if error is not None:
        traceback = error.get("traceback") or []
        result["error"] = {"ename": error.get("ename", ""), "evalue": ANSI.sub("", str(error.get("evalue", ""))),
                           "traceback": settle("\n".join(traceback))}
    if unreachable:
        result["note"] = (f"still running after {timeout:g} seconds (--timeout), and interrupting it failed "
                          f"({unreachable}): restart the kernel (its variables will be lost)")
    elif status == "timeout" and not idle:
        result["note"] = (f"interrupted after {timeout:g} seconds (--timeout) but still running: wait and check with "
                          "kernel.py status, interrupt it again, or restart (its variables will be lost)")
    elif status == "timeout":
        result["note"] = (f"interrupted after {timeout:g} seconds (--timeout); variables set before then are kept")
    elif status == "died":
        tail = log_tail(folder, state.get("log_ready", 0))
        result["note"] = ("the kernel stopped while running this, often from running out of memory, and its "
                          "variables are gone: start a new one with kernel.py start"
                          + (f" (its log ends: {tail})" if tail else ""))
    elif status == "aborted":
        result["note"] = "the kernel skipped this because code it was given before failed; run it again"
    return result


def cmd_run(args: argparse.Namespace) -> None:
    code = args.code if args.code is not None else read_text(args.code_file, "the code file")
    folder, state, proc = running_kernel(args.dir)
    with client(folder) as kc:
        ready(kc)
        result = execute(kc, code.replace("\r\n", "\n"), args.timeout, state, proc, folder)
    fields: list[tuple[dict[str, Any], str]] = [(result, k) for k in ("stdout", "stderr") if k in result]
    fields += [(item, "text") for item in result.get("outputs", []) if "text" in item]
    if "error" in result:
        fields.append((result["error"], "traceback"))
    if fit(fields, args.max_chars):
        result["cut"] = True
    emit(result)
    if result["status"] != "ok":
        raise SystemExit(1)


# ---------------------------------------------------------------- vars

# Runs inside the kernel, in a namespace of its own, so listing the variables adds none.
VARS_CODE = r'''
import json, reprlib, types
from IPython import get_ipython
shell = get_ipython()
ns, hidden, unset = shell.user_ns, shell.user_ns_hidden, object()
short = reprlib.Repr()
short.maxstring = short.maxother = 70
found, modules = [], []
for name in sorted(ns):
    value = ns[name]
    if name.startswith("_") or value is hidden.get(name, unset):
        continue
    if isinstance(value, types.ModuleType):
        modules.append(name)
        continue
    item = {"name": name, "type": type(value).__name__}
    if callable(value):
        found.append(item)
        continue
    try:
        shape = getattr(value, "shape", None)
        if isinstance(shape, tuple) and all(isinstance(n, int) for n in shape):
            item["shape"] = list(shape)
        elif isinstance(value, (str, bytes, list, tuple, dict, set, frozenset, range)):
            item["len"] = len(value)
        columns = getattr(value, "columns", None) if len(item.get("shape", ())) == 2 else None
        if columns is not None:
            columns = [str(c) for c in columns]
            dtypes = getattr(value, "dtypes", None)
            dtypes = [str(d) for d in dtypes] if dtypes is not None else []
            if len(dtypes) == len(columns):
                columns = [f"{c} ({d})" for c, d in zip(columns, dtypes)]
            item["columns"] = columns[:30] + ([f"... {len(columns) - 30} more"] if len(columns) > 30 else [])
        else:
            if getattr(value, "dtype", None) is not None:
                item["dtype"] = str(value.dtype)
            item["preview"] = " ".join(short.repr(value).split())
    except Exception as e:
        item["preview"] = f"(couldn't look at it: {type(e).__name__})"
    found.append(item)
result = json.dumps({"variables": found, "modules": modules}, default=str)
'''
VARS_EXPRESSION = f"(lambda g: (__import__('builtins').exec({VARS_CODE!r}, g), g['result'])[1])({{}})"


def cmd_vars(args: argparse.Namespace) -> None:
    folder, _state, _proc = running_kernel(args.dir)
    with client(folder) as kc:
        ready(kc)
        listing = json.loads(ask(kc, {"vars": VARS_EXPRESSION}, args.timeout)["vars"])
    variables = listing["variables"]
    result: dict[str, Any] = {"count": len(variables), "variables": variables[:MAX_VARS]}
    if len(variables) > MAX_VARS:
        result["not_listed"] = len(variables) - MAX_VARS
    if listing["modules"]:
        result["modules"] = listing["modules"]
    emit(result, indent=None)  # on one line: a long list stays short


def cmd_interrupt(args: argparse.Namespace) -> None:
    folder, state, _proc = running_kernel(args.dir)
    interrupt(state)
    with client(folder) as kc:
        idle = handshake(kc, args.wait)
    emit({"interrupted": True, "state": "idle" if idle else "busy"})


# ---------------------------------------------------------------- command line


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="kernel.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")
    where = argparse.ArgumentParser(add_help=False)
    where.add_argument("--dir", default=DEFAULT_DIR,
                       help=f"the kernel's work folder (default {DEFAULT_DIR}, in the current folder)")

    def add(name: str, func: Callable[[argparse.Namespace], None], help_text: str, example: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, parents=[where], help=help_text, description=help_text,
                            epilog=f"example:\n  {example}", formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        return sp

    sp = add("start", cmd_start, "Start a kernel in the background and wait until it answers. With one already "
             "running in --dir, say so and leave it be.", "python kernel.py start --cwd analysis")
    sp.add_argument("--python", help="the Python to run the kernel on, such as a project's .venv one; it needs "
                    "ipykernel (default: the Python running this script)")
    sp.add_argument("--cwd", help="the kernel's working folder, for relative paths in code (default: the current "
                    "folder)")
    sp.add_argument("--wait", type=positive, default=START_WAIT,
                    help=f"seconds to wait for the kernel to answer (default {START_WAIT:g})")

    sp = add("run", cmd_run, "Run code in the kernel and print what it printed, showed and raised, as JSON. "
             "Variables stay for the next run.", "python kernel.py run --code-file jupyter-work/step.py --timeout 300")
    code = sp.add_mutually_exclusive_group(required=True)
    code.add_argument("--code-file", help="a file holding the code (any encoding PowerShell writes)")
    code.add_argument("--code", help="the code itself, for one short line with no double quotes in it")
    sp.add_argument("--timeout", type=positive, default=RUN_TIMEOUT,
                    help=f"seconds before the code is interrupted (default {RUN_TIMEOUT:g}); give the shell "
                         "command longer than this")
    sp.add_argument("--max-chars", type=whole, default=MAX_CHARS,
                    help=f"about how many characters of text to print in all, cutting the middle of long "
                         f"outputs (default {MAX_CHARS})")

    sp = add("vars", cmd_vars, "List the kernel's variables: name, type, shape or length, columns, a short preview.",
             "python kernel.py vars")
    sp.add_argument("--timeout", type=positive, default=VARS_TIMEOUT,
                    help=f"seconds to wait for the list (default {VARS_TIMEOUT:g})")

    sp = add("interrupt", cmd_interrupt, "Stop the code the kernel is running, as Ctrl+C would; variables are kept.",
             "python kernel.py interrupt")
    sp.add_argument("--wait", type=positive, default=INTERRUPT_WAIT,
                    help=f"seconds to wait for it to be free again (default {INTERRUPT_WAIT:g})")

    sp = add("restart", cmd_restart, "Stop the kernel and start a fresh one on the same Python and folder: every "
             "variable is gone.", "python kernel.py restart")
    sp.add_argument("--wait", type=positive, default=START_WAIT,
                    help=f"seconds to wait for the new kernel to answer (default {START_WAIT:g})")

    sp = add("stop", cmd_stop, "Shut the kernel down (killing it if it hasn't stopped in --wait seconds) and remove "
             "its files.", "python kernel.py stop")
    sp.add_argument("--wait", type=positive, default=STOP_WAIT,
                    help=f"seconds to let it shut down before killing it (default {STOP_WAIT:g})")

    add("status", cmd_status, "Whether a kernel is running in --dir, and whether it is idle or busy.",
        "python kernel.py status")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, such as start")
    return run_job(f"kernel.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
