"""sources.py: the sources list, the Sources block, citation and quotation checks, and coverage, on real files."""

from __future__ import annotations

import codecs
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

SKILL, TOOL = "grounded-citations", "sources.py"
SCRIPT = Path(__file__).resolve().parents[3] / "skills" / "athena" / SKILL / "scripts" / TOOL
COMMANDS = ["add", "list", "render", "check", "coverage"]

PAGE = """<!doctype html>
<html><head><title>Ice and lakes</title>
<script>var claim = "ice is about 20 percent less dense";</script>
<body><nav>Home | About</nav>
<p>Ice is about <em>9&nbsp;percent</em> less dense than liquid water,<sup>[3]</sup> which is why it floats.</p>
<p>Fresh water is densest at about 4&deg;C, so the coldest water rises in winter.</p>
</body></html>
"""

NOTES = """# Lake notes

Lake ice grows from the top down. The *Финский* survey found that **some shallow lakes**
freeze solid in [cold winters](https://example.org/winters "Cold winters"), while deep lakes rarely do.

Ice sheets are a well-known represen-
tation of long winters.
"""


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


@pytest.fixture
def work(tmp_path: Path) -> Path:
    """A research folder with two saved pages: an HTML page as a shell saves it, and Markdown-ish fetched text."""
    folder = tmp_path / "research-work"
    (folder / "pages").mkdir(parents=True)
    (folder / "pages" / "ice.html").write_text(PAGE, encoding="utf-8")
    (folder / "pages" / "lakes.txt").write_text(NOTES, encoding="utf-8")
    return folder


@pytest.fixture
def listed(run, work: Path) -> Path:
    """The two pages registered with add: [1] the ice page, [2] the lake notes, [3] a page with no saved text."""
    sources = work / "sources.txt"
    run(SKILL, TOOL, "add", "--sources", sources, "https://Water.example.gov/ice/?utm_source=feed#top",
        "--title", "Ice | Water Science", "--text-file", work / "pages" / "ice.html", "--accessed", "2026-11-02")
    run(SKILL, TOOL, "add", "--sources", sources, "https://example.org/lakes", "--title", "Lake notes",
        "--text-file", work / "pages" / "lakes.txt")
    run(SKILL, TOOL, "add", "--sources", sources, "https://news.example.com/story", "--title", "A news story")
    return sources


def write(path: Path, text: str, encoding: str = "utf-8") -> Path:
    path.write_bytes(text.encode(encoding))
    return path


# ---------------------------------------------------------------- the command line


@pytest.mark.parametrize("command", COMMANDS)
def test_every_command_has_help(run, command):
    r = run(SKILL, TOOL, command, "--help")
    assert "usage:" in r.out and "example:" in r.out and "--sources" in r.out


def test_help_states_the_list_format_and_exit_codes(run):
    out = run(SKILL, TOOL, "--help").out
    assert "[3] https://example.org/report | Title of the page | 2026-11-04 | pages/report.html" in out
    assert "0 done; 1 it ran and found problems" in out and "SOURCES_FILE" in out
    for command in COMMANDS:
        assert f"  {command}" in out


@pytest.mark.parametrize("args, says", [
    ([], "needs a command"),
    (["list"], "--sources"),
    (["add", "--sources", "s.txt", "https://example.org", "--accessed", "2026-02-30"], "isn't a real date"),
    (["add", "--sources", "s.txt", "https://example.org", "--accessed", "4/11/2026"], "like 2026-11-04"),
    (["add", "--sources", "s.txt", "https://example.org", "--accessed", "2999-01-01"], "in the future"),
    (["add", "--sources", "s.txt", "https://example.org", "--text-file", "missing.txt"], "no such file"),
    (["render", "--sources", "s.txt", "--ids", "0"], "from 1 up"),
    (["render", "--sources", "s.txt", "--ids", "3-1"], "low to high"),
    (["render", "--sources", "s.txt", "--ids", "a"], "like 1,3-5"),
    (["render", "--sources", "s.txt"], "a draft, or --ids"),
    (["check", "--sources", "s.txt", "draft.md"], "can't read the sources list"),
])
def test_mistakes_are_one_line_and_exit_2(run, args, says):
    r = run(SKILL, TOOL, *args, ok=False)
    assert r.code == 2 and one_line(r.err) and says in r.err, r.err
    assert r.out == ""


