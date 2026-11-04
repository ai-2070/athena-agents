"""feeds.py against a stand-in server with answers shaped like the real ones: never a live site."""

from __future__ import annotations

import codecs
import json
import time
from pathlib import Path

import pytest

SKILL, SCRIPT = "rss-feeds", "feeds.py"


def feeds(run, *args, ok=True, env=None):
    result = run(SKILL, SCRIPT, *args, ok=ok, env=env)
    assert "Traceback" not in result.err
    return result


def failed(result, code=2):
    """A failure: the exit code, nothing on stdout, and one line on stderr."""
    assert result.code == code, result.err
    assert result.out == ""
    assert len(result.err.strip().splitlines()) == 1, result.err
    return result.err


# ---------------------------------------------------------------- reading the formats


def test_rss_entries_come_newest_first_with_their_discussion_link(run, site):
    url = site.serve("/newest", "hnrss.xml")
    data = feeds(run, "read", url).json()
    feed = data["feeds"][0]
    assert feed["format"] == "rss" and feed["title"] == 'Hacker News - Newest: "sqlite"'
    assert [e["date"] for e in feed["entries"]] == ["2026-11-03T17:58:18Z", "2026-11-03T03:40:05Z", "2026-11-01T09:15:00Z"]
    first = feed["entries"][0]
    # characters a cp1252 pipe can't take come through, because the script switches its output to UTF-8
    assert first["title"] == "Show HN: SQLite → WASM, ✓ fast" and first["author"] == "ана"
    assert first["link"] == "https://example.org/sqlite-wasm"
    assert first["comments"] == "https://news.ycombinator.com/item?id=50000003"
    assert first["text"].startswith("Article URL: https://example.org/sqlite-wasm") and first["text_chars"] > 50
    assert all(ua.startswith("AthenaAgents/") for ua in site.user_agents)


def test_atom_releases_read_with_their_links_and_authors(run, site):
    url = site.serve("/example/tool/releases.atom", "releases.atom")
    feed = feeds(run, "read", url, "--limit", "2").json()["feeds"][0]
    assert feed["format"] == "atom" and feed["site"] == "https://github.com/example/tool/releases"
    assert [e["title"] for e in feed["entries"]] == ["v2.1.0", "v2.0.1"]
    assert feed["entries"][1]["date"] == "2026-09-20T10:30:00Z"  # +02:00 turned into UTC
    assert feed["entries"][0]["author"] == "maintainer-one"
    assert feed["entries"][0]["text"].startswith("What's new\n")
    assert feed["left_out"] == {"over_limit": 1} and feed["entries_in_feed"] == 3


def test_json_feed_1_1(run, site):
    url = site.serve("/feed.json", "feed.json")
    feed = feeds(run, "read", url).json()["feeds"][0]
    newest, older = feed["entries"]
    assert feed["format"] == "json" and feed["title"] == "Notes from a JSON blog"
    assert newest["date"] == "2026-11-02T08:15:30Z" and newest["author"] == "Guest Writer, Site Owner"
    assert newest["outside_link"] == "https://elsewhere.example.com/story"
    assert newest["text"] == "Café notes & a link to the story."
    assert older["date"] == "2026-10-30T14:00:00Z" and older["author"] == "Site Owner"
    assert older["text"] == "Plain text body."


def test_rss_1_0_in_its_declared_encoding(run, site):
    url = site.serve("/index.rdf", "rdf.xml")
    feed = feeds(run, "read", url).json()["feeds"][0]
    assert feed["format"] == "rss1" and feed["title"] == "An old RSS 1.0 site"
    assert [e["title"] for e in feed["entries"]] == ["Second story", "Première story"]
    assert feed["entries"][0]["date"] == "2026-10-03T00:00:00Z"


