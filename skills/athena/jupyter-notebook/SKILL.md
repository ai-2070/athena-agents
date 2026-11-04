---
name: Live Python kernel and notebooks
description: Use for Python work done a step at a time with the data kept in memory, such as "keep the data loaded and explore it", pandas exploration or an interactive Python session, and for Jupyter notebooks to run, check or edit ("run this notebook", "does my notebook still work").
---

A live kernel is a Python process that stays up between commands: a file that takes a minute to load is loaded once,
then grouped, filtered and charted as many times as the questions need. Good work uses it to explore and then hands over
something that doesn't depend on it: a script or notebook that runs from a fresh start, with the numbers in the answer
copied from that run. It ends with the kernel stopped and its work folder gone.

## Before you start

- **Packages.** The script needs `jupyter_client` and `psutil`, and the kernel needs `ipykernel`, which brings both;
  notebooks need `nbconvert`, which brings `nbformat`. Check with `python -c "import ipykernel, nbconvert"`. Installing
  is the user's call: ask first, then `python -m pip install ipykernel nbconvert`.
- **The script** is in this skill's folder (its path comes with the skill). Run it in a shell as
  `python <skill folder>/scripts/kernel.py <command>` (`py` instead of `python` on Windows if `python` isn't found);
  every command has `--help` and prints JSON. Exit code 0 means done; 1 that `run`'s code raised an error, timed out,
  was skipped or took the kernel down (its `status` says which); 2 that the command couldn't do its job, with the
  reason in one line on stderr.
- **The kernel runs on the Python you start it with**, or the one `--python` names, such as a project's
  `.venv\Scripts\python.exe` (`.venv/bin/python` on macOS and Linux), which then needs ipykernel itself; `start` prints
  which. Packages for the work go into that Python: after asking, run `%pip install <package>` in the kernel
  (`run --code "%pip install polars"`) and read its output, because the run stays `ok` when pip fails. "No module named
  pip" means an environment made by uv: run `uv pip install --python <that python> <package>` in the shell instead. A
  package that was already imported needs a `restart` before its new version loads.
- **No Jupyter server is needed.** If the user wants JupyterLab open, they start it themselves with its token on. Never
  start one with its token, password or XSRF check turned off: any program on the PC could then run code as the user.

## When a live kernel helps

When loading is slow (a large CSV or Parquet file, a database query, a model) and many questions follow; when exploring
a data frame a question at a time; when trying an unfamiliar library a piece at a time. Not for a one-off calculation,
or code that must run on its own later (a scheduled job, CI, another machine): write that as a file and run it with
`python`. The kernel remembers every try, wrong ones included, so its numbers are drafts until a fresh run repeats them.

## Working in the kernel

```
python <skill folder>/scripts/kernel.py start
python <skill folder>/scripts/kernel.py run --code-file jupyter-work/load.py --timeout 300
python <skill folder>/scripts/kernel.py run --code "df.dtypes"
python <skill folder>/scripts/kernel.py vars
python <skill folder>/scripts/kernel.py stop
```

- **`start`** starts the kernel in the background and waits up to `--wait` seconds (60) for it to answer. Its files go
  in `jupyter-work` in the current folder, and relative paths in your code start from the current folder. `--cwd` names
  another place for code to run; `--dir` another folder of the kernel's own, never the one you work in, and each is a
  separate kernel to stop. With a kernel already running there, it reports that one (`already_running`). A first
  start, and the first import of pandas or matplotlib, can be slow while Python fills its caches: if `start` or the
  first `run` times out, run it once more before digging.
- **`run`** takes code from a file you write into `jupyter-work` (`--code-file`, in any encoding PowerShell writes), or
  `--code` for one short line with no double quotes, which Windows PowerShell 5.1 strips. Its JSON has `status` (`ok`,
  `error`, `timeout`, `aborted`, `died`), `execution_count`, `seconds`, `stdout`, `stderr`, `outputs` and `error`,
  leaving out empty ones. Each output is a `result` (the last line's value) or a `display`, with its `text`, an `image`
  saved in `jupyter-work/images`, or the `formats` of one that only shows as HTML or a widget. Long text is cut in the
  middle to about `--max-chars` (10000) in all, and `cut` says so.
- **`--timeout`** (60 seconds) interrupts the code when it runs out; variables set before then stay. Give a long step a
  larger `--timeout` and the shell command longer still: a shell tool that stops the command (the dashboard's does after
  300 seconds unless raised) leaves the code running in the kernel, and the next `run` says it's busy. Then wait, or
  `interrupt` it.
- **`vars`** lists the variables with type, shape or length, columns and their types, and a short preview, with imported
  modules apart; it runs no cell and adds nothing. **`interrupt`** stops running code, as Ctrl+C would. **`restart`**
  gives a fresh kernel on the same Python and folder, with no variables. **`status`** says whether it's idle, busy, not
  answering or stopped. **`stop`** shuts it down (killing it if it hasn't stopped in `--wait` seconds, 5), removes its
  files and the pictures it saved, and the folder when nothing else is in it.

## How to do it well

- **Load once, then ask small questions**, one per run. Look at shapes, `head()` and `describe()` rather than whole
  frames; a frame on the last line comes back as a table pandas has already shortened.
- **Read errors from the bottom.** `ename` and `evalue` say what went wrong; in the traceback, `Cell In[n], line m` and
  its `---->` mark the line of your code, and frames under it are inside libraries. Fix that step and run it again:
  everything before it is still loaded. A `KeyError` on a frame is usually a column name, and `vars` lists them.
- **`died`** means the kernel ended during the run, most often out of memory, and everything in it is gone. Start
  again and load less: only the columns needed, smaller types, or the file in chunks.
- **Charts** from matplotlib come back at the end of the run as images in `jupyter-work/images`; open the file to look.
  A chart the user wants is saved with `fig.savefig(...)` where they asked, not left in the work folder.

## Notebooks

Running a notebook runs all of its code: read one from someone else first, and ask before running anything that deletes,
sends or installs. To run one top to bottom in a fresh kernel, the proof that it works:

```
jupyter nbconvert --to notebook --execute analysis.ipynb --output analysis-run --output-dir jupyter-work
```

(`python -m nbconvert` does the same when `jupyter` isn't on the PATH.) Cells run in the notebook's own folder, the copy
with outputs lands in `jupyter-work/analysis-run.ipynb`, and the user's notebook stays as it was. Exit code 1 means a
cell failed: the last lines of the error output name it and its error, and nothing is written. `--allow-errors` runs
every cell and exits 0 with each error kept in the copy, so read the outputs before saying it worked.
`--ExecutePreprocessor.timeout=600` limits each cell (there's no limit by default), and
`--ExecutePreprocessor.kernel_name=python3` stands in when the notebook names a kernel this PC doesn't have. Write
outputs into the user's notebook (`--inplace`) only when asked, after a backup.

To read outputs, or to change cells when your engine has no notebook editing of its own, use nbformat in a short script
in `jupyter-work`, backing up a notebook you change once, before the first change; then run it again with nbconvert.

```python
import nbformat
nb = nbformat.read("analysis.ipynb", as_version=4)
for i, cell in enumerate(nb.cells):                      # read: what each cell printed or raised
    for out in cell.get("outputs", []):
        print(i, out.get("ename") or out.get("text") or out.get("data", {}).get("text/plain"))
cell = nbformat.v4.new_code_cell("summary = df.groupby('region')['units'].sum()")
if nb.nbformat_minor < 5:
    del cell["id"]                                        # notebooks older than format 4.5 have no cell ids
nb.cells.insert(3, cell)                                  # change: insert, or set nb.cells[n].source
nbformat.validate(nb)
nbformat.write(nb, "analysis.ipynb")
```

## Done means

- The result comes from a fresh run: the notebook through nbconvert with exit code 0 and no errors in its outputs, or
  the final steps run again after `restart`. Figures in the reply are copied from that run.
- A notebook of the user's was changed only when asked, and its backup differs from the result.
- `kernel.py stop` has run, and `jupyter-work` is deleted with your code files once anything the user wants from it is
  saved where they asked.

## Watch out for

- `kernel.json` holds the key that lets a program run code as the user. It stays in the work folder, readable by the
  user alone: never paste, commit or copy it.

## Files

- `scripts/kernel.py`: start, run, vars, interrupt, restart, stop and status for a live kernel (`<command> --help`).