def test_a_folder_where_a_file_should_be_is_one_line(run, listed, tmp_path):
    (tmp_path / "folder.md").mkdir()
    r = run(SKILL, TOOL, "check", tmp_path / "folder.md", "--sources", listed, ok=False)
    assert r.code == 2 and one_line(r.err) and "folder.md" in r.err
    r = run(SKILL, TOOL, "list", "--sources", tmp_path, ok=False)
    assert r.code == 2 and one_line(r.err)


def test_a_pdf_is_refused_as_saved_text(run, tmp_path):
    pdf = write(tmp_path / "paper.pdf", "%PDF-1.7\n%binary\n", "latin-1")
    r = run(SKILL, TOOL, "add", "--sources", tmp_path / "s.txt", "https://example.org/p", "--text-file", pdf, ok=False)
    assert r.code == 2 and one_line(r.err) and "save its text as a .txt file" in r.err
    assert not (tmp_path / "s.txt").exists()


def test_the_list_path_can_come_from_the_environment(run, tmp_path):
    env = {"SOURCES_FILE": str(tmp_path / "shared.txt")}
    assert run(SKILL, TOOL, "add", "https://example.org/a", env=env).json()["id"] == 1
    assert run(SKILL, TOOL, "list", env=env).json()["count"] == 1


# ---------------------------------------------------------------- the sources list


def test_add_hands_out_ids_in_order_and_writes_a_readable_list(run, listed, work):
    lines = listed.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("# Sources list:")
    assert lines[1] == "[1] https://water.example.gov/ice/ | Ice | Water Science | 2026-11-02 | pages/ice.html"
    assert lines[2].startswith("[2] https://example.org/lakes | Lake notes | ") and lines[2].endswith(" | pages/lakes.txt")
    assert lines[3].startswith("[3] https://news.example.com/story | A news story | ")
    sources = run(SKILL, TOOL, "list", "--sources", listed).json()["sources"]
    assert [s["id"] for s in sources] == [1, 2, 3]
    assert sources[0]["title"] == "Ice | Water Science" and sources[0]["text_found"] is True
    assert "text" not in sources[2]


@pytest.mark.parametrize("variant", [
    "https://water.example.gov/ice",
    "https://WATER.example.gov/ice/",
    "https://water.example.gov:443/ice/#section-2",
    "https://water.example.gov/ice/?fbclid=abc&utm_medium=social",
])
def test_the_same_page_keeps_its_id(run, listed, variant):
    r = run(SKILL, TOOL, "add", "--sources", listed, variant).json()
    assert r["id"] == 1 and r["new"] is False


@pytest.mark.parametrize("other", [
    "https://water.example.gov/ice/?lang=fr",
    "https://water.example.gov/ice/more",
    "https://water.example.gov/#!/ice",
    "http://water.example.gov:8080/ice/",
])
def test_a_different_page_gets_a_new_id(run, listed, other):
    assert run(SKILL, TOOL, "add", "--sources", listed, other).json()["id"] == 4


def test_a_second_add_fills_in_what_was_missing(run, listed, work):
    r = run(SKILL, TOOL, "add", "--sources", listed, "https://news.example.com/story",
            "--text-file", work / "pages" / "lakes.txt").json()
    assert r["id"] == 3 and r["updated"] == ["text"]
    r = run(SKILL, TOOL, "add", "--sources", listed, "https://example.org/lakes",
            "--text-file", work / "pages" / "ice.html").json()
    assert r["updated"] == [] and "kept the text saved earlier" in r["note"]


