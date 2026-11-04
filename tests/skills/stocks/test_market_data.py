"""market_data.py against a stand-in for SEC EDGAR, Twelve Data and Tiingo (conftest.py), never the live services."""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import sys
from pathlib import Path

import pytest

# the stand-in's keys and the contact it expects, as in conftest.py (which a test module can't import)
TWELVE_KEY = "td-test-0123456789abcdef"
TIINGO_KEY = "ti-test-fedcba9876543210"
CONTACT = "Ada Lovelace ada@lovelace.test"

SCRIPT = Path(__file__).resolve().parents[3] / "skills" / "athena" / "stocks" / "scripts" / "market_data.py"
REV = "RevenueFromContractWithCustomerExcludingAssessedTax"


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


def sec(md, *args, ok=True):
    return md(*args, "--contact", CONTACT, ok=ok)


# ---------------------------------------------------------------- SEC EDGAR


def test_cik_finds_by_ticker_name_and_number_and_names_who_asks(md, fake):
    r = sec(md, "cik", "brk.b", "alphabet", "320193")
    found = {x["query"]: x["matches"] for x in r.json()["results"]}
    assert found["brk.b"] == [{"cik": "0001067983", "name": "BERKSHIRE HATHAWAY INC", "tickers": ["BRK-B", "BRK-A"]}]
    assert found["alphabet"] == [{"cik": "0001652044", "name": "Alphabet Inc.", "tickers": ["GOOGL", "GOOG"]}]
    assert found["320193"][0]["tickers"] == ["AAPL"]
    [asked] = fake.seen("/files/")
    assert asked.headers["User-Agent"] == f"AthenaAgents {CONTACT}"
    assert "gzip" in asked.headers["Accept-Encoding"]  # and the gzipped answer was read


def test_a_name_can_match_several_companies_and_a_miss_is_a_problem(md):
    r = sec(md, "cik", "apple", "nosuchcompanyatall", ok=False)
    assert r.code == 1
    results = r.json()["results"]
    assert [m["name"] for m in results[0]["matches"]] == ["Apple Inc.", "Apple Hospitality REIT, Inc."]
    assert results[1]["matches"] == []
    assert "nosuchcompanyatall" in r.json()["problems"][0]


@pytest.mark.parametrize("contact, says", [
    (None, "--contact"),
    ("Ada Lovelace", "an email"),
    ("ada@lovelace.test", "a name and an email"),
    ("Jane Doe jane@example.com", "example address"),
    ("Łukasz Nowak lukasz@nowak.test", "plain ASCII"),
])
def test_the_sec_commands_need_the_users_own_contact(md, fake, contact, says):
    args = ["cik", "AAPL"] + (["--contact", contact] if contact else [])
    r = md(*args, ok=False)
    assert r.code == 2 and one_line(r.err) and says in r.err, r.err
    assert r.out == "" and fake.requests == []


def test_the_contact_can_come_from_the_environment(md, fake):
    md("cik", "AAPL", SEC_CONTACT=CONTACT)
    assert fake.requests[0].headers["User-Agent"].endswith(CONTACT)


def test_the_sec_refusing_is_one_line_that_says_why(md, fake):
    fake.sec_status = 403  # EDGAR's answer to too many requests
    r = sec(md, "filings", "320193", ok=False)
    assert r.code == 2 and one_line(r.err) and "10 a second" in r.err
    fake.sec_status = 503
    r = sec(md, "filings", "320193", ok=False)
    assert r.code == 2 and one_line(r.err) and "503 Service Unavailable" in r.err


def test_filings_lists_newest_first_with_links(md):
    data = sec(md, "filings", "AAPL", "--form", "10-K,10-Q", "--limit", "3").json()
    assert data["company"]["name"] == "Apple Inc." and data["company"]["fiscal_year_end"] == "09-26"
    assert data["company"]["exchanges"] == ["Nasdaq"]
    assert [f["form"] for f in data["filings"]] == ["10-K", "10-Q", "10-Q"]
    assert data["matched"] == 5
    first = data["filings"][0]
    assert first["document"] == "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/aapl-20260926.htm"
    assert first["index"] == "https://www.sec.gov/Archives/edgar/data/320193/000032019326000026/0000320193-26-000026-index.htm"
    assert "1271 older filings" in data["older"] and "--older" in data["older"]


