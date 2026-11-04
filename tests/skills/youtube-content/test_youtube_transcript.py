"""youtube_transcript.py: links in every form, and list, get and pasted against a stand-in YouTube (conftest.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

SKILL = "youtube-content"
SCRIPT = "youtube_transcript.py"
VIDEO = "GJLlxj_dtq8"  # the video the saved answers in responses/ are for
RESPONSES = Path(__file__).parent / "responses"
EMPTY_CAPTIONS = """<?xml version="1.0" encoding="utf-8" ?><transcript></transcript>"""


def one_line_error(result) -> str:
    """A failure is exit 2 with one line on stderr, nothing on stdout, and no traceback."""
    assert result.code == 2, result.out
    assert result.out == ""
    assert "Traceback" not in result.err
    lines = result.err.strip().splitlines()
    assert len(lines) == 1, result.err
    return lines[0]


# ---------------------------------------------------------------- links


@pytest.mark.parametrize(
    ("link", "start"),
    [
        (f"https://www.youtube.com/watch?v={VIDEO}", None),
        (f"https://www.youtube.com/watch?feature=share&v={VIDEO}&list=PL123&index=2", None),
        (f"https://m.youtube.com/watch?v={VIDEO}&t=1m35s", 95),
        (f"https://music.youtube.com/watch?v={VIDEO}&si=abc", None),
        (f"www.youtube.com/watch?v={VIDEO}&t=95", 95),
        (f"youtube.com/watch?v={VIDEO}#t=1h2m3s", 3723),
        (f"https://youtu.be/{VIDEO}", None),
        (f"https://youtu.be/{VIDEO}?si=Xy12&t=42", 42),
        (f"https://www.youtube.com/shorts/{VIDEO}", None),
        (f"https://youtube.com/shorts/{VIDEO}?feature=share", None),
        (f"https://www.youtube.com/embed/{VIDEO}?start=30", 30),
        (f"https://www.youtube-nocookie.com/embed/{VIDEO}", None),
        (f"https://www.youtube.com/live/{VIDEO}?si=abc", None),
        (f"https://www.youtube.com/v/{VIDEO}", None),
        (f"HTTPS://WWW.YOUTUBE.COM/watch?v={VIDEO}", None),
        (f"  <https://youtu.be/{VIDEO}>  ", None),
        (VIDEO, None),
    ],
)
def test_id_reads_every_form_of_link(run, link, start):
    data = run(SKILL, SCRIPT, "id", link).json()
    assert data["video_id"] == VIDEO
    assert data["url"] == f"https://www.youtube.com/watch?v={VIDEO}"
    assert data.get("start_seconds") == start
    if start is not None:
        assert data["url_at_start"] == f"https://www.youtube.com/watch?v={VIDEO}&t={start}"


@pytest.mark.parametrize(
    ("link", "says"),
    [
        ("https://www.youtube.com/playlist?list=PL590L5WQmH8fJ54F369BLDSqIwcs-TCfs", "playlist"),
        ("https://www.youtube.com/@SomeChannel", "channel"),
        ("https://www.youtube.com/channel/UCVYamHliCI9rw1tHR1xbkfw", "channel"),
        (f"https://vimeo.com/{VIDEO}", "not a YouTube"),
        (f"https://www.youtube.com.example.org/watch?v={VIDEO}", "not a YouTube"),
        ("https://www.youtube.com/watch?v=short", "can't find a video id"),
        ("https://www.youtube.com/watch", "can't find a video id"),
        ("not a link at all", "not a YouTube"),
    ],
)
def test_id_refuses_what_isnt_one_video(run, link, says):
    line = one_line_error(run(SKILL, SCRIPT, "id", link, ok=False))
    assert says in line


def test_help_names_every_command(run):
    out = run(SKILL, SCRIPT, "--help").out
    for command in ("id", "list", "get", "pasted"):
        assert command in out
    for command in ("id", "list", "get", "pasted"):
        assert "example:" in run(SKILL, SCRIPT, command, "--help").out


def test_a_mistake_on_the_command_line_is_one_line(run):
    one_line_error(run(SKILL, SCRIPT, ok=False))
    one_line_error(run(SKILL, SCRIPT, "get", VIDEO, "--format", "srt", ok=False))


# ---------------------------------------------------------------- list


def test_list_names_each_transcript_and_the_translations(run, youtube):
    data = run(SKILL, SCRIPT, "list", f"https://youtu.be/{VIDEO}", env=youtube.env).json()
    assert data["video_id"] == VIDEO
    assert data["title"] == "Surface Go Review - It’s Awesome"
    assert data["channel"] == "Dave2D"
    assert data["length"] == "5:16"
    assert [(t["language_code"], t["kind"], t["translatable"]) for t in data["transcripts"]] == [
        ("en", "manual", True), ("de", "manual", True), ("es", "manual", True), ("en", "auto-generated", True),
    ]
    assert data["spoken_language"] == "en"
    assert len(data["translation_languages"]) == 18
    assert data["translation_languages"]["ar"] == "Arabic"


def test_requests_are_honest_have_a_timeout_and_stay_on_youtube(run, youtube):
    run(SKILL, SCRIPT, "list", VIDEO, "--timeout", "12.5", env=youtube.env)
    seen = youtube.requests()
    assert [r["method"] for r in seen] == ["GET", "POST"]
    assert {r["user_agent"] for r in seen} == {"AthenaAgents/1.0 (youtube_transcript)"}
    assert {r["timeout"] for r in seen} == {12.5}
    assert all(r["url"].startswith("https://www.youtube.com/") for r in seen)


@pytest.mark.parametrize("value", ["0", "-5", "nan", "inf", "soon"])
def test_timeout_must_be_a_positive_number(run, youtube, value):
    line = one_line_error(run(SKILL, SCRIPT, "list", VIDEO, "--timeout", value, env=youtube.env, ok=False))
    assert "--timeout" in line
    assert youtube.requests() == []


# ---------------------------------------------------------------- get


def test_get_takes_the_spoken_language_and_a_persons_transcript_first(run, youtube, tmp_path):
    data = run(SKILL, SCRIPT, "get", VIDEO, "-o", "work/talk.txt", env=youtube.env).json()
    assert data["language_code"] == "en"
    assert data["kind"] == "manual"
    assert "notes" not in data
    assert data["other_transcripts"] == ["de (manual)", "es (manual)", "en (auto-generated)"]
    assert data["segment_count"] == 4  # the caption with no text is left out
    assert data["ends_at"] == "1:02:07"
    assert data["format"] == "timed"
    assert Path(data["out"]) == (tmp_path / "work" / "talk.txt").resolve()
    text = (tmp_path / "work" / "talk.txt").read_text(encoding="utf-8")
    assert text.splitlines() == [
        "[0:00] Hi, I'm trying the new tablet",
        "[0:02] it's really light and quick",
        "[1:01] we flew from Łódź to Zürich — Привет",
        "[1:02:05] thanks for watching",
    ]
    assert data["lines"] == 4
    assert data["characters"] == sum(len(line.split("] ", 1)[1]) for line in text.splitlines())
    assert [p.name for p in (tmp_path / "work").iterdir()] == ["talk.txt"]  # no temporary file left


def test_get_prints_the_text_when_there_is_no_out_file(run, youtube):
    data = run(SKILL, SCRIPT, "get", VIDEO, "--format", "text", env=youtube.env).json()
    assert data["text"].splitlines()[2] == "we flew from Łódź to Zürich — Привет"
    assert "[0:00]" not in data["text"]


def test_get_json_has_segments_with_times_in_seconds(run, youtube, tmp_path):
    data = run(SKILL, SCRIPT, "get", VIDEO, "--format", "json", env=youtube.env).json()
    assert data["segments"][1] == {"start": 2.5, "duration": 3.1, "text": "it's really light and quick"}
    run(SKILL, SCRIPT, "get", VIDEO, "--format", "json", "-o", "t.json", env=youtube.env)
    saved = json.loads((tmp_path / "t.json").read_text(encoding="utf-8"))
    assert saved["video_id"] == VIDEO
    assert len(saved["segments"]) == 4


def test_get_follows_the_order_of_languages_asked_for(run, youtube):
    data = run(SKILL, SCRIPT, "get", VIDEO, "--language", "fr,de", env=youtube.env).json()
    assert data["language_code"] == "de"
    assert data["notes"] == ["no transcript in fr; took de (manual)"]
    assert data["text"].startswith("[0:00] Hallo")


def test_get_matches_a_regional_code_to_the_language(run, youtube):
    data = run(SKILL, SCRIPT, "get", VIDEO, "--language", "de-AT", env=youtube.env).json()
    assert data["language_code"] == "de"
    assert data["notes"] == ["took de (manual) for de-AT"]


def test_get_names_what_exists_when_the_language_isnt_there(run, youtube):
    line = one_line_error(run(SKILL, SCRIPT, "get", VIDEO, "--language", "fr", env=youtube.env, ok=False))
    assert "no transcript in fr" in line
    assert "en (manual), de (manual), es (manual), en (auto-generated)" in line
    assert "--translate fr" in line


def test_get_says_when_captions_are_auto_generated(run, youtube):
    youtube.standard("player_asr_only.json")
    data = run(SKILL, SCRIPT, "get", VIDEO, env=youtube.env).json()
    assert data["kind"] == "auto-generated"
    assert data["language_code"] == "en"
    assert any("made by a machine" in n for n in data["notes"])
    assert data["text"].startswith("[0:00] hi im trying")


def test_get_translates_with_youtubes_translation(run, youtube):
    data = run(SKILL, SCRIPT, "get", VIDEO, "--translate", "ar", env=youtube.env).json()
    assert data["kind"] == "machine-translated"
    assert data["translated_from"] == "en (manual)"
    assert data["language_code"] == "ar"
    assert "مرحبا" in data["text"]
    assert any("&tlang=ar" in r["url"] for r in youtube.requests())
    assert "en (manual)" not in data["other_transcripts"]


def test_translate_uses_the_videos_own_transcript_when_it_has_one(run, youtube):
    data = run(SKILL, SCRIPT, "get", VIDEO, "--translate", "de", env=youtube.env).json()
    assert data["kind"] == "manual"
    assert data["language_code"] == "de"
    assert "rather than a machine translation" in data["notes"][0]
    assert not any("tlang=" in r["url"] for r in youtube.requests())


def test_translate_refuses_a_language_youtube_cant(run, youtube):
    line = one_line_error(run(SKILL, SCRIPT, "get", VIDEO, "--translate", "xx", env=youtube.env, ok=False))
    assert "can't translate into xx" in line


def test_an_empty_transcript_is_exit_1_and_writes_nothing(run, youtube, tmp_path):
    youtube.answer("&lang=en", body=EMPTY_CAPTIONS)
    result = run(SKILL, SCRIPT, "get", VIDEO, "-o", "empty.txt", env=youtube.env, ok=False)
    assert result.code == 1
    data = result.json()
    assert data["problems"] == ["the transcript is empty: there is no text to read"]
    assert not (tmp_path / "empty.txt").exists()


def test_an_out_path_that_is_a_folder_stops_before_asking_youtube(run, youtube, tmp_path):
    (tmp_path / "notes").mkdir()
    line = one_line_error(run(SKILL, SCRIPT, "get", VIDEO, "-o", "notes", env=youtube.env, ok=False))
    assert "notes is a folder" in line
    assert youtube.requests() == []


def test_the_cookie_consent_page_is_passed_on_youtube(run, youtube):
    youtube.answer("consent.youtube.com/m", file=str(RESPONSES / "consent.html"))
    youtube.answer("www.youtube.com/watch?", times=1, status=302,
                   headers={"Location": "https://consent.youtube.com/m?continue=https%3A%2F%2Fwww.youtube.com%2F&gl=DE"})
    data = run(SKILL, SCRIPT, "get", VIDEO, env=youtube.env).json()
    assert data["language_code"] == "en"
    watches = [r for r in youtube.requests() if "www.youtube.com/watch?" in r["url"]]
    assert "CONSENT=YES+" in (watches[-1]["cookie"] or "")


# ---------------------------------------------------------------- when YouTube says no


def blocked(line: str) -> None:
    assert "YouTube is refusing requests from this computer" in line
    assert "Show transcript" in line
    for word in ("Webshare", "residential", "cookies"):
        assert word not in line  # the library's own advice is not passed on


def test_a_bot_check_is_reported_as_a_block_without_retrying(run, youtube):
    youtube.standard("player_bot_check.json")
    blocked(one_line_error(run(SKILL, SCRIPT, "get", VIDEO, env=youtube.env, ok=False)))
    assert [r["method"] for r in youtube.requests()] == ["GET", "POST"]


def test_a_captcha_page_is_a_block(run, youtube):
    youtube.answer("www.youtube.com/watch?", file=str(RESPONSES / "watch_captcha.html"))
    blocked(one_line_error(run(SKILL, SCRIPT, "list", VIDEO, env=youtube.env, ok=False)))
    assert len(youtube.requests()) == 1


def test_too_many_requests_is_a_block(run, youtube):
    youtube.answer("&lang=en", status=429, reason="Too Many Requests")
    blocked(one_line_error(run(SKILL, SCRIPT, "get", VIDEO, env=youtube.env, ok=False)))


def test_an_empty_caption_file_is_a_block(run, youtube):
    youtube.answer("&lang=en", body="")
    blocked(one_line_error(run(SKILL, SCRIPT, "get", VIDEO, env=youtube.env, ok=False)))


def test_a_redirect_to_googles_captcha_isnt_followed(run, youtube):
    youtube.answer("www.youtube.com/watch?", status=302,
                   headers={"Location": "https://www.google.com/sorry/index?continue=https://www.youtube.com/watch"})
    blocked(one_line_error(run(SKILL, SCRIPT, "list", VIDEO, env=youtube.env, ok=False)))
    assert not any("google.com" in r["url"] for r in youtube.requests())


def test_a_redirect_to_another_site_isnt_followed(run, youtube):
    youtube.answer("www.youtube.com/watch?", status=301, headers={"Location": "https://example.org/watch"})
    line = one_line_error(run(SKILL, SCRIPT, "list", VIDEO, env=youtube.env, ok=False))
    assert "example.org" in line
    assert not any("example.org" in r["url"] for r in youtube.requests())


@pytest.mark.parametrize(
    ("player", "says"),
    [
        ("player_no_captions.json", "has no captions: none were made, or its owner turned them off"),
        ("player_unavailable.json", "is unavailable: it was removed or made private, or the id is wrong"),
        ("player_age_restricted.json", "age-restricted"),
        ("player_unplayable.json", "won't play video GJLlxj_dtq8 here: Custom Reason; Sub Reason 1; Sub Reason 2"),
        ("player_po_token.json", "proof-of-origin token"),
    ],
)
def test_each_refusal_is_one_plain_line(run, youtube, player, says):
    youtube.standard(player)
    line = one_line_error(run(SKILL, SCRIPT, "get", VIDEO, env=youtube.env, ok=False))
    assert says in line
    assert "github.com" not in line


def test_a_server_error_is_one_line_without_the_address(run, youtube):
    youtube.answer("www.youtube.com/youtubei/v1/player", method="POST", status=500, reason="Internal Server Error",
                   body="<html>oops</html>")
    line = one_line_error(run(SKILL, SCRIPT, "list", VIDEO, env=youtube.env, ok=False))
    assert "YouTube answered with an error (500 Server Error: Internal Server Error)" in line
    assert "key=" not in line


def test_no_answer_in_time(run, youtube):
    youtube.answer("www.youtube.com/watch?", timeout=True)
    line = one_line_error(run(SKILL, SCRIPT, "list", VIDEO, "--timeout", "5", env=youtube.env, ok=False))
    assert "didn't answer within 5 seconds" in line


def test_no_connection(run, youtube):
    youtube.rules.clear()
    line = one_line_error(run(SKILL, SCRIPT, "list", VIDEO, env=youtube.env, ok=False))
    assert "couldn't reach YouTube" in line


def test_a_missing_library_names_the_install_command(run, hide):
    line = one_line_error(run(SKILL, SCRIPT, "get", VIDEO, env=hide("youtube_transcript_api"), ok=False))
    assert "python -m pip install youtube-transcript-api" in line
    assert run(SKILL, SCRIPT, "id", VIDEO, env=hide("youtube_transcript_api")).json()["video_id"] == VIDEO


# ---------------------------------------------------------------- pasted


PANEL_COPY = """Transcript
Search in video
0:00
Hi, I'm trying the new tablet
0:02
2 seconds
it's really light
and quick
1:01
we flew from Łódź to Zürich
1:02:05
thanks for watching
"""


def test_pasted_reads_a_utf16_copy_from_the_panel(run, tmp_path):
    copy = tmp_path / "copied.txt"
    copy.write_bytes(PANEL_COPY.encode("utf-16"))  # what Windows PowerShell 5.1's > writes
    data = run(SKILL, SCRIPT, "pasted", copy, "--video", f"https://youtu.be/{VIDEO}", "-o", "out/talk.txt").json()
    assert data["encoding"] == "utf-16"
    assert data["video_id"] == VIDEO
    assert data["lines_before_first_time"] == ["Transcript", "Search in video"]
    assert data["segment_count"] == 4
    assert data["ends_at"] == "1:02:05"
    assert (tmp_path / "out" / "talk.txt").read_text(encoding="utf-8").splitlines() == [
        "[0:00] Hi, I'm trying the new tablet",
        "[0:02] it's really light and quick",
        "[1:01] we flew from Łódź to Zürich",
        "[1:02:05] thanks for watching",
    ]


def test_pasted_reads_times_before_the_text_and_the_windows_code_page(run, tmp_path):
    copy = tmp_path / "copied.txt"
    copy.write_bytes("[0:00] café opening\n00:01:05 second part\n(2:10) third\n".encode("cp1252"))
    data = run(SKILL, SCRIPT, "pasted", copy, "--format", "json").json()
    assert data["encoding"] == "cp1252"
    assert data["encoding_notes"]
    assert [(s["start"], s["text"]) for s in data["segments"]] == [(0, "café opening"), (65, "second part"), (130, "third")]


def test_pasted_without_times_says_so(run, tmp_path):
    copy = tmp_path / "copied.txt"
    copy.write_text("just some words\nwith no times\n", encoding="utf-8")
    line = one_line_error(run(SKILL, SCRIPT, "pasted", copy, ok=False))
    assert "found no times" in line


def test_pasted_wont_write_over_its_input(run, tmp_path):
    copy = tmp_path / "copied.txt"
    copy.write_text(PANEL_COPY, encoding="utf-8")
    line = one_line_error(run(SKILL, SCRIPT, "pasted", copy, "-o", copy, ok=False))
    assert "won't write over the input" in line
    assert copy.read_text(encoding="utf-8") == PANEL_COPY
    run(SKILL, SCRIPT, "pasted", copy, "-o", copy, "--overwrite")
    assert copy.read_text(encoding="utf-8").startswith("[0:00] Hi, I'm trying")


def test_pasted_needs_the_file(run, tmp_path):
    line = one_line_error(run(SKILL, SCRIPT, "pasted", tmp_path / "missing.txt", ok=False))
    assert "no such file" in line