def test_a_location_that_is_not_a_web_address_is_kept_as_written(run, tmp_path):
    sources = tmp_path / "s.txt"
    r = run(SKILL, TOOL, "add", "--sources", sources, "Q3 sales report.xlsx, sheet Summary", "--title", "Q3 sales").json()
    assert r["line"].startswith("[1] Q3 sales report.xlsx, sheet Summary | Q3 sales | ")
    assert run(SKILL, TOOL, "add", "--sources", sources, "q3 sales report.xlsx,  sheet summary").json()["id"] == 1


def _add_at_once(tmp_path: Path, urls: list[str], sources: Path) -> list[subprocess.CompletedProcess]:
    env = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0", "PYTHONDONTWRITEBYTECODE": "1"}
    procs = [subprocess.Popen([sys.executable, str(SCRIPT), "add", "--sources", str(sources), url], cwd=tmp_path,
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for url in urls]
    done = []
    for p in procs:
        out, err = p.communicate(timeout=120)
        done.append(subprocess.CompletedProcess(p.args, p.returncode, out, err))
    return done


def test_helpers_adding_at_the_same_time_get_distinct_ids(run, tmp_path):
    sources = tmp_path / "shared" / "sources.txt"
    urls = [f"https://example.org/page-{i}" for i in range(12)] + ["https://example.org/same"] * 4
    results = _add_at_once(tmp_path, urls, sources)
    assert all(r.returncode == 0 for r in results), [r.stderr for r in results]
    listing = run(SKILL, TOOL, "list", "--sources", sources).json()
    assert listing["problems"] == []
    assert sorted(s["id"] for s in listing["sources"]) == list(range(1, 14))
    assert sorted(s["location"] for s in listing["sources"]) == sorted(set(urls))
    assert not (tmp_path / "shared" / "sources.txt.lock").exists()


def test_a_lock_left_by_a_run_that_died_is_taken_over(run, tmp_path):
    sources = tmp_path / "sources.txt"
    lock = tmp_path / "sources.txt.lock"
    lock.write_text("12345", encoding="utf-8")
    old = time.time() - 120
    os.utime(lock, (old, old))
    assert run(SKILL, TOOL, "add", "--sources", sources, "https://example.org/a").json()["id"] == 1
    assert not lock.exists()


def test_a_hand_written_list_in_utf16_with_crlf_is_read(run, tmp_path):
    text = ("# written with file tools\r\n"
            "[1] https://example.org/a | Prices | Acme | 2026-11-01\r\n"
            "\r\n"
            "- [2] https://example.org/b | Отчёт | 2026-11-02 | pages/b.txt\r\n"
            "[3] Interview with the shop owner, 3 November 2026 | | 2026-11-03\r\n")
    sources = write(tmp_path / "sources.txt", "﻿" + text, "utf-16-le")
    (tmp_path / "pages").mkdir()
    write(tmp_path / "pages" / "b.txt", "text")
    r = run(SKILL, TOOL, "list", "--sources", sources).json()
    assert r["problems"] == []
    assert [(s["id"], s["title"]) for s in r["sources"]] == [(1, "Prices | Acme"), (2, "Отчёт"), (3, "")]
    assert r["sources"][2]["location"] == "Interview with the shop owner, 3 November 2026"
    # adding keeps the Windows line ends
    run(SKILL, TOOL, "add", "--sources", sources, "https://example.org/c")
    raw = sources.read_bytes()
    assert raw.count(b"\r\n") == 6 and b"[4] https://example.org/c" in raw


def test_an_ansi_list_is_read_and_says_so(run, tmp_path):
    sources = write(tmp_path / "sources.txt", "[1] https://example.org/a | Café prices | 2026-11-01\n", "cp1252")
    r = run(SKILL, TOOL, "list", "--sources", sources).json()
    assert r["sources"][0]["title"] == "Café prices"
    assert "isn't UTF-8" in r["encoding_notes"][0]


def test_list_reports_every_problem_in_the_list(run, tmp_path):
    sources = write(tmp_path / "sources.txt", "\n".join([
        "[1] https://example.org/a | A | 2026-11-01",
        "[1] https://example.org/b | B | 2026-11-01",
        "[2] https://example.org/a/ | A again | 2026-11-01",
        "[3] https://example.org/c | C | 2026-13-01",
        "[4] https://example.org/d | D | 2026-11-01 | pages/missing.txt",
        "[5] https://example.org/e | E | pages/e.txt",
        "https://example.org/f | no id",
    ]) + "\n")
    r = run(SKILL, TOOL, "list", "--sources", sources, ok=False)
    assert r.code == 1
    messages = " / ".join(p["message"] for p in r.json()["problems"])
    for says in ("used twice", "are the same source", "isn't a real date", "isn't there", "date read before",
                 "not a source line"):
        assert says in messages, messages


# ---------------------------------------------------------------- render


DRAFT = """# Why ice floats

Ice is "about 9 percent less dense than liquid water".[1] Lake ice grows from the top down.[2]

- Deep lakes rarely freeze solid.[2]
"""


def test_render_adds_the_block_and_running_it_again_changes_nothing(run, listed, work):
    draft = write(work / "report.md", DRAFT)
    r = run(SKILL, TOOL, "render", draft, "--sources", listed, "--in-place").json()
    assert r["changed"] is True and r["ids"] == [1, 2] and r["heading"] == "## Sources"
    first = draft.read_bytes()
    text = first.decode("utf-8")
    assert text.startswith(DRAFT.rstrip("\n") + "\n\n## Sources\n\n")
    assert "- [1] Ice | Water Science — <https://water.example.gov/ice/> (accessed 2026-11-02)" in text
    assert "- [2] Lake notes — <https://example.org/lakes>" in text
    assert "[3]" not in text.split("## Sources")[1]
    r = run(SKILL, TOOL, "render", draft, "--sources", listed, "--in-place").json()
    assert r["changed"] is False and draft.read_bytes() == first


def test_render_replaces_an_old_block_and_keeps_its_heading_and_what_follows(run, listed, work):
    draft = write(work / "report.md", DRAFT.replace("[2]", "[3]") + "\n### References\n\n- [9] https://made.up/url\n"
                  "- [1] https://typed.by/hand\n\n*Written for the lake club.*\n")
    run(SKILL, TOOL, "render", draft, "--sources", listed, "--in-place")
    text = draft.read_text(encoding="utf-8")
    assert "made.up" not in text and "typed.by" not in text and text.count("References") == 1
    after = text.split("### References\n\n")[1]
    assert after.startswith("- [1] Ice | Water Science")
    assert "- [3] A news story — <https://news.example.com/story>" in after
    assert text.endswith("\n\n*Written for the lake club.*\n")


def test_render_keeps_windows_line_ends(run, listed, work):
    draft = write(work / "report.md", DRAFT.replace("\n", "\r\n"))
    run(SKILL, TOOL, "render", draft, "--sources", listed, "--in-place")
    raw = draft.read_bytes()
    assert b"\r\n## Sources\r\n\r\n- [1]" in raw and raw.count(b"\n") == raw.count(b"\r\n")


def test_render_reads_a_utf16_draft(run, listed, work):
    draft = write(work / "report.md", "﻿" + DRAFT, "utf-16-le")
    r = run(SKILL, TOOL, "render", draft, "--sources", listed, "--out", work / "report-out.md").json()
    assert r["ids"] == [1, 2]
    assert "## Sources" in (work / "report-out.md").read_text(encoding="utf-8")
    assert draft.read_bytes().startswith(codecs.BOM_UTF16_LE)  # the input is left alone


def test_render_prints_the_block_for_chat_and_slides(run, listed):
    out = run(SKILL, TOOL, "render", "--sources", listed, "--ids", "2,1", "--style", "lines").out
    assert out.splitlines() == ["Sources", "",
                                "[1] Ice | Water Science — https://water.example.gov/ice/ (accessed 2026-11-02)",
                                out.splitlines()[3]]
    assert out.splitlines()[3].startswith("[2] Lake notes — https://example.org/lakes (accessed ")


def test_render_writes_nothing_while_the_draft_cites_an_unknown_id(run, listed, work):
    draft = write(work / "report.md", DRAFT + "\nA made-up claim.[7]\n")
    before = draft.read_bytes()
    r = run(SKILL, TOOL, "render", draft, "--sources", listed, "--in-place", ok=False)
    assert r.code == 1 and r.json()["problems"][0]["kind"] == "unknown_id" and r.json()["problems"][0]["id"] == 7
    assert draft.read_bytes() == before


def test_render_wont_write_over_the_draft_without_in_place(run, listed, work):
    draft = write(work / "report.md", DRAFT)
    r = run(SKILL, TOOL, "render", draft, "--sources", listed, "--out", draft, ok=False)
    assert r.code == 2 and "--in-place" in r.err and draft.read_text(encoding="utf-8") == DRAFT


def test_render_with_nothing_cited_is_a_problem(run, listed, work):
    draft = write(work / "report.md", "No sources here.\n")
    r = run(SKILL, TOOL, "render", draft, "--sources", listed, "--in-place", ok=False)
    assert r.code == 1 and r.json()["problems"][0]["kind"] == "no_citations"


# ---------------------------------------------------------------- check


def rendered(run, listed: Path, path: Path, text: str) -> Path:
    write(path, text)
    run(SKILL, TOOL, "render", path, "--sources", listed, "--in-place")
    return path


def test_a_clean_draft_passes(run, listed, work):
    draft = rendered(run, listed, work / "report.md", DRAFT)
    r = run(SKILL, TOOL, "check", draft, "--sources", listed).json()
    assert r["ok"] is True and r["problems"] == [] and r["cited"] == [1, 2] and r["not_cited"] == [3]
    assert r["quotations"]["found"] == 1


def test_check_finds_unknown_ids_bad_markers_and_a_hand_edited_block(run, listed, work):
    draft = rendered(run, listed, work / "report.md", DRAFT)
    text = draft.read_text(encoding="utf-8").replace("<https://example.org/lakes>", "<https://example.org/lake-notes>")
    text = text.replace("## Sources", "Two at once.[1, 2] A guess.[8]\n\n```\nlist[5] = 1\n```\n\n## Sources")
    draft.write_text(text, encoding="utf-8")
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False)
    assert r.code == 1
    kinds = {(p["kind"], p.get("id")) for p in r.json()["problems"]}
    assert ("unknown_id", 8) in kinds and ("marker", None) in kinds and ("block", 2) in kinds
    assert ("unknown_id", 5) not in kinds  # code isn't prose