def test_a_form_includes_its_amendments_and_since_filters(md, fake):
    recent = fake.sec["/submissions/CIK0000320193.json"]["filings"]["recent"]
    for key, value in (("accessionNumber", "0000320193-26-000002"), ("filingDate", "2026-01-10"), ("reportDate", "2025-09-27"),
                       ("form", "10-K/A"), ("items", ""), ("primaryDocument", "aapl-20250927a.htm"), ("primaryDocDescription", "10-K/A")):
        recent[key].append(value)
    data = sec(md, "filings", "AAPL", "--form", "10-k", "--since", "2025-11-01").json()
    assert [(f["form"], f["filed"]) for f in data["filings"]] == [("10-K", "2026-11-03"), ("10-K/A", "2026-01-10")]
    r = sec(md, "filings", "AAPL", "--form", "S-1", ok=False)
    assert r.code == 1 and r.json()["filings"] == [] and "S-1" in r.json()["problems"][0]


def test_older_filings_are_read_when_asked(md, fake):
    data = sec(md, "filings", "320193", "--older", "--form", "10-Q", "--limit", "10").json()
    assert data["filings"][-1]["filed"] == "2015-07-22"
    assert "older" not in data
    assert any(r.path.endswith("-submissions-001.json") for r in fake.requests)
    assert not fake.seen("/files/")  # a CIK needs no ticker lookup


def test_an_unknown_ticker_stops_before_asking_for_filings(md, fake):
    r = sec(md, "filings", "ZZZZ", ok=False)
    assert r.code == 2 and one_line(r.err) and "cik command" in r.err
    assert not fake.seen("/submissions/")


def test_facts_lists_concepts_that_match_with_the_latest_first(md):
    data = sec(md, "facts", "AAPL", "--find", "revenue").json()
    assert [c["concept"] for c in data["concepts"]] == [REV, "Revenues"]
    assert data["concepts"][0]["latest_end"] == "2026-09-26" and data["concepts"][1]["latest_end"] == "2018-09-29"
    assert data["taxonomies"] == {"dei": 1, "us-gaap": 3}


def test_annual_values_are_picked_by_their_dates_not_the_filings_year(md):
    data = sec(md, "facts", "AAPL", "--concept", REV).json()
    rows = data["values"]
    assert [(r["end"], r["value"]) for r in rows] == [
        ("2022-09-24", 394328000000), ("2023-09-30", 383285000000), ("2024-09-28", 391035000000),
        ("2025-09-27", 416161000000), ("2026-09-26", 478834000000)]
    fy2025 = rows[3]
    # reported again in the 2026 10-K, whose fy says 2026: the row is still the year that ended in September 2025
    assert fy2025["filing_fy"] == 2026 and fy2025["filed"] == "2026-11-03" and fy2025["days"] == 364
    assert fy2025["calendar_frame"] == "CY2025"
    assert fy2025["filing_index"].endswith("/000032019326000026/0000320193-26-000026-index.htm")
    assert data["unit"] == "USD" and "not the value's period" in data["reading"]
    assert all("earlier_values" not in r for r in rows)


def test_quarters_leave_out_year_to_date_and_the_fourth_quarter_has_no_fact(md):
    rows = sec(md, "facts", "320193", "--concept", REV, "--period", "quarter").json()["values"]
    assert [(r["start"], r["end"], r["value"]) for r in rows] == [
        ("2025-09-28", "2025-12-27", 143756000000), ("2025-12-28", "2026-03-28", 111184000000),
        ("2026-03-29", "2026-06-27", 109417000000)]
    everything = sec(md, "facts", "320193", "--concept", REV, "--period", "all", "--since", "2026-01-01").json()["values"]
    assert {r["days"] for r in everything} == {91, 182, 273, 364}


