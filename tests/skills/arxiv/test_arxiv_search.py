"""arxiv_search.py against a stand-in for arXiv and Semantic Scholar (conftest.py), never the live services."""

from __future__ import annotations

import ast
import json
from pathlib import Path

SKILL = "arxiv"
SCRIPT = "arxiv_search.py"
# the script's waits, shortened a hundredfold when it talks to the stand-in
API_GAP, SITE_GAP, S2_GAP = 0.03, 0.15, 0.01


def go(run, fake, *args, ok=True, env=None):
    return run(SKILL, SCRIPT, *args, ok=ok, env={"ARXIV_SEARCH_TEST_SERVER": fake.url, **(env or {})})


def one_line_error(result, *words):
    assert result.code == 2
    lines = result.err.strip().splitlines()
    assert len(lines) == 1, result.err
    assert "Traceback" not in result.err
    for w in words:
        assert w in result.err, result.err


def gaps(hits):
    return [b.at - a.at for a, b in zip(hits, hits[1:])]


# ---------------------------------------------------------------- search


def test_words_are_joined_with_and_not_left_for_arxiv_to_or(run, fake):
    # the old helper sent all:GRPO%20reinforcement%20learning, which arXiv runs as GRPO OR reinforcement OR learning
    out = go(run, fake, "search", "GRPO", "reinforcement learning", "--max", "3").json()
    [hit] = fake.of("api")
    assert hit.query["search_query"] == "all:GRPO AND all:reinforcement AND all:learning"
    assert out["query"] == hit.query["search_query"]
    assert hit.query["sortBy"] == "relevance" and hit.query["max_results"] == "3"
    assert hit.headers["User-Agent"].startswith("AthenaAgents/")
    assert out["total"] == 3 and out["returned"] == 3
    first = out["papers"][0]
    assert first["versioned_id"] == "2508.20751v2" and first["id"] == "2508.20751" and first["version"] == "v2"
    assert first["title"].startswith("Pref-GRPO: Pairwise Preference")
    assert "\n" not in first["abstract"]
    assert first["abs_url"] == "https://arxiv.org/abs/2508.20751v2"
    assert first["pdf_url"] == "https://arxiv.org/pdf/2508.20751v2"
    assert first["html_url"] == "https://arxiv.org/html/2508.20751v2"


def test_phrases_authors_categories_dates_and_exclusions(run, fake):
    go(run, fake, "search", "--phrase", "chain of thought", "--author", "Yann LeCun", "--author", "Bengio",
       "--category", "cs.CL", "--category", "cs.LG", "--from", "2024-01", "--to", "2024-02-15", "--exclude", "vision",
       "--exclude", "image", "--in", "title", "--sort", "submitted", "--oldest-first")
    [hit] = fake.of("api")
    assert hit.query["search_query"] == (
        '(ti:"chain of thought" AND au:"Yann LeCun" AND au:Bengio AND (cat:cs.CL OR cat:cs.LG) '
        "AND submittedDate:[202401010000 TO 202402152359]) ANDNOT (ti:vision OR ti:image)"
    )
    assert hit.query["sortBy"] == "submittedDate" and hit.query["sortOrder"] == "ascending"


def test_a_whole_year_and_a_raw_query(run, fake):
    go(run, fake, "search", "--category", "hep-th", "--from", "2023", "--to", "2023", "--query", "ti:GPT OR ti:BERT")
    assert fake.of("api")[0].query["search_query"] == (
        "cat:hep-th AND submittedDate:[202301010000 TO 202312312359] AND (ti:GPT OR ti:BERT)")


def test_or_among_the_words_is_refused_before_anything_is_sent(run, fake):
    result = go(run, fake, "search", "GPT", "OR", "BERT", ok=False)
    one_line_error(result, "--query")
    assert fake.hits == []


def test_bad_dates_and_categories_are_refused(run, fake):
    one_line_error(go(run, fake, "search", "x", "--from", "2024-13", ok=False), "2024-13")
    one_line_error(go(run, fake, "search", "x", "--from", "2024-05", "--to", "2024-01", ok=False), "--from")
    one_line_error(go(run, fake, "search", "x", "--category", "cs CL!", ok=False), "category")
    one_line_error(go(run, fake, "search", ok=False), "nothing to search for")
    one_line_error(go(run, fake, "search", "x", "--oldest-first", ok=False), "--sort")
    assert fake.hits == []