def test_check_wants_a_sources_block_and_the_cited_ids_in_it(run, listed, work):
    draft = write(work / "report.md", DRAFT)
    problems = run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False).json()["problems"]
    assert problems[0]["kind"] == "no_sources_block"
    draft = rendered(run, listed, work / "report.md", DRAFT)
    draft.write_text(draft.read_text(encoding="utf-8").replace("Lake ice grows", "Lake ice [3] grows"), encoding="utf-8")
    problems = run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False).json()["problems"]
    assert [(p["kind"], p["id"]) for p in problems] == [("block", 3)] and "run render" in problems[0]["message"]


@pytest.mark.parametrize("sentence", [
    'Ice is "about 9 percent less dense than liquid water, which is why it floats."[1]',
    'The page says “ice is about 9 percent less dense”.[1]',
    "Fresh water is « densest at about 4°C » in winter.[1]",
    'They found "some shallow lakes freeze solid in cold winters".[2]',
    'They found that "deep lakes rarely do".[2]',
    'The notes begin: „Lake ice grows from the top down“.[2]',
    'One line reads "The Финский survey found that some shallow lakes".[2]',
    'Ice sheets are "a well-known representation of long winters".[2]',
    'Ice is "about 9 percent less dense ... which is why it floats".[1]',
    'Ice is "about 9 percent less dense than [fresh] liquid water".[1]',
    'According to [1], "the coldest water rises in winter".',
    '"Lake ice grows from the top down", the notes say.[2]',
])
def test_quotations_match_the_saved_text_across_markdown_and_html(run, listed, work, sentence):
    draft = rendered(run, listed, work / "report.md", f"# Check\n\n{sentence}\n")
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False).json()
    assert r["problems"] == [] and r["quotations"]["found"] == 1, r