def test_a_sloppy_feed_is_repaired_and_unreadable_dates_are_reported_per_entry(run, site):
    url = site.serve("/rss", "sloppy.xml")
    feed = feeds(run, "read", url, "--since", "2026-10-01").json()["feeds"][0]
    assert feed["title"] == "Tom & Jerry's Workshop"
    titles = [e["title"] for e in feed["entries"]]
    # the dated old post is left out; the two without a readable date stay, each saying why
    assert titles == ["Shelves & brackets", "A date nobody can read", "No date at all"]
    assert feed["entries"][0]["text"] == "Oak shelves — with brackets."
    assert feed["entries"][1]["date"] is None and "sometime last week" in feed["entries"][1]["date_problem"]
    assert feed["entries"][2]["date_problem"] == "the feed gives no date"
    assert feed["left_out"] == {"older": 1}
    assert any("repaired" in n for n in feed["notes"]) and any("--since" in n for n in feed["notes"])


def test_gzip_answers_are_unpacked(run, site):
    url = site.serve("/zipped", "hnrss.xml", gzip=True)
    assert len(feeds(run, "read", url).json()["feeds"][0]["entries"]) == 3


def test_chars_cuts_the_text_and_zero_leaves_it_out(run, site):
    url = site.serve("/r", "releases.atom")
    short = feeds(run, "read", url, "--chars", "5").json()["feeds"][0]["entries"][0]
    assert short["text"] == "What' …" and short["text_chars"] > 5
    none = feeds(run, "read", url, "--chars", "0").json()["feeds"][0]["entries"][0]
    assert "text" not in none and "text_chars" not in none


def test_since_takes_an_age(run, site):
    url = site.serve("/r", "releases.atom")
    data = feeds(run, "read", url, "--since", "36500d").json()
    assert len(data["feeds"][0]["entries"]) == 3 and data["since"].endswith("Z")


# ---------------------------------------------------------------- several feeds, lists and digests


def test_one_feed_failing_among_several_is_reported_and_the_rest_read(run, site):
    good = site.serve("/feed.json", "feed.json")
    result = feeds(run, "read", good, site.url + "/missing", ok=False)
    assert result.code == 1
    ok_feed, bad = result.json()["feeds"]
    assert len(ok_feed["entries"]) == 2
    assert bad["asked"] == site.url + "/missing" and "HTTP 404" in bad["error"] and "Not here" in bad["error"]


def test_every_feed_failing_is_one_line(run, site):
    err = failed(feeds(run, "read", site.url + "/a", site.url + "/b", ok=False))
    assert "none of the 2 feeds could be read" in err


@pytest.mark.parametrize("encoding", ["utf-16", "cp1252"])
def test_a_list_written_by_windows_powershell(run, site, tmp_path, encoding):
    """> in Windows PowerShell 5.1 writes UTF-16 with a byte-order mark; Set-Content writes the ANSI code page."""
    one, two = site.serve("/one", "hnrss.xml"), site.serve("/two", "feed.json")
    text = f"# feeds for the café digest\n{one}\n\n{two}  # the JSON one\n"
    (tmp_path / "list.txt").write_bytes(text.encode(encoding))
    data = feeds(run, "read", "--list", "list.txt", "--limit", "1").json()
    assert [f["url"] for f in data["feeds"]] == [one, two]
    if encoding == "cp1252":
        assert "isn't UTF-8" in data["encoding_notes"][0]


def test_a_list_exported_from_a_feed_reader(run, site, tmp_path):
    url = site.serve("/one", "hnrss.xml")
    opml = (f'<?xml version="1.0" encoding="UTF-8"?><opml version="2.0"><head><title>Subs</title></head><body>'
            f'<outline text="Tech"><outline type="rss" text="HN" xmlUrl="{url}" htmlUrl="https://news.ycombinator.com/"/>'
            f'</outline></body></opml>')
    (tmp_path / "subs.opml").write_text(opml, encoding="utf-8")
    assert feeds(run, "read", "--list", "subs.opml").json()["feeds"][0]["url"] == url