def test_a_changed_value_shows_what_was_filed_before(md, fake):
    concept = fake.sec[f"/api/xbrl/companyconcept/CIK0000320193/us-gaap/{REV}.json"]
    for f in concept["units"]["USD"]:
        if f["end"] == "2024-09-28" and f["filed"] == "2026-11-03":
            f["val"] = 391000000000
    row = [r for r in sec(md, "facts", "AAPL", "--concept", REV).json()["values"] if r["end"] == "2024-09-28"][0]
    assert row["value"] == 391000000000
    assert {(e["value"], e["filed"]) for e in row["earlier_values"]} == {(391035000000, "2024-11-01"), (391035000000, "2025-10-31")}


def test_balances_in_annual_mode_come_from_annual_reports(md, fake):
    facts = fake.sec["/api/xbrl/companyfacts/CIK0000320193.json"]["facts"]["us-gaap"]["AccountsPayableCurrent"]
    fake.sec["/api/xbrl/companyconcept/CIK0000320193/us-gaap/AccountsPayableCurrent.json"] = {
        "cik": 320193, "taxonomy": "us-gaap", "tag": "AccountsPayableCurrent", "label": facts["label"],
        "description": facts["description"], "entityName": "Apple Inc.", "units": facts["units"]}
    rows = sec(md, "facts", "AAPL", "--concept", "AccountsPayableCurrent").json()["values"]
    assert [(r["start"], r["end"]) for r in rows] == [(None, "2024-09-28"), (None, "2025-09-27"), (None, "2026-09-26")]
    assert rows[1]["form"] == "10-K" and rows[1]["filed"] == "2026-11-03"


def test_an_ifrs_filer_is_found_in_ifrs_full(md, fake):
    data = sec(md, "facts", "SHEL", "--concept", "Revenue").json()
    assert data["taxonomy"] == "ifrs-full" and data["label"] is None
    assert [(r["end"], r["value"], r["form"]) for r in data["values"]] == [
        ("2024-12-31", 284312000000, "20-F"), ("2025-12-31", 266886000000, "20-F")]
    tried = [r.path for r in fake.seen("/api/xbrl/companyconcept/")]
    assert tried == ["/api/xbrl/companyconcept/CIK0001306965/us-gaap/Revenue.json",
                     "/api/xbrl/companyconcept/CIK0001306965/ifrs-full/Revenue.json"]


def test_a_concept_the_company_doesnt_report_is_a_problem(md):
    r = sec(md, "facts", "AAPL", "--concept", "NoSuchThing", ok=False)
    assert r.code == 1 and "--find" in r.json()["problems"][0]
    r = sec(md, "facts", "AAPL", "--concept", "../files/x", ok=False)
    assert r.code == 2 and one_line(r.err)


def test_a_unit_that_isnt_there_says_which_are(md):
    r = sec(md, "facts", "AAPL", "--concept", REV, "--unit", "EUR", ok=False)
    assert r.code == 1 and "USD" in r.json()["problems"][0]


# ---------------------------------------------------------------- prices


def priced(md, *args, ok=True, provider="twelvedata"):
    env = {"TWELVE_DATA_API_KEY": TWELVE_KEY} if provider == "twelvedata" else {"TIINGO_API_KEY": TIINGO_KEY}
    return md(*args, ok=ok, **env)