def test_a_blockquote_is_checked_with_the_citation_under_it(run, listed, work):
    draft = rendered(run, listed, work / "report.md",
                     "# Check\n\n> Ice is about 9 percent less dense than liquid water,\n> which is why it floats.\n"
                     "— Water Science[1]\n\n> [!NOTE]\n> A note box isn't a quotation.\n")
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, "--evidence", ok=False).json()
    assert r["quotations"]["found"] == 1 and r["quotations"]["uncited"] == 0


def test_quotations_in_a_fact_check_table_are_checked(run, listed, work):
    draft = rendered(run, listed, work / "report.md",
                     "| Claim | Verdict | What the source says |\n|---|---|---|\n"
                     '| Ice floats | Supported | "less dense than liquid water"[1] |\n'
                     '| Lakes freeze solid | Not supported | "deep lakes rarely freeze solid"[2] |\n')
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False).json()
    assert r["quotations"]["found"] == 1 and r["quotations"]["not_found"] == 1
    assert [p["line"] for p in r["problems"] if p["kind"] == "quote_not_found"] == [4]


def test_a_misquoted_figure_is_caught_and_shown(run, listed, work):
    draft = rendered(run, listed, work / "report.md",
                     'Ice is "about 20 percent less dense than liquid water".[1] Lakes "freeze solid every winter".[2]\n')
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False)
    assert r.code == 1
    misses = [p for p in r.json()["problems"] if p["kind"] == "quote_not_found"]
    assert [p["id"] for p in misses] == [1, 2]
    assert '"ice is about 9 percent less dense" where the quotation has "about 20 percent less dense"' in \
        misses[0]["message"]
    assert '"freeze solid in cold winters, while' in misses[1]["message"]
    assert misses[0]["line"] == 1