def test_pages_of_100_three_seconds_apart(run, fake):
    fake.many_results(250)
    out = go(run, fake, "search", "electron", "--max", "150", "--sort", "updated").json()
    hits = fake.of("api")
    assert [(h.query["start"], h.query["max_results"]) for h in hits] == [("0", "100"), ("100", "50")]
    assert all(g >= API_GAP for g in gaps(hits))
    assert out["total"] == 250 and out["returned"] == 150
    assert out["papers"][100]["id"] == "2601.00101"


def test_stops_at_the_end_of_the_results(run, fake):
    out = go(run, fake, "search", "GRPO", "--max", "500").json()
    assert out["returned"] == 3 and len(fake.of("api")) == 1


def test_no_results_is_not_a_failure(run, fake):
    fake.search_results = []
    out = go(run, fake, "search", "qwxzzyqplk").json()
    assert out["total"] == 0 and out["papers"] == []


def test_arxiv_refusing_the_query_is_one_line(run, fake):
    fake.api_errors = [(400, "error-start.xml")]
    one_line_error(go(run, fake, "search", "electron", ok=False), "start must be non-negative")


def test_a_later_page_failing_keeps_the_first(run, fake):
    fake.many_results(250)
    fake.api_fail_from = 2
    result = go(run, fake, "search", "electron", "--max", "200", ok=False)
    one_line_error(result, "HTTP 500")
    partial = result.json()
    assert partial["returned"] == 100 and len(partial["papers"]) == 100
    assert "HTTP 500" in partial["stopped"]


def test_numbers_are_checked(run, fake):
    for args in (["--max", "0"], ["--max", "-1"], ["--max", "2001"], ["--max", "ten"], ["--start", "-1"],
                 ["--timeout", "0"], ["--timeout", "-5"], ["--timeout", "nan"]):
        one_line_error(go(run, fake, "search", "x", *args, ok=False))
    one_line_error(go(run, fake, "search", "x", "--start", "29999", "--max", "5", ok=False), "30000")
    assert fake.hits == []


# ---------------------------------------------------------------- get


def test_get_keeps_the_order_asked_and_names_what_is_missing(run, fake):
    result = go(run, fake, "get", "https://arxiv.org/pdf/2402.03300v1.pdf", "solv-int/9901001", "arXiv:hep-th/0601001",
                "2402.99999", "https://arxiv.org/abs/1706.03762v1", ok=False)
    assert result.code == 1
    out = result.json()
    assert [p["versioned_id"] for p in out["papers"]] == [
        "2402.03300v1", "solv-int/9901001v1", "hep-th/0601001v2", "1706.03762v1"]
    assert out["not_found"] == ["2402.99999"]
    [hit] = fake.of("api")
    assert hit.query["id_list"] == "2402.03300v1,solv-int/9901001,hep-th/0601001,2402.99999,1706.03762v1"
    assert hit.query["max_results"] == "5"


def test_old_ids_whose_archive_has_a_v(run, fake):
    # the old helper split ids on "v", so solv-int/9901001v1 became "sol"
    out = go(run, fake, "get", "solv-int/9901001v1").json()
    [p] = out["papers"]
    assert (p["id"], p["version"], p["versioned_id"]) == ("solv-int/9901001", "v1", "solv-int/9901001v1")
    assert p["primary_category"] == "nlin.SI"
    assert p["doi"] == "10.1016/S0375-9601(99)00466-1"
    assert p["comment"] == "8 pages, LaTeX"
    assert p["abstract"].startswith("Using a Miura-Gardner-Kruskal")


def test_versions_and_dates(run, fake):
    out = go(run, fake, "get", "2402.03300", "hep-th/0601001").json()
    latest, old = out["papers"]
    assert latest["versioned_id"] == "2402.03300v3"  # without a version: the latest
    assert (latest["submitted"], latest["version_date"]) == ("2024-02-05", "2024-04-27")
    assert old["journal_ref"] == "JHEP 0706:060,2007"
    assert old["categories"] == ["hep-th", "gr-qc"] and old["primary_category"] == "hep-th"


def test_subject_class_ids_are_filed_under_the_archive(run, fake):
    go(run, fake, "get", "math.GT/0309136", ok=False)
    assert fake.of("api")[0].query["id_list"] == "math/0309136"


def test_withdrawn_papers_are_flagged(run, fake):
    out = go(run, fake, "get", "0910.4008v2", "math/9911108v6", "1003.2568v2", "2402.03300v3").json()
    notes = {p["versioned_id"]: p.get("withdrawn_note") for p in out["papers"]}
    assert notes["0910.4008v2"] == "Withdrawn"
    assert notes["math/9911108v6"] == "Withdrawn"
    assert notes["1003.2568v2"] == "withdrawn"
    assert notes["2402.03300v3"] is None
    assert out["maybe_withdrawn"] == ["0910.4008v2", "math/9911108v6", "1003.2568v2"]


