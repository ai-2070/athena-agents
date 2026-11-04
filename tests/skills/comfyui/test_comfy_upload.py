"""comfy_upload.py against a stand-in ComfyUI (conftest.py) that keeps uploads in memory."""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

SKILL = "comfyui"
SCRIPT = "comfy_upload.py"


def picture(path: Path, size=(64, 48), colour=(200, 120, 40)) -> Path:
    Image.new("RGB", size, colour).save(path)
    return path


def bw_mask(path: Path, size=(64, 48)) -> Path:
    """Black, with a white box on the left half: white means repaint."""
    img = Image.new("L", size, 0)
    img.paste(255, (0, 0, size[0] // 2, size[1]))
    img.save(path)
    return path


def stored(comfy, value: str) -> Image.Image:
    sub, _, name = value.rpartition("/")
    return Image.open(io.BytesIO(comfy.inputs[(sub, name)]))


def test_uploads_and_prints_the_names_to_use(run, comfy, tmp_path):
    a = picture(tmp_path / "photo.png")
    b = picture(tmp_path / "street.jpg")
    out = run(SKILL, SCRIPT, a, b, "--server", comfy.url).json()
    assert out["server"] == comfy.url
    assert [(u["file"], u["name"], u["value"]) for u in out["uploaded"]] == [(str(a), "photo.png", "photo.png"), (str(b), "street.jpg", "street.jpg")]
    assert all(u["type"] == "input" for u in out["uploaded"])
    assert comfy.uploads[0]["fields"].get("overwrite") is None
    assert comfy.user_agents == {"AthenaAgents/1.0 (comfy_upload)"}


def test_a_different_file_of_the_same_name_gets_a_new_name(run, comfy, tmp_path):
    comfy.inputs[("", "photo.png")] = b"someone else's photo"
    path = picture(tmp_path / "photo.png")
    [up] = run(SKILL, SCRIPT, path, "--server", comfy.url).json()["uploaded"]
    assert up["value"] == "photo (1).png"
    assert comfy.inputs[("", "photo.png")] == b"someone else's photo"
    # the same file again keeps the name it already has
    [again] = run(SKILL, SCRIPT, path, "--server", comfy.url).json()["uploaded"]
    assert again["value"] == "photo (1).png"


def test_overwrite_and_subfolder(run, comfy, tmp_path):
    comfy.inputs[("shoot", "photo.png")] = b"old"
    path = picture(tmp_path / "photo.png")
    [up] = run(SKILL, SCRIPT, path, "--server", comfy.url, "--subfolder", "shoot", "--overwrite").json()["uploaded"]
    assert (up["name"], up["subfolder"], up["value"]) == ("photo.png", "shoot", "shoot/photo.png")
    assert comfy.uploads[0]["fields"]["overwrite"] == "true"
    assert comfy.inputs[("shoot", "photo.png")] == path.read_bytes()


def test_names_outside_ascii_come_through(run, comfy, tmp_path):
    path = picture(tmp_path / "café ☕.png")
    [up] = run(SKILL, SCRIPT, path, "--server", comfy.url).json()["uploaded"]
    assert up["value"] == "café ☕.png"


def test_white_mask_onto_an_uploaded_image(run, comfy, tmp_path):
    run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", comfy.url)
    [up] = run(SKILL, SCRIPT, bw_mask(tmp_path / "mask.png"), "--server", comfy.url, "--mask-onto", "photo.png").json()["uploaded"]
    assert up["masked"] == "photo.png" and up["value"] == "mask.png"
    assert comfy.uploads[-1]["route"] == "/upload/mask"
    result = stored(comfy, up["value"])
    assert result.mode == "RGBA" and result.size == (64, 48)
    # ComfyUI's Load Image gives MASK = 1 - alpha, so the white (repaint) side must be transparent
    assert result.getpixel((5, 5))[3] == 0
    assert result.getpixel((60, 5))[3] == 255
    assert result.getpixel((60, 5))[:3] == (200, 120, 40)


def test_transparent_mask_in_a_subfolder(run, comfy, tmp_path):
    run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", comfy.url, "--subfolder", "job")
    mask = Image.new("RGBA", (64, 48), (0, 0, 0, 255))
    mask.paste((0, 0, 0, 0), (0, 0, 10, 10))
    mask.save(tmp_path / "hole.png")
    [up] = run(SKILL, SCRIPT, tmp_path / "hole.png", "--server", comfy.url, "--mask-onto", "job/photo.png", "--mask-kind", "transparent").json()["uploaded"]
    assert up["value"] == "job/hole.png"
    result = stored(comfy, up["value"])
    assert result.getpixel((2, 2))[3] == 0 and result.getpixel((30, 30))[3] == 255


def test_mask_problems_are_refused(run, comfy, tmp_path):
    mask = bw_mask(tmp_path / "mask.png")
    r = run(SKILL, SCRIPT, mask, "--server", comfy.url, "--mask-onto", "photo.png", ok=False)
    assert r.code == 2 and "Upload the image first" in r.err
    run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", comfy.url)
    r = run(SKILL, SCRIPT, bw_mask(tmp_path / "small.png", (32, 24)), "--server", comfy.url, "--mask-onto", "photo.png", ok=False)
    assert r.code == 2 and "same size" in r.err
    Image.new("L", (64, 48), 0).save(tmp_path / "black.png")
    r = run(SKILL, SCRIPT, tmp_path / "black.png", "--server", comfy.url, "--mask-onto", "photo.png", ok=False)
    assert r.code == 2 and "nothing to repaint" in r.err
    r = run(SKILL, SCRIPT, mask, "--server", comfy.url, "--mask-onto", "photo.png", "--mask-kind", "transparent", ok=False)
    assert r.code == 2 and "no transparency" in r.err
    assert [u["route"] for u in comfy.uploads] == ["/upload/image"]


def test_without_pillow(run, comfy, tmp_path):
    # a PIL package that won't import stands in for a machine without Pillow
    fake = tmp_path / "nopil" / "PIL"
    fake.mkdir(parents=True)
    (fake / "__init__.py").write_text("raise ImportError('no Pillow here')\n", encoding="utf-8")
    env = {"PYTHONPATH": str(tmp_path / "nopil")}
    photo = picture(tmp_path / "photo.png")
    hole = Image.new("RGBA", (64, 48), (0, 0, 0, 255))
    hole.paste((0, 0, 0, 0), (0, 0, 10, 10))
    hole.save(tmp_path / "hole.png")
    mask = bw_mask(tmp_path / "mask.png")
    run(SKILL, SCRIPT, photo, "--server", comfy.url, env=env)  # plain uploads don't need it
    r = run(SKILL, SCRIPT, mask, "--server", comfy.url, "--mask-onto", "photo.png", env=env, ok=False)
    assert r.code == 2 and "pip install pillow" in r.err
    r = run(SKILL, SCRIPT, mask, "--server", comfy.url, "--mask-onto", "photo.png", "--mask-kind", "transparent", env=env, ok=False)
    assert r.code == 2 and "no transparency" in r.err
    [up] = run(SKILL, SCRIPT, tmp_path / "hole.png", "--server", comfy.url, "--mask-onto", "photo.png", "--mask-kind", "transparent", env=env).json()["uploaded"]
    assert stored(comfy, up["value"]).getpixel((2, 2))[3] == 0


def test_missing_file_and_no_server(run, comfy, closed_url, tmp_path):
    r = run(SKILL, SCRIPT, tmp_path / "nope.png", "--server", comfy.url, ok=False)
    assert r.code == 2 and "No such file" in r.err
    r = run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", closed_url, ok=False)
    assert r.code == 2 and "No ComfyUI answered" in r.err
    assert comfy.uploads == []


def test_nothing_goes_to_something_that_is_not_comfyui(run, comfy, other_app, tmp_path):
    photo = picture(tmp_path / "photo.png")
    # a web app on port 8000 answers 200 to every path, /system_stats too
    r = run(SKILL, SCRIPT, photo, "--server", other_app.url, ok=False)
    assert r.code == 2 and "not ComfyUI" in r.err
    assert [method for method, _ in other_app.requests] == ["GET"]
    # nor to another host a server redirects to
    other_app.redirect_to = comfy.url.replace("127.0.0.1", "localhost")
    r = run(SKILL, SCRIPT, photo, "--server", other_app.url, ok=False)
    assert r.code == 2 and "HTTP 302" in r.err
    assert comfy.requests == [] and comfy.uploads == []
    for address in ("ftp://127.0.0.1/", "http://127.0.0.1:port"):
        r = run(SKILL, SCRIPT, photo, "--server", address, ok=False)
        assert r.code == 2 and r.err.startswith("--server takes an address"), address


def test_subfolder_written_the_windows_way(run, comfy, tmp_path):
    [up] = run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", comfy.url, "--subfolder", "jobs\\shoot\\").json()["uploaded"]
    assert (up["subfolder"], up["value"]) == ("jobs/shoot", "jobs/shoot/photo.png")
    assert ("jobs/shoot", "photo.png") in comfy.inputs


def test_a_mask_that_is_not_a_picture(run, comfy, tmp_path):
    run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", comfy.url)
    (tmp_path / "mask.png").write_text("not a picture", encoding="utf-8")
    r = run(SKILL, SCRIPT, tmp_path / "mask.png", "--server", comfy.url, "--mask-onto", "photo.png", ok=False)
    assert r.code == 2 and "isn't an image" in r.err and len(r.err.strip().splitlines()) == 1


def test_help(run):
    assert "--mask-onto" in run(SKILL, SCRIPT, "--help").out


def test_a_failed_upload_still_lists_the_ones_before_it(run, comfy, tmp_path):
    """So the agent doesn't upload them a second time (which would make photo (1).png)."""
    a = picture(tmp_path / "photo.png")
    b = picture(tmp_path / "street.jpg")
    comfy.refuse.add("street.jpg")
    r = run(SKILL, SCRIPT, a, b, "--server", comfy.url, ok=False)
    assert r.code == 2 and "street.jpg" in r.err and len(r.err.strip().splitlines()) == 1
    out = r.json()
    assert [u["name"] for u in out["uploaded"]] == ["photo.png"] and "street.jpg" in out["error"]


def test_overwrite_never_replaces_the_image_a_mask_goes_onto(run, comfy, tmp_path):
    """The masked copy is named after the mask file: with --overwrite, a mask named like the photo would replace it."""
    run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", comfy.url)
    run(SKILL, SCRIPT, picture(tmp_path / "photo.png"), "--server", comfy.url, "--subfolder", "job")
    originals = dict(comfy.inputs)
    masks = tmp_path / "masks"
    masks.mkdir()
    # the same name in another letter case is the same file on Windows and macOS; a subfolder written the Windows way
    for mask, onto in ((bw_mask(masks / "Photo.png"), "photo.png"), (bw_mask(masks / "photo.jpg"), "job\\photo.png")):
        r = run(SKILL, SCRIPT, mask, "--server", comfy.url, "--mask-onto", onto, "--overwrite", ok=False)
        assert r.code == 2 and "itself" in r.err and len(r.err.strip().splitlines()) == 1, onto
        assert r.out == ""
    assert comfy.inputs == originals
    assert [u["route"] for u in comfy.uploads] == ["/upload/image", "/upload/image"]
    # into another subfolder it replaces nothing of the photo's
    [up] = run(SKILL, SCRIPT, masks / "photo.jpg", "--server", comfy.url, "--mask-onto", "photo.png", "--overwrite", "--subfolder", "masks").json()["uploaded"]
    assert up["value"] == "masks/photo.png"
    # and without --overwrite ComfyUI gives the copy a new name
    [up] = run(SKILL, SCRIPT, masks / "photo.jpg", "--server", comfy.url, "--mask-onto", "photo.png").json()["uploaded"]
    assert up["value"] == "photo (1).png"
    assert comfy.inputs[("", "photo.png")] == originals[("", "photo.png")]
    assert comfy.inputs[("job", "photo.png")] == originals[("job", "photo.png")]


def test_the_system_proxy_is_skipped_for_this_machine_and_the_local_network(run, comfy, proxy, tmp_path):
    photo = picture(tmp_path / "photo.png")
    run(SKILL, SCRIPT, photo, "--server", comfy.url)
    # a private address where nothing answers: the upload fails, and the proxy never hears of it
    r = run(SKILL, SCRIPT, photo, "--server", "http://10.255.255.1:8188", "--timeout", "1", ok=False)
    assert r.code == 2 and "No ComfyUI answered" in r.err
    assert proxy.requests == []
    # any other host goes the way the system's proxy settings say
    r = run(SKILL, SCRIPT, photo, "--server", "http://comfy.example:8188", "--timeout", "5", ok=False)
    assert r.code == 2 and "HTTP 502" in r.err
    assert proxy.requests == ["http://comfy.example:8188/system_stats"]