def test_a_word_inside_another_word_is_not_a_match(run, listed, work):
    draft = rendered(run, listed, work / "report.md", 'The notes say "ce sheets are a well-known".[2]\n')
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False)
    assert r.code == 1 and r.json()["quotations"]["not_found"] == 1


def test_scripts_and_menus_of_a_saved_page_are_not_its_text(run, listed, work):
    draft = rendered(run, listed, work / "report.md", 'It says "ice is about 20 percent less dense".[1]\n')
    assert run(SKILL, TOOL, "check", draft, "--sources", listed, ok=False).json()["quotations"]["not_found"] == 1


def test_short_quoted_terms_and_link_titles_are_not_quotations(run, listed, work):
    draft = rendered(run, listed, work / "report.md",
                     'So-called "black ice" is thin.[1] See [the notes](https://example.org/lakes "Lake notes page").[2]\n')
    r = run(SKILL, TOOL, "check", draft, "--sources", listed).json()
    assert r["quotations"] == {"found": 0, "not_found": 0, "unchecked": 0, "uncited": 0}


def test_without_evidence_mode_unsourced_quotations_are_notes(run, listed, work):
    draft = rendered(run, listed, work / "report.md",
                     'Someone said "ice is very nice indeed". A story says "the lake froze overnight".[3] '
                     'Ice floats.[1]\n')
    r = run(SKILL, TOOL, "check", draft, "--sources", listed).json()
    assert r["ok"] is True
    assert {n["kind"] for n in r["notes"]} == {"uncited_quote", "unchecked_quote"}