def test_a_quote_says_exchange_currency_and_time_and_keeps_the_key_out_of_sight(md, fake):
    r = priced(md, "quote", "aapl")
    [q] = r.json()["quotes"]
    assert (q["symbol"], q["exchange"], q["mic_code"], q["currency"]) == ("AAPL", "NASDAQ", "XNGS", "USD")
    assert q["price"] == 331.89999 and q["previous_close"] == 338.32001 and q["volume"] == 62093400
    # 15:59 in New York, after the clocks went back on 1 November
    assert q["quote_time_utc"] == "2026-11-03T20:59:00Z" and q["trading_day"] == "2026-11-03"
    assert q["market_open"] is False and q["price_is"] == "the last close"
    # the distance from the 52-week low and high, named as what it is
    assert q["fifty_two_week"] == {"low": 243.42, "high": 351.73001, "above_low_pct": 36.35, "below_high_pct": 5.64}
    assert r.json()["provider"] == "Twelve Data"
    [asked] = fake.seen("/quote")
    assert asked.headers["Authorization"] == f"apikey {TWELVE_KEY}" and "apikey" not in asked.query
    assert TWELVE_KEY not in r.out + r.err


def test_several_symbols_crypto_included_and_a_miss_doesnt_stop_the_rest(md):
    r = priced(md, "quote", "AAPL", "NOPE", "BTC/USD", ok=False)
    assert r.code == 1
    data = r.json()
    assert [q["symbol"] for q in data["quotes"]] == ["AAPL", "BTC/USD"]
    btc = data["quotes"][1]
    assert btc["currency"] == "USD" and btc["exchange"] == "Binance" and btc["market_open"] is True
    assert "NOPE" in data["problems"][0]


def test_a_limit_reached_partway_reports_what_came_through(md, fake):
    fake.twelve_allowance = 1
    r = priced(md, "quote", "AAPL", "BTC/USD", "MSFT", ok=False)
    assert r.code == 1
    data = r.json()
    assert [q["symbol"] for q in data["quotes"]] == ["AAPL"]
    assert data["not_fetched"] == ["BTC/USD", "MSFT"]
    assert "request limit" in data["problems"][0]
    assert len(fake.seen("/quote")) == 2  # it stopped asking


def test_a_limit_reached_at_once_is_a_failure(md, fake):
    fake.twelve_allowance = 0
    r = priced(md, "quote", "AAPL", ok=False)
    assert r.code == 2 and one_line(r.err) and "request limit" in r.err


def test_no_key_is_one_line_naming_where_to_put_one(md, fake):
    r = md("quote", "AAPL", ok=False)
    assert r.code == 2 and one_line(r.err) and "TWELVE_DATA_API_KEY" in r.err and "TIINGO_API_KEY" in r.err
    r = md("quote", "AAPL", "--provider", "tiingo", ok=False)
    assert r.code == 2 and "TIINGO_API_KEY" in r.err and "tiingo.com" in r.err
    assert fake.requests == []


def test_a_wrong_key_is_refused_and_never_echoed(md, fake):
    fake.echo_key = True
    r = md("quote", "AAPL", TWELVE_DATA_API_KEY="td-wrong-key-123456", ok=False)
    assert r.code == 2 and one_line(r.err) and "refused the key" in r.err
    assert "td-wrong-key-123456" not in r.err + r.out and "[key]" in r.err


def test_the_key_file_can_be_utf16_as_powershell_writes_it(md, fake, tmp_path):
    key_file = tmp_path / "key.txt"
    key_file.write_bytes(("﻿" + TWELVE_KEY + "\r\n").encode("utf-16-le"))
    r = md("quote", "AAPL", "--provider", "twelvedata", "--key-file", key_file)
    assert r.json()["quotes"][0]["symbol"] == "AAPL"
    r = md("quote", "AAPL", "--key-file", key_file, ok=False)
    assert r.code == 2 and "--provider" in r.err
    (tmp_path / "empty.txt").write_text("\n", encoding="utf-8")
    r = md("quote", "AAPL", "--provider", "twelvedata", "--key-file", tmp_path / "empty.txt", ok=False)
    assert r.code == 2 and "empty" in r.err


