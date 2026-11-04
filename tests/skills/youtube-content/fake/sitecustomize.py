"""A stand-in for YouTube, loaded into the script's own process by the youtube-content tests (they put this folder
on PYTHONPATH and name a scenario file in FAKE_YOUTUBE).

It replaces the one place requests touches the network, HTTPAdapter.send, so youtube-transcript-api and the
script run unchanged above it. Each request is logged, then answered by the first rule whose method matches and
whose text appears in the address; a rule with "times" answers only that often. No rule means a connection error,
so nothing here can reach the real YouTube.
"""

from __future__ import annotations

import json
import os

SCENARIO = os.environ.get("FAKE_YOUTUBE")

if SCENARIO:
    import requests
    from requests.adapters import HTTPAdapter
    from requests.models import Response
    from requests.structures import CaseInsensitiveDict

    def _send(self, request, **kwargs):  # type: ignore[no-untyped-def]
        with open(SCENARIO, encoding="utf-8") as fh:
            scenario = json.load(fh)
        with open(scenario["log"], "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "method": request.method,
                "url": request.url,
                "user_agent": request.headers.get("User-Agent"),
                "cookie": request.headers.get("Cookie"),
                "timeout": kwargs.get("timeout"),
            }) + "\n")
        for rule in scenario["rules"]:
            if rule["method"] != request.method or rule["match"] not in request.url:
                continue
            if rule.get("times") is not None and rule.get("used", 0) >= rule["times"]:
                continue
            rule["used"] = rule.get("used", 0) + 1
            with open(SCENARIO, "w", encoding="utf-8") as fh:
                json.dump(scenario, fh)
            if rule.get("timeout"):
                raise requests.exceptions.ReadTimeout("the fake YouTube didn't answer", request=request)
            body = rule.get("body", "")
            if rule.get("file"):
                with open(rule["file"], encoding="utf-8") as fh:
                    body = fh.read()
            response = Response()
            response.status_code = rule.get("status", 200)
            response.reason = rule.get("reason", "OK")
            response.headers = CaseInsensitiveDict(rule.get("headers") or {})
            response._content = body.encode("utf-8")
            response._content_consumed = True
            response.encoding = "utf-8"
            response.url = request.url
            response.request = request
            return response
        raise requests.exceptions.ConnectionError(f"the fake YouTube has no answer for {request.method} {request.url}",
                                                  request=request)

    HTTPAdapter.send = _send