def test_evidence_mode_wants_saved_texts_and_checked_quotations(run, listed, work):
    draft = rendered(run, listed, work / "report.md",
                     'Someone said "ice is very nice indeed". A story says "the lake froze overnight".[3] '
                     'Ice floats.[1] Lake ice grows from the top down.[2]\n')
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, "--evidence", ok=False)
    assert r.code == 1
    kinds = sorted((p["kind"], p.get("id")) for p in r.json()["problems"])
    assert kinds == [("no_quote", 1), ("no_quote", 2), ("no_saved_text", 3), ("unchecked_quote", None),
                     ("uncited_quote", None)]


def test_unverified_claims_are_counted_but_a_quotation_needs_a_source(run, listed, work):
    draft = rendered(run, listed, work / "report.md",
                     'Ice floats.[1] The lake club was founded in 1921.[unverified] '
                     'It was "the coldest winter on record".[unverified]\n')
    r = run(SKILL, TOOL, "check", draft, "--sources", listed).json()
    assert r["ok"] is True and r["unverified_claims"] == 2 and r["quotations"]["uncited"] == 1
    assert "[unverified] can't stand in" in r["notes"][0]["message"]
    r = run(SKILL, TOOL, "check", draft, "--sources", listed, "--evidence", ok=False).json()
    assert ("uncited_quote", 1) in {(p["kind"], p.get("line")) for p in r["problems"]}


def test_crowded_sentences_are_noted(run, listed, work):
    write(listed, listed.read_text(encoding="utf-8") + "[4] https://example.org/d | D | 2026-11-01\n")
    draft = rendered(run, listed, work / "report.md", "Everything about ice is known.[1][2][3][4] Ice floats.[1]\n")
    notes = run(SKILL, TOOL, "check", draft, "--sources", listed).json()["notes"]
    assert [n["kind"] for n in notes] == ["crowded"]


# ---------------------------------------------------------------- coverage


COVERED = """---
title: Lakes
---

# Lakes

Lake ice grows from the top down.[2] Deep lakes rarely freeze solid [2]. Shallow lakes can freeze all
the way to the bottom in a hard winter. The club was founded in 1921.[unverified]

Setext heading here
-------------------

- Fresh water is densest at about 4°C.[1]
- e.g. this item has no source at all

> Ice is about 9 percent less dense than liquid water.
— Water Science[1]

| Claim | Source |
|---|---|
| Ice floats on water | [1] |

```
Code is not prose, and this line is long enough.
```

<!-- A comment is not prose either, even a long one. -->

Everything is cited here.[1][2][3][4]
"""


def test_coverage_counts_sentences_and_lists_the_uncited(run, listed, work):
    draft = write(work / "lakes.md", COVERED)
    r = run(SKILL, TOOL, "coverage", draft, "--sources", listed).json()
    assert (r["sentences"], r["cited"], r["unverified"], r["neither"]) == (8, 5, 1, 2)
    assert [u["line"] for u in r["uncovered"]] == [7, 14]
    assert r["uncovered"][0]["text"].startswith("Shallow lakes can freeze all the way")
    assert r["cited_share"] == 0.62 and r["declared_share"] == 0.75
    assert r["citations_per_source"] == {"1": 4, "2": 3, "3": 1, "4": 1}
    assert r["never_cited"] == []
    assert r["crowded"] == [{"line": 29, "ids": [1, 2, 3, 4]}]


def test_coverage_needs_no_list_and_always_exits_0(run, work):
    draft = write(work / "plain.md", "Nothing here is cited at all. Not a single sentence of it.\n")
    r = run(SKILL, TOOL, "coverage", draft).json()
    assert (r["sentences"], r["neither"], r["cited_share"]) == (2, 2, 0.0) and "never_cited" not in r