def test_ids_from_a_file_powershell_wrote(run, fake, tmp_path):
    ids = tmp_path / "ids.txt"
    ids.write_bytes("2402.03300v1\r\n# a comment\r\nhep-th/0601001, solv-int/9901001\r\n".encode("utf-16"))
    out = go(run, fake, "get", "--file", ids).json()
    assert [p["id"] for p in out["papers"]] == ["2402.03300", "hep-th/0601001", "solv-int/9901001"]


def test_names_with_accents_survive_a_windows_pipe(run, fake):
    vid = "hep-th/0601001v2"
    fake.entries[vid] = fake.entries[vid].replace("Lubos Motl", "Luboš Motl")
    out = go(run, fake, "get", vid).json()
    assert "Luboš Motl" in out["papers"][0]["authors"]


def test_ids_that_are_not_arxiv_ids_are_refused(run, fake):
    for bad in ("1234.123456", "2401.1234", "1501.1234", "0612.0001", "2413.00001", "notanid", "2401.01234v0"):
        one_line_error(go(run, fake, "get", bad, ok=False), "isn't an arXiv id")
    one_line_error(go(run, fake, "get", ok=False), "at least one id")
    assert fake.hits == []


def test_get_writes_to_out_and_summarises(run, fake, tmp_path):
    out_file = tmp_path / "results" / "papers.json"
    summary = go(run, fake, "get", "2402.03300", "--out", out_file).json()
    assert summary["papers"] == 1 and summary["not_found"] == []
    saved = json.loads(out_file.read_text(encoding="utf-8"))
    assert saved["papers"][0]["versioned_id"] == "2402.03300v3"
    one_line_error(go(run, fake, "get", "2402.03300", "--out", out_file, ok=False), "--overwrite")
    go(run, fake, "get", "2402.03300", "--out", out_file, "--overwrite")
    one_line_error(go(run, fake, "get", "2402.03300", "--out", tmp_path, ok=False), "folder")
    assert sorted(p.name for p in out_file.parent.iterdir()) == ["papers.json"]


# ---------------------------------------------------------------- bibtex


def test_bibtex_is_arxivs_own_entry(run, fake):
    out = go(run, fake, "bibtex", "2402.03300", "hep-th/0601001").json()
    first, second = out["entries"]
    assert first["bibtex"] == fake.bibtex["2402.03300"].strip()
    assert "pinned" not in first
    assert "doi={https://doi.org/10.1088/1126-6708/2007/06/060}" in second["bibtex"]
    assert [h.path for h in fake.of("site")] == ["/bibtex/2402.03300", "/bibtex/hep-th/0601001"]
    assert fake.of("api") == []  # no version given, so no lookup
    assert all(g >= SITE_GAP for g in gaps(fake.of("site")))


def test_bibtex_for_a_version_is_pinned_to_it(run, fake):
    # arXiv's entry for 1706.03762v1 has no version and the year of the latest one (2023)
    out = go(run, fake, "bibtex", "1706.03762v1").json()
    [entry] = out["entries"]
    assert entry["pinned"] == {"version": "v1", "version_date": "2017-06-12", "year_arxiv_gave": "2023"}
    text = entry["bibtex"]
    assert "eprint={1706.03762v1}" in text and "url={https://arxiv.org/abs/1706.03762v1}" in text
    assert "year={2017}" in text and "2023}," not in text
    assert "vaswani2023attentionneed" in text  # the key stays as arXiv made it
    assert fake.of("api")[0].query["id_list"] == "1706.03762v1"


def test_bibtex_missing_papers_and_versions(run, fake, tmp_path):
    bib = tmp_path / "refs.bib"
    result = go(run, fake, "bibtex", "2402.99999", "2402.03300v9", "hep-th/0601001", "--out", bib, ok=False)
    assert result.code == 1
    summary = result.json()
    assert summary["entries"] == 1 and summary["not_found"] == ["2402.99999", "2402.03300v9"]
    text = bib.read_text(encoding="utf-8")
    assert text.startswith("@misc{arkanihamed2006") and text.endswith("}\n")


def test_bibtex_with_nothing_found_writes_no_file(run, fake, tmp_path):
    bib = tmp_path / "refs.bib"
    result = go(run, fake, "bibtex", "2402.99999", "--out", bib, ok=False)
    assert result.code == 1 and not bib.exists()


def test_runs_one_after_another_keep_arxivs_gap(run, fake):
    go(run, fake, "bibtex", "2402.03300")
    go(run, fake, "bibtex", "hep-th/0601001")
    assert all(g >= SITE_GAP for g in gaps(fake.of("site")))