def test_state_shows_only_what_is_new_since_the_last_read(run, site, tmp_path):
    url = site.serve("/rss", "sloppy.xml")
    first = feeds(run, "read", url, "--state", "state.json", "--limit", "2").json()
    assert len(first["feeds"][0]["entries"]) == 2 and first["state"].endswith("state.json")
    # nothing new: even the entries the limit left out, and the undated ones, count as seen
    again = feeds(run, "read", url, "--state", "state.json").json()["feeds"][0]
    assert again["entries"] == [] and again["left_out"] == {"seen_before": 4}
    newer = answer_with_new_item()
    site.serve("/rss", body=newer)
    third = feeds(run, "read", url, "--state", "state.json").json()["feeds"][0]
    assert [e["title"] for e in third["entries"]] == ["Brand new"]
    saved = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert list(saved["feeds"]) == [url] and len(saved["feeds"][url]["seen"]) == 5
    assert not [p for p in tmp_path.iterdir() if p.name.endswith(".part")]


def answer_with_new_item() -> bytes:
    item = ("<item><title>Brand new</title><link>https://workshop.example.net/new</link>"
            "<pubDate>Wed, 04 Nov 2026 09:00:00 GMT</pubDate><guid>https://workshop.example.net/new</guid></item>")
    return (Path(__file__).parent / "answers" / "sloppy.xml").read_bytes().replace(b"<item>", item.encode() + b"<item>", 1)


def test_a_state_file_that_isnt_ours_is_left_alone(run, site, tmp_path):
    url = site.serve("/rss", "sloppy.xml")
    (tmp_path / "notes.json").write_text('["my", "notes"]', encoding="utf-8")
    err = failed(feeds(run, "read", url, "--state", "notes.json", ok=False))
    assert "isn't a state file" in err
    assert (tmp_path / "notes.json").read_text(encoding="utf-8") == '["my", "notes"]'
    (tmp_path / "folder").mkdir()
    assert "is a folder" in failed(feeds(run, "read", url, "--state", "folder", ok=False))
    assert site.requests == []  # checked before anything is fetched


def test_a_state_file_saved_as_utf16_is_read(run, site, tmp_path):
    url = site.serve("/rss", "sloppy.xml")
    feeds(run, "read", url, "--state", "s.json")
    raw = (tmp_path / "s.json").read_text(encoding="utf-8")
    (tmp_path / "s.json").write_bytes(codecs.BOM_UTF16_LE + raw.encode("utf-16-le"))
    assert feeds(run, "read", url, "--state", "s.json").json()["feeds"][0]["entries"] == []


# ---------------------------------------------------------------- finding feeds


def test_read_finds_the_feed_behind_a_page(run, site):
    page = site.serve("/", "blog.html")
    site.serve("/atom/everything/", "releases.atom")
    feed = feeds(run, "read", page).json()["feeds"][0]
    assert feed["discovered_from"] == page and feed["url"] == site.url + "/atom/everything/"
    assert len(feed["entries"]) == 3


def test_discover_checks_every_advertised_feed(run, site):
    page = site.serve("/", "blog.html")
    site.serve("/atom/everything/", "releases.atom")
    data = feeds(run, "discover", page).json()
    assert [(f["url"], f["found_by"], f["entries"]) for f in data["feeds"]] == [
        (site.url + "/atom/everything/", "link tag", 3)]
    assert data["checked"] == [{"url": site.url + "/comments/feed/", "found_by": "link tag",
                                "result": "HTTP 404 Not Found (Not here)"}]


def test_discover_finds_a_feed_linked_in_the_footer(run, site):
    page = site.serve("/news", "footer.html")
    site.serve("/press/releases.xml", "hnrss.xml")
    data = feeds(run, "discover", page).json()
    assert [(f["url"], f["found_by"]) for f in data["feeds"]] == [(site.url + "/press/releases.xml", "link on the page")]