def test_history_keeps_the_end_day_and_summarises_from_first_close_to_last(md, fake):
    data = priced(md, "history", "AAPL", "--start", "2026-08-06", "--end", "2026-08-12", "--adjust", "none").json()
    [s] = data["series"]
    assert [b["date"] for b in s["bars"]] == ["2026-08-06", "2026-08-07", "2026-08-10", "2026-08-11", "2026-08-12"]
    assert (s["currency"], s["exchange"], s["timezone"]) == ("USD", "NASDAQ", "America/New_York")
    summary = s["summary"]
    assert summary["first"] == {"date": "2026-08-06", "close": 312.41} and summary["last"] == {"date": "2026-08-12", "close": 302.25}
    assert summary["change"] == -10.16 and summary["change_pct"] == -3.25
    assert summary["highest"] == {"date": "2026-08-06", "high": 316.29001}
    assert summary["lowest"] == {"date": "2026-08-12", "low": 300.57001}
    assert data["adjusted"].startswith("no")
    [asked] = fake.seen("/time_series")
    assert asked.query["end_date"] == "2026-08-13" and asked.query["adjust"] == "none" and asked.query["order"] == "asc"


def test_history_is_adjusted_for_dividends_by_default(md):
    data = priced(md, "history", "AAPL", "--start", "2026-08-06", "--end", "2026-08-07").json()
    assert data["adjusted"] == "for splits and dividends"
    assert [b["close"] for b in data["series"][0]["bars"]] == [312.1376, 313.056778]


def test_history_with_out_writes_the_file_and_prints_the_summary(md, tmp_path):
    out = tmp_path / "market-work" / "prices.json"
    r = priced(md, "history", "AAPL", "--start", "2026-10-29", "--end", "2026-11-03", "--out", out)
    printed = r.json()
    assert printed["wrote"] == str(out.resolve()) and "bars" not in printed["series"][0]
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert len(saved["series"][0]["bars"]) == 4 and saved["series"][0]["summary"] == printed["series"][0]["summary"]
    assert [p.name for p in out.parent.iterdir()] == ["prices.json"]  # no temporary file left behind
    r = priced(md, "history", "AAPL", "--out", tmp_path, ok=False)
    assert r.code == 2 and one_line(r.err) and "folder" in r.err


def test_history_with_no_bars_in_the_range_is_a_problem(md):
    r = priced(md, "history", "AAPL", "--start", "2020-01-01", "--end", "2020-01-31", ok=False)
    assert r.code == 1 and "AAPL" in r.json()["problems"][0]


def test_tiingo_gives_end_of_day_prices_as_traded_or_adjusted(md, fake):
    recent = [{**bar, "date": f"{(dt.date.today() - dt.timedelta(days=days)).isoformat()}T00:00:00.000Z"}
              for bar, days in zip(fake.tiingo["prices"]["GOOGL"][:2], (3, 2))]
    fake.tiingo["prices"]["GOOGL"] += recent
    q = priced(md, "quote", "GOOGL", provider="tiingo").json()["quotes"][0]
    assert q["price_is"].startswith("the end-of-day close") and q["exchange"] == "NASDAQ" and q["currency"] is None
    assert (q["price"], q["previous_close"], q["change"]) == (519.46, 529.55, -10.09)
    assert q["trading_day"] == recent[1]["date"][:10]
    fake.tiingo["prices"]["GOOGL"][1].update({"divCash": 0.5, "adjClose": 519.0})
    data = priced(md, "history", "GOOGL", "--start", "2015-01-01", "--end", "2015-01-05", provider="tiingo").json()
    bars = data["series"][0]["bars"]
    assert [b["date"] for b in bars] == ["2015-01-02", "2015-01-05"]  # Tiingo keeps the end day
    assert bars[1]["close"] == 519.0 and bars[1]["dividend"] == 0.5
    assert data["series"][0]["summary"]["dividends"] == [{"date": "2015-01-05", "amount": 0.5}]
    raw = priced(md, "history", "GOOGL", "--start", "2015-01-01", "--end", "2015-01-05", "--adjust", "none", provider="tiingo").json()
    assert raw["series"][0]["bars"][1]["close"] == 519.46
    for r in fake.seen("/tiingo/"):
        assert r.headers["Authorization"] == f"Token {TIINGO_KEY}" and "token" not in r.query