# ---------------------------------------------------------------- Semantic Scholar


def test_paper_converts_ids_and_reports_the_ones_it_lacks(run, fake):
    result = go(run, fake, "paper", "2106.15928v2", "10.18653/v1/N18-3011", "https://doi.org/10.18653/v1/N18-3011",
                "CorpusId:215416146", "649def34f8be52c8b66281af98ae884c09aef38b", "2402.99999", ok=False)
    assert result.code == 1
    [hit] = fake.of("s2")
    assert hit.method == "POST" and hit.path == "/graph/v1/paper/batch"
    assert hit.body == {"ids": ["ARXIV:2106.15928", "DOI:10.18653/v1/N18-3011", "DOI:10.18653/v1/N18-3011",
                                "CorpusId:215416146", "649def34f8be52c8b66281af98ae884c09aef38b", "ARXIV:2402.99999"]}
    assert "citationCount" in hit.query["fields"]
    out = result.json()
    assert out["not_found"] == ["2402.99999"]
    first, lit = out["papers"][0], out["papers"][1]
    assert first["asked"] == "2106.15928v2" and first["arxiv"] == "2106.15928" and first["openAccessPdf"] is None
    assert first["venue"] is None  # Semantic Scholar's empty string
    assert lit["citationCount"] == 299 and lit["doi"] == "10.18653/v1/N18-3011"
    assert lit["openAccessPdf"].endswith(".pdf")
    assert lit["authors"][-1] == "Oren Etzioni" and len(lit["authors"]) == 7


def test_a_real_batch_answer(run, fake):
    # s2-batch.json: what Semantic Scholar sent for ARXIV:2402.03300 and the unknown ARXIV:2402.99999
    result = go(run, fake, "paper", "https://arxiv.org/abs/2402.03300v3", "2402.99999", ok=False)
    assert result.code == 1
    assert fake.of("s2")[0].body == {"ids": ["ARXIV:2402.03300", "ARXIV:2402.99999"]}
    out = result.json()
    [paper] = out["papers"]
    assert paper["paperId"] == "35b142ea69598e6241f0011312128031df55895c"
    assert (paper["arxiv"], paper["doi"]) == ("2402.03300", "10.48550/arXiv.2402.03300")
    assert paper["title"].startswith("DeepSeekMath") and paper["year"] == 2024
    assert isinstance(paper["citationCount"], int)
    assert out["not_found"] == ["2402.99999"]


def test_the_key_is_sent_and_never_shown(run, fake, tmp_path):
    secret = "s2-test-key-123"
    result = go(run, fake, "paper", "2106.15928", env={"SEMANTIC_SCHOLAR_API_KEY": secret})
    sent = {k.lower(): v for k, v in fake.of("s2")[0].headers.items()}
    assert sent["x-api-key"] == secret
    assert secret not in result.out and secret not in result.err
    go(run, fake, "paper", "2106.15928", "--out", tmp_path / "p.json", env={"SEMANTIC_SCHOLAR_API_KEY": secret})
    assert secret not in (tmp_path / "p.json").read_text(encoding="utf-8")
    go(run, fake, "paper", "2106.15928")
    assert "x-api-key" not in {k.lower() for k in fake.of("s2")[-1].headers}


def test_a_busy_pool_is_waited_for_then_explained(run, fake):
    fake.s2_busy = 2
    out = go(run, fake, "paper", "2106.15928").json()
    assert out["papers"][0]["arxiv"] == "2106.15928"
    assert len(fake.of("s2")) == 3
    fake.s2_busy = 99
    result = go(run, fake, "paper", "2106.15928", ok=False)
    one_line_error(result, "429", "SEMANTIC_SCHOLAR_API_KEY")
    assert len(fake.of("s2")) == 3 + 4  # the first try and three more


def test_cites_sorted_with_contexts(run, fake):
    out = go(run, fake, "cites", "arXiv:2402.99999", "--contexts", ok=False)
    assert out.code == 1 and out.json()["not_found"] == ["arXiv:2402.99999"]
    assert fake.of("s2")[-1].path == "/graph/v1/paper/ARXIV:2402.99999/citations"
    out = go(run, fake, "cites", "649def34f8be52c8b66281af98ae884c09aef38b", "--contexts", "--max", "50").json()
    hit = fake.of("s2")[-1]
    assert hit.path == "/graph/v1/paper/649def34f8be52c8b66281af98ae884c09aef38b/citations"
    assert hit.query["limit"] == "50" and "isInfluential" in hit.query["fields"] and "contexts" in hit.query["fields"]
    papers = out["citing_papers"]
    assert [p["citationCount"] for p in papers] == [2900, 120, 3]
    assert papers[0]["isInfluential"] is True and papers[0]["intents"] == ["methodology"]
    assert papers[0]["contexts"][0].startswith("SciBERT")
    assert papers[2]["authors"] == ["A. One", "B. Two", "C. Three", "D. Four", "E. Five"]
    assert papers[2]["author_count"] == 7
    assert out["more_available"] is False