def test_discover_tries_the_usual_addresses_and_stops_at_one_that_works(run, site):
    page = site.serve("/blog/post", "plain.html")
    site.serve("/rss.xml", "hnrss.xml")
    data = feeds(run, "discover", page).json()
    assert [(f["url"], f["found_by"]) for f in data["feeds"]] == [(site.url + "/rss.xml", "usual address")]
    assert site.url + "/blog/feed" in [c["url"] for c in data["checked"]]  # beside the page first
    assert site.url + "/atom.xml" not in site.requests and "/atom.xml" not in site.requests


def test_discover_never_reports_a_guess_it_didnt_check(run, site):
    page = site.serve("/", "plain.html")
    site.serve("/feed", "plain.html")  # a page, not a feed, as many sites answer for any address
    result = feeds(run, "discover", page, ok=False)
    assert result.code == 1
    data = result.json()
    assert data["feeds"] == [] and "sitemap" in data["next"]
    results = {c["url"].replace(site.url, ""): c["result"] for c in data["checked"]}
    assert results["/feed"] == "an HTML page" and results["/rss.xml"].startswith("HTTP 404")
    assert len(results) == 7


def test_discover_on_a_feed_reports_the_feed_itself(run, site):
    url = site.serve("/feed.json", "feed.json")
    assert feeds(run, "discover", url).json()["feeds"][0]["found_by"] == "the address itself"


def test_an_answer_that_is_neither_feed_nor_page_is_not_searched(run, site):
    url = site.serve("/api/items", body=b'{"items": [1, 2]}', ctype="application/json")
    assert "not a feed or a web page (application/json)" in failed(feeds(run, "read", url, ok=False))
    assert site.requests == ["/api/items"]


def test_read_on_a_page_with_no_feed(run, site):
    page = site.serve("/", "plain.html")
    assert "no feed found" in failed(feeds(run, "read", page, ok=False))


# ---------------------------------------------------------------- the network rules


def test_a_redirect_on_the_same_site_is_followed(run, site):
    site.serve("/new-home.xml", "hnrss.xml")
    url = site.redirect("/old.xml", "/new-home.xml")
    assert feeds(run, "read", url).json()["feeds"][0]["url"] == site.url + "/new-home.xml"


def test_a_redirect_loop_is_one_line(run, site):
    site.redirect("/a", "/b")
    url = site.redirect("/b", "/a")
    assert "redirects in a loop" in failed(feeds(run, "read", url, ok=False))


def test_a_redirect_to_another_site_is_not_followed(run, site, other_site):
    other_site.serve("/feed", "hnrss.xml")
    url = site.redirect("/feed", other_site.url + "/feed", status=302)
    err = failed(feeds(run, "read", url, ok=False))
    assert f"moves to another site, {other_site.url}/feed" in err
    assert other_site.requests == []


def test_a_429_is_waited_out_once(run, site):
    url = site.serve("/busy", "hnrss.xml", limited=1, reset="1")
    start = time.monotonic()
    data = feeds(run, "read", url).json()
    assert time.monotonic() - start >= 1.5 and data["waited_seconds"] == 2
    assert site.requests == ["/busy", "/busy"]


def test_a_second_429_stops_without_looping(run, site):
    url = site.serve("/busy", "hnrss.xml", limited=5, reset="1")
    assert "HTTP 429" in failed(feeds(run, "read", url, ok=False))
    assert site.requests == ["/busy", "/busy"]


def test_a_429_asking_for_too_long_is_not_waited(run, site):
    url = site.serve("/busy", "hnrss.xml", limited=1, reset="3600")
    err = failed(feeds(run, "read", url, ok=False))
    assert "3600 seconds" in err and site.requests == ["/busy"]


def test_a_slow_server_times_out(run, site):
    url = site.serve("/slow", "hnrss.xml", delay=3)
    assert "within 1 seconds" in failed(feeds(run, "read", url, "--timeout", "1", ok=False))


def test_nothing_listening(run, closed_url):
    assert "nothing answered" in failed(feeds(run, "read", closed_url + "/feed", ok=False))


@pytest.mark.parametrize("url", ["ftp://example.com/feed.xml", "file:///etc/passwd", "javascript:alert(1)"])
def test_only_web_addresses(run, url):
    assert "only http and https" in failed(feeds(run, "read", url, ok=False))