def test_tiingo_refuses_what_it_cant_do_before_asking(md, fake):
    r = priced(md, "history", "GOOGL", "--adjust", "splits", provider="tiingo", ok=False)
    assert r.code == 2 and "--adjust" in r.err
    r = priced(md, "quote", "BTC/USD", provider="tiingo", ok=False)
    assert r.code == 1 and "Twelve Data" in r.json()["problems"][0]
    assert fake.requests == []


def test_symbols_needs_no_key_and_says_the_currency(md, fake):
    data = md("symbols", "shel").json()
    london = data["listings"][0]
    assert (london["exchange"], london["mic_code"], london["currency"]) == ("LSE", "XLON", "GBp")  # pence, not pounds
    assert data["listings"][1]["type"] == "American Depositary Receipt"
    assert "Authorization" not in fake.requests[0].headers
    r = md("symbols", "zzzzqqq", ok=False)
    assert r.code == 1 and r.json()["listings"] == []


# ---------------------------------------------------------------- the network rules


def test_a_redirect_to_another_host_isnt_followed(md, fake, other_host):
    url, reached = other_host
    fake.redirect_to = url
    r = priced(md, "quote", "AAPL", ok=False)
    assert r.code == 2 and one_line(r.err) and "not followed" in r.err
    assert reached == []  # the key never left for the other host


def test_nothing_listening_is_one_line(md, closed_url):
    r = md("cik", "AAPL", "--contact", CONTACT, "--timeout", "5", MARKET_DATA_TEST_BASE=closed_url, ok=False)
    assert r.code == 2 and one_line(r.err) and "couldn't reach www.sec.gov" in r.err


def test_only_http_and_https_addresses(md):
    r = md("symbols", "AAPL", MARKET_DATA_TEST_BASE="ftp://127.0.0.1/", ok=False)
    assert r.code == 2 and one_line(r.err) and "http or https" in r.err


@pytest.mark.parametrize("args", [
    ["cik", "AAPL", "--limit", "0"], ["filings", "AAPL", "--limit", "-3"], ["symbols", "AAPL", "--limit", "121"],
    ["quote", "AAPL", "--timeout", "0"], ["quote", "AAPL", "--per-minute", "0"], ["quote", "AAPL", "--timeout", "nan"],
    ["history", "AAPL", "--start", "2025-13-01"], ["filings", "AAPL", "--since", "last week"],
    ["history", "AAPL", "--start", "2026-02-01", "--end", "2026-01-01"], ["quote", "AAPL;rm"], [],
])
def test_mistakes_in_the_command_line_are_one_line(md, fake, args):
    r = priced(md, *args, ok=False) if args else md(ok=False)
    assert r.code == 2 and one_line(r.err) and r.out == "", (args, r.err)
    assert fake.requests == []


def test_twelve_data_requests_are_paced_to_the_minute():
    spec = importlib.util.spec_from_file_location("market_data", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["market_data"] = module  # its dataclass looks itself up there
    writes, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # no __pycache__ in the skill's folder
    try:
        spec.loader.exec_module(module)  # type: ignore[union-attr]
    finally:
        del sys.modules["market_data"]
        sys.dont_write_bytecode = writes
    clock = [1000.0]
    pauses: list[float] = []

    def sleep(seconds: float) -> None:
        pauses.append(seconds)
        clock[0] += seconds

    window = module.Window(8, 60.0, clock=lambda: clock[0], sleep=sleep)
    for _ in range(8):
        window.wait()
        clock[0] += 1
    assert pauses == []
    window.wait()  # the ninth waits until the first is a minute old
    assert len(pauses) == 1 and 52 < pauses[0] <= 53
    assert clock[0] - 1000.0 >= 60