def test_cites_newest_first_and_a_short_page(run, fake):
    out = go(run, fake, "cites", "DOI:10.18653/v1/N18-3011", "--sort", "newest", "--max", "2").json()
    assert [p["year"] for p in out["citing_papers"]] == [2026, 2019]
    assert out["more_available"] is True
    assert "contexts" not in out["citing_papers"][0]


def test_refs_keep_references_semantic_scholar_could_not_match(run, fake):
    out = go(run, fake, "refs", "CorpusId:215416146").json()
    refs = out["references"]
    assert refs[0]["arxiv"] == "1301.00001"
    assert refs[1]["paperId"] is None and refs[1]["title"].startswith("A reference")


def test_similar_for_one_paper_and_for_several(run, fake):
    out = go(run, fake, "similar", "2106.15928", "--pool", "all-cs", "--max", "5").json()
    hit = fake.of("s2")[-1]
    assert hit.method == "GET" and hit.path == "/recommendations/v1/papers/forpaper/ARXIV:2106.15928"
    assert hit.query["from"] == "all-cs" and hit.query["limit"] == "5"
    assert [p["title"] for p in out["recommended"]][0] == "Placeholder recommended paper one"
    go(run, fake, "similar", "2106.15928", "649def34f8be52c8b66281af98ae884c09aef38b", "--not", "1706.03762")
    hit = fake.of("s2")[-1]
    assert hit.method == "POST" and hit.path == "/recommendations/v1/papers"
    assert hit.body == {"positivePaperIds": ["ARXIV:2106.15928", "649def34f8be52c8b66281af98ae884c09aef38b"],
                        "negativePaperIds": ["ARXIV:1706.03762"]}
    one_line_error(go(run, fake, "similar", "2106.15928", "--not", "1706.03762", "--pool", "recent", ok=False), "--pool")


def test_author_search_drops_hyphens(run, fake):
    out = go(run, fake, "author", "Oren", "Etzioni").json()
    assert out["authors"][0]["hIndex"] == 5 and out["authors"][0]["affiliations"] == ["Allen Institute for AI"]
    go(run, fake, "author", "Jean-Pierre", "Serre")
    assert fake.of("s2")[-1].query["query"] == "Jean Pierre Serre"


def test_unknown_id_kinds_are_refused(run, fake):
    one_line_error(go(run, fake, "paper", "some paper title", ok=False), "can't tell what")
    assert fake.hits == []


# ---------------------------------------------------------------- the connection


def test_no_redirect_to_another_host(run, fake):
    fake.redirect_to = "http://example.invalid"
    one_line_error(go(run, fake, "get", "2402.03300", ok=False), "doesn't follow")
    assert len(fake.hits) == 1


def test_nothing_listening(run, closed_url):
    result = run(SKILL, SCRIPT, "get", "2402.03300", ok=False, env={"ARXIV_SEARCH_TEST_SERVER": closed_url})
    one_line_error(result, "couldn't reach")


def test_the_test_server_must_be_on_this_machine(run):
    result = run(SKILL, SCRIPT, "get", "2402.03300", ok=False, env={"ARXIV_SEARCH_TEST_SERVER": "https://export.arxiv.org"})
    one_line_error(result, "127.0.0.1")


def test_help_names_every_command_and_the_exit_codes(run):
    text = run(SKILL, SCRIPT, "--help").out
    for command in ("search", "get", "bibtex", "paper", "cites", "refs", "similar", "author"):
        assert command in text
        assert "Exit codes" in run(SKILL, SCRIPT, command, "--help").out
    assert "SEMANTIC_SCHOLAR_API_KEY" in text
    one_line_error(run(SKILL, SCRIPT, ok=False), "needs a command")
    one_line_error(run(SKILL, SCRIPT, "fetch", ok=False))


def test_the_script_is_one_file_with_the_standard_library():
    source = (Path(__file__).resolve().parents[3] / "skills" / "athena" / SKILL / "scripts" / SCRIPT).read_text("utf-8")
    imports = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            imports |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom):
            imports.add((node.module or "").split(".")[0])
    assert imports <= {"__future__", "argparse", "codecs", "http", "json", "locale", "math", "os", "re", "sys",
                       "tempfile", "time", "urllib", "xml", "datetime", "typing"}