def test_a_feed_that_declares_entities_is_refused(run, site):
    bomb = (b'<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;">]>'
            b"<rss version=\"2.0\"><channel><title>&b;</title></channel></rss>")
    url = site.serve("/bomb", body=bomb)
    assert "declares its own XML entities" in failed(feeds(run, "read", url, ok=False))


@pytest.mark.parametrize("args", [
    ["read", "x", "--limit", "0"], ["read", "x", "--limit", "-3"], ["read", "x", "--limit", "many"],
    ["read", "x", "--chars", "-1"], ["read", "x", "--timeout", "0"], ["read", "x", "--timeout", "301"],
    ["read", "x", "--since", "0d"], ["read", "x", "--since", "last tuesday"], ["read", "x", "--since", "2026-13-45"],
    ["reddit", "sub", "x", "--sort", "best"], ["reddit", "sub", "x", "--limit", "101"], ["discover"], ["reddit"], [],
])
def test_bad_options_are_one_line(run, args):
    err = failed(feeds(run, *args, ok=False))
    assert "see --help" in err


def test_no_address_at_all(run):
    assert "at least one" in failed(feeds(run, "read", ok=False))


def test_help_runs_on_a_cp1252_pipe(run):
    for args in (["--help"], ["read", "--help"], ["reddit", "thread", "--help"]):
        out = feeds(run, *args).out
        assert "usage: feeds.py" in out


# ---------------------------------------------------------------- reddit


@pytest.fixture
def reddit(site):
    """The stand-in, answering at the addresses the reddit commands use."""
    site.env = {"FEEDS_PY_REDDIT": site.url}
    return site


def test_reddit_sub_keeps_the_body_and_the_outside_link(run, reddit):
    reddit.serve("/r/LocalLLaMA/top/.rss", "reddit-sub.atom", headers={"x-ratelimit-remaining": "0.0",
                                                                       "x-ratelimit-reset": "41"})
    data = feeds(run, "reddit", "sub", "r/LocalLLaMA", "--sort", "top", "--time", "month", env=reddit.env).json()
    assert reddit.requests == ["/r/LocalLLaMA/top/.rss?limit=25&t=month"]
    self_post, link_post = data["items"]
    assert self_post["kind"] == "post" and self_post["author"] == "quant_tinkerer"
    assert self_post["subreddit"] == "LocalLLaMA" and "outside_link" not in self_post
    assert self_post["text"] == ("Has anyone tried the new 4-bit quant on a 16 GB card? It fits, but loading takes "
                                 "ages ⏳.\n\nSecond paragraph with my notes.")
    assert "submitted by" not in link_post["text"] and link_post["text"] == ""
    assert link_post["outside_link"] == "https://news.example.com/2026/11/03/open-weights"
    assert "41 more seconds" in data["next_call_waits"]


def test_reddit_search_keeps_subreddits_apart(run, reddit):
    reddit.serve("/search.rss", "reddit-search.atom")
    data = feeds(run, "reddit", "search", "local llm", "--sort", "top", "--time", "week", env=reddit.env).json()
    assert reddit.requests == ["/search.rss?q=local+llm&sort=top&t=week&limit=25"]
    assert [i["title"] for i in data["items"]] == ["One year of local LLM"]
    assert data["subreddits_found"] == [{"name": "LocalLLM", "link": "https://www.reddit.com/r/LocalLLM/"}]


def test_reddit_search_in_one_subreddit(run, reddit):
    reddit.serve("/r/selfhosted/search.rss", "reddit-search.atom")
    feeds(run, "reddit", "search", "llm", "--sub", "selfhosted", env=reddit.env)
    assert reddit.requests == ["/r/selfhosted/search.rss?q=llm&sort=relevance&t=all&limit=25&restrict_sr=on"]


