"""A stand-in YouTube for youtube_transcript.py (fake/sitecustomize.py does the answering).

The answers in responses/ are YouTube's own, trimmed from the saved pages and player answers that
youtube-transcript-api 1.2.4 keeps for its tests: a watch page with the player's key, the captcha page YouTube shows
when it limits a network, the cookie-consent page, and player answers for a video with captions (English by a person
and auto-generated, German, Spanish; 18 translation languages), with auto-generated English only, with no captions,
age-restricted, unavailable, unplayable, a bot check, and captions that need a proof-of-origin token. The caption
files are written here in the timedtext format YouTube sends (and the library parses): HTML inside escaped once more.
"""

from __future__ import annotations

import importlib.metadata
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pytest

HERE = Path(__file__).parent
RESPONSES = HERE / "responses"

CAPTIONS_EN = """<?xml version="1.0" encoding="utf-8" ?><transcript>
<text start="0" dur="2.5">Hi, I&amp;#39;m trying the new tablet</text>
<text start="2.5" dur="3.1">it&amp;#39;s &lt;i&gt;really&lt;/i&gt; light
and quick</text>
<text start="5.6" dur="0.4"></text>
<text start="61.2" dur="4">we flew from Łódź to Zürich — Привет</text>
<text start="3725.5" dur="2">thanks for watching</text>
</transcript>"""

CAPTIONS_ASR = """<?xml version="1.0" encoding="utf-8" ?><transcript>
<text start="0.4" dur="2.2">hi im trying the new tablet</text>
<text start="2.6" dur="3">its really light and quick</text>
</transcript>"""

CAPTIONS_DE = """<?xml version="1.0" encoding="utf-8" ?><transcript>
<text start="0" dur="2.5">Hallo, ich probiere das neue Tablet aus</text>
<text start="2.5" dur="3.1">es ist wirklich leicht und schnell</text>
</transcript>"""

CAPTIONS_AR = """<?xml version="1.0" encoding="utf-8" ?><transcript>
<text start="0" dur="2.5">مرحبا</text>
</transcript>"""


@dataclass
class FakeYouTube:
    folder: Path
    rules: list[dict[str, Any]] = field(default_factory=list)

    def answer(self, match: str, method: str = "GET", **rule: Any) -> None:
        """Answer requests whose address contains match. The newest rule wins over older ones."""
        self.rules.insert(0, {"match": match, "method": method, **rule})

    def standard(self, player: str = "player_ok.json") -> None:
        """A video with captions: the watch page, the player's answer, and a caption file per language."""
        self.answer("&lang=es", body=CAPTIONS_DE)
        self.answer("&lang=de", body=CAPTIONS_DE)
        self.answer("&lang=en", body=CAPTIONS_EN)
        self.answer("&kind=asr&lang=en", body=CAPTIONS_ASR)
        self.answer("&tlang=ar", body=CAPTIONS_AR)
        self.answer("www.youtube.com/youtubei/v1/player", method="POST", file=str(RESPONSES / player),
                    headers={"Content-Type": "application/json"})
        self.answer("www.youtube.com/watch?", file=str(RESPONSES / "watch.html"), headers={"Content-Type": "text/html"})

    @property
    def env(self) -> dict[str, str]:
        scenario = self.folder / "scenario.json"
        scenario.write_text(json.dumps({"log": str(self.folder / "requests.log"), "rules": self.rules}), encoding="utf-8")
        return {"PYTHONPATH": str(HERE / "fake"), "FAKE_YOUTUBE": str(scenario)}

    def requests(self) -> list[dict[str, Any]]:
        log = self.folder / "requests.log"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines() if line.strip()]


@pytest.fixture
def youtube(tmp_path: Path) -> FakeYouTube:
    """The stand-in YouTube, with the standard video. Tests that need the library skip without it."""
    pytest.importorskip("youtube_transcript_api", reason="youtube-transcript-api isn't installed", exc_type=ImportError)
    version = importlib.metadata.version("youtube-transcript-api")
    if tuple(int(n) for n in version.split(".")[:2]) < (1, 2):
        pytest.skip(f"youtube-transcript-api {version} is older than the 1.2 the script needs")
    folder = tmp_path / "fake-youtube"
    folder.mkdir()
    fake = FakeYouTube(folder)
    fake.standard()
    return fake


@pytest.fixture
def hide(tmp_path: Path):
    """hide('youtube_transcript_api') -> env that makes that package fail to import in the script's process."""

    def _hide(*modules: str) -> dict[str, str]:
        stubs = tmp_path / "hidden-packages"
        for name in modules:
            pkg = stubs / name
            pkg.mkdir(parents=True, exist_ok=True)
            (pkg / "__init__.py").write_text(f"raise ImportError('{name} is hidden for this test')\n", encoding="utf-8")
        return {"PYTHONPATH": str(stubs)}

    return _hide