def test_reddit_thread_reads_the_post_and_its_comments(run, reddit):
    reddit.serve("/r/LocalLLaMA/comments/1abc002/.rss", "reddit-thread.atom")
    data = feeds(run, "reddit", "thread",
                 "https://old.reddit.com/r/LocalLLaMA/comments/1abc002/a_lab_releases_open_weights/?utm_source=share",
                 "--top-level", "--limit", "50", env=reddit.env).json()
    assert reddit.requests == ["/r/LocalLLaMA/comments/1abc002/.rss?limit=50&depth=1"]
    assert data["post"]["title"] == "A lab releases open weights"
    assert data["post"]["outside_link"] == "https://news.example.com/2026/11/03/open-weights"
    assert [c["author"] for c in data["comments"]] == ["AutoModerator", "skeptic_42", "runs_it_locally"]
    second = data["comments"][1]
    assert second["text"] == ("The benchmark numbers are their own; wait for independent runs.\n\nbeats every model "
                              "its size\n\nCitation needed — „quoted“ claims.")
    assert second["date"] == "2026-11-03T21:11:50Z" and "date_problem" not in second
    assert second["link"].endswith("/cmt0002/") and "scores" in data["about_comments"]


@pytest.mark.parametrize("address, path", [
    ("https://www.reddit.com/r/LocalLLaMA/comments/1abc002/a_lab/cmt0002/", "/r/LocalLLaMA/comments/1abc002/_/cmt0002/.rss"),
    ("reddit.com/r/LocalLLaMA/comments/1abc002", "/r/LocalLLaMA/comments/1abc002/.rss"),
    ("https://redd.it/1abc002", "/comments/1abc002/.rss"),
])
def test_reddit_thread_addresses(run, reddit, address, path):
    reddit.serve(path, "reddit-thread.atom")
    feeds(run, "reddit", "thread", address, env=reddit.env)
    assert reddit.requests == [path + "?limit=100"]


def test_reddit_user_comments(run, reddit):
    reddit.serve("/user/skeptic_42/comments/.rss", "reddit-user.atom")
    data = feeds(run, "reddit", "user", "u/skeptic_42", "--only", "comments", env=reddit.env).json()
    comment, post = data["items"]
    assert comment["kind"] == "comment" and comment["on"] == "A lab releases open weights" and "title" not in comment
    assert post["kind"] == "post" and post["title"] == "Which eval harness do you trust?"


def test_reddit_missing_subreddit(run, reddit):
    reddit.serve("/r/nosuchsub/.rss", "reddit-404.atom", status=404)
    err = failed(feeds(run, "reddit", "sub", "nosuchsub", env=reddit.env, ok=False))
    assert "HTTP 404" in err and "misspelt" in err


def test_reddit_limit_says_how_reddit_counts(run, reddit):
    reddit.serve("/r/LocalLLaMA/.rss", "reddit-sub.atom", limited=2, reset="1")
    err = failed(feeds(run, "reddit", "sub", "LocalLLaMA", env=reddit.env, ok=False))
    assert "HTTP 429" in err and "one anonymous request a minute" in err
    assert len(reddit.requests) == 2


@pytest.mark.parametrize("args", [
    ["sub", "Local/LLaMA"], ["sub", "../admin"], ["user", "a b"], ["thread", "https://www.reddit.com/r/x/s/AbCdEf"],
    ["thread", "https://example.com/r/x/comments/abc/"],
])
def test_reddit_bad_names_never_reach_the_network(run, reddit, args):
    failed(feeds(run, "reddit", *args, env=reddit.env, ok=False))
    assert reddit.requests == []


def test_read_cleans_a_reddit_feed_too(run, reddit):
    url = reddit.serve("/r/LocalLLaMA/new/.rss", "reddit-sub.atom")
    entry = feeds(run, "read", url, env=reddit.env).json()["feeds"][0]["entries"][1]
    assert entry["author"] == "news_bringer" and entry["subreddit"] == "LocalLLaMA"
    assert entry["outside_link"].startswith("https://news.example.com/") and "submitted by" not in entry["text"]

