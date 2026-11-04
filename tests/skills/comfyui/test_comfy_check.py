"""comfy_check.py against a stand-in ComfyUI (conftest.py) with saved responses."""

from __future__ import annotations

import importlib.util
import inspect
import json
import socket
import sys
import threading
from pathlib import Path
from typing import Any

from PIL import Image
from PIL.PngImagePlugin import PngInfo

SKILL = "comfyui"
SCRIPT = "comfy_check.py"


def txt2img(**changes: Any) -> dict[str, Any]:
    """A plain SDXL text-to-image graph in API format, as File > Export (API) writes it."""
    wf: dict[str, Any] = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"}, "_meta": {"title": "Load Checkpoint"}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": 1024, "height": 1024, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a lighthouse at dusk", "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry", "clip": ["4", 1]}},
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 42, "steps": 25, "cfg": 6.5, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
                "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
            },
        },
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "lighthouse", "images": ["8", 0]}},
    }
    for key, value in changes.items():
        node, _, field = key.partition(".")
        wf[node]["inputs"][field] = value
    return wf


def write(tmp_path: Path, data: Any, name: str = "wf.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def check(run, comfy, path: Path, ok: bool = True):
    result = run(SKILL, SCRIPT, path, "--server", comfy.url, ok=ok)
    return result, result.json()


def test_ready_workflow_reports_nothing_and_only_reads(run, comfy, tmp_path):
    result, report = check(run, comfy, write(tmp_path, txt2img()))
    assert report["ready"] is True
    assert report["format"] == "api"
    assert report["comfyui_version"] == "0.44.0"
    for kind in ("missing_nodes", "missing_models", "missing_embeddings", "missing_inputs", "near_matches", "unknown_values", "problems"):
        assert report[kind] == [], kind
    assert {method for method, _ in comfy.requests} == {"GET"}
    assert comfy.user_agents == {"AthenaAgents/1.0 (comfy_check)"}


def test_missing_checkpoint_names_its_folder(run, comfy, tmp_path):
    result, report = check(run, comfy, write(tmp_path, txt2img(**{"4.ckpt_name": "dreamshaper_8.safetensors"})), ok=False)
    assert result.code == 1
    assert report["ready"] is False
    assert report["missing_models"] == [
        {"node": "4", "class_type": "CheckpointLoaderSimple", "input": "ckpt_name", "name": "dreamshaper_8.safetensors", "folder": "checkpoints"}
    ]


def test_windows_path_on_a_linux_server_is_a_near_match(run, comfy, tmp_path):
    _, report = check(run, comfy, write(tmp_path, txt2img(**{"4.ckpt_name": "SDXL\\juggernaut_xl.safetensors"})), ok=False)
    assert report["missing_models"] == []
    [hit] = report["near_matches"]
    assert hit["server_name"] == "SDXL/juggernaut_xl.safetensors"
    assert hit["node"] == "4"


def test_renamed_model_folders_are_found_on_an_older_server(run, comfy, tmp_path):
    # a server from before the rename lists diffusion models under "unet" only
    comfy.models["unet"] = comfy.models.pop("diffusion_models")
    wf = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-schnell.safetensors", "weight_dtype": "default"}},
    }
    _, report = check(run, comfy, write(tmp_path, wf), ok=False)
    assert [m["name"] for m in report["missing_models"]] == ["flux1-schnell.safetensors"]
    assert report["missing_models"][0]["folder"] == "unet"  # the name this server knows
    assert ("GET", "/models/unet") in comfy.requests


def test_missing_custom_node_gets_its_pack_from_comfyui_manager(run, comfy, tmp_path):
    wf = txt2img()
    wf["10"] = {"class_type": "IPAdapterAdvanced", "inputs": {"weight": 0.8, "model": ["4", 0]}}
    wf["11"] = {"class_type": "ImageResizeKJ", "inputs": {"width": 512}}
    wf["12"] = {"class_type": "Acme_Sharpen", "inputs": {}}
    wf["13"] = {"class_type": "NobodyHasThis", "inputs": {}}
    _, report = check(run, comfy, write(tmp_path, wf), ok=False)
    found = {m["class_type"]: m for m in report["missing_nodes"]}
    assert found["IPAdapterAdvanced"]["provided_by"] == [{"id": "comfyui_ipadapter_plus", "title": "ComfyUI_IPAdapter_plus"}]
    assert found["IPAdapterAdvanced"]["hint_from"] == "comfyui-manager"
    assert len(found["ImageResizeKJ"]["provided_by"]) == 2 and "note" in found["ImageResizeKJ"]
    assert found["Acme_Sharpen"]["provided_by"][0]["id"] == "comfyui-acme"  # by the pack's name pattern
    assert "provided_by" not in found["NobodyHasThis"]


def test_older_manager_route_is_used_and_no_manager_is_said(run, comfy, tmp_path):
    wf = txt2img()
    wf["10"] = {"class_type": "IPAdapterAdvanced", "inputs": {}}
    comfy.manager_v2 = False
    _, report = check(run, comfy, write(tmp_path, wf), ok=False)
    assert report["missing_nodes"][0]["provided_by"][0]["id"] == "comfyui_ipadapter_plus"
    comfy.mappings = None
    _, report = check(run, comfy, write(tmp_path, wf), ok=False)
    assert "provided_by" not in report["missing_nodes"][0]
    assert any("ComfyUI-Manager" in n for n in report["notes"])


def test_embeddings_in_prompt_text(run, comfy, tmp_path):
    text = "a fox, (embedding:styles/watercolor:1.2), soft light\nembedding:EasyNegative.pt, embedding:badhands, notembedding:x"
    _, report = check(run, comfy, write(tmp_path, txt2img(**{"6.text": text})), ok=False)
    assert [e["name"] for e in report["missing_embeddings"]] == ["badhands"]
    assert report["missing_embeddings"][0]["node"] == "6"
    [near] = report["near_matches"]
    assert (near["name"], near["server_name"]) == ("EasyNegative", "easynegative")


def test_embedding_letter_case_only_matters_on_linux(run, comfy, tmp_path):
    comfy.os = "win32"
    _, report = check(run, comfy, write(tmp_path, txt2img(**{"6.text": "a fox, embedding:EasyNegative"})))
    assert report["ready"] is True


def test_input_images_are_looked_up_in_the_input_folder(run, comfy, tmp_path):
    comfy.inputs[("", "photo.png")] = b"png"
    comfy.inputs[("shoot", "face.png")] = b"png"
    wf = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "photo.png"}},
        "2": {"class_type": "LoadImage", "inputs": {"image": "shoot/face.png"}},  # not in the dropdown, but on disk
        "3": {"class_type": "LoadImageMask", "inputs": {"image": "mask.png", "channel": "red"}},
        "4": {"class_type": "LoadVideo", "inputs": {"file": "dance.mp4"}},
    }
    _, report = check(run, comfy, write(tmp_path, wf), ok=False)
    assert [(m["node"], m["name"]) for m in report["missing_inputs"]] == [("3", "mask.png"), ("4", "dance.mp4")]
    assert report["missing_models"] == [] and report["unknown_values"] == []


def test_values_the_server_does_not_offer(run, comfy, tmp_path):
    _, report = check(run, comfy, write(tmp_path, txt2img(**{"3.sampler_name": "res_multistep"})), ok=False)
    [bad] = report["unknown_values"]
    assert (bad["node"], bad["input"], bad["value"]) == ("3", "sampler_name", "res_multistep")
    assert "euler" in bad["choices"]


def test_custom_loader_model_folder_is_worked_out(run, comfy, tmp_path):
    wf = {"1": {"class_type": "IPAdapterModelLoader", "inputs": {"ipadapter_file": "ip-adapter-plus_sdxl_vit-h.safetensors"}}}
    _, report = check(run, comfy, write(tmp_path, wf), ok=False)
    [m] = report["missing_models"]
    assert m["folder"] == "ipadapter"


def test_structural_problems_in_an_api_file(run, comfy, tmp_path):
    wf = txt2img()
    wf["_comment"] = "made by hand"
    wf["8"]["inputs"]["vae"] = ["99", 0]
    wf["20"] = {"class_type": "Reroute", "inputs": {"": ["4", 2]}}
    _, report = check(run, comfy, write(tmp_path, wf), ok=False)
    problems = {p["node"]: p["problem"] for p in report["problems"]}
    assert "not a node" in problems["_comment"]
    assert "99" in problems["8"]
    assert "editor" in problems["20"]
    assert report["missing_nodes"] == []


def test_a_prompt_request_body_and_a_utf16_file(run, comfy, tmp_path):
    path = tmp_path / "body.json"
    # what PowerShell 5.1's > leaves behind
    path.write_bytes(json.dumps({"prompt": txt2img(), "client_id": "abc"}).encode("utf-16"))
    _, report = check(run, comfy, path)
    assert report["ready"] is True and report["format"] == "api"


def test_png_made_by_comfyui(run, comfy, tmp_path):
    info = PngInfo()
    info.add_text("prompt", json.dumps(txt2img(**{"4.ckpt_name": "missing.safetensors"})))
    info.add_text("workflow", json.dumps({"nodes": [], "links": []}))
    path = tmp_path / "ComfyUI_00001_.png"
    Image.new("RGB", (8, 8)).save(path, pnginfo=info)
    _, report = check(run, comfy, path, ok=False)
    assert report["format"] == "api"
    assert report["missing_models"][0]["name"] == "missing.safetensors"


def editor_workflow() -> dict[str, Any]:
    """An editor-format file like a template's: packs and model links recorded on the nodes, one subgraph."""
    sub_id = "3f0e6f8a-1c2d-4e5f-9a8b-7c6d5e4f3a2b"
    return {
        "last_node_id": 30, "last_link_id": 40, "version": 0.4,
        "nodes": [
            {"id": 1, "type": "UNETLoader", "mode": 0, "widgets_values": ["flux1-krea-dev.safetensors", "default"],
             "properties": {"cnr_id": "comfy-core", "ver": "0.3.50", "models": [
                 {"name": "flux1-krea-dev.safetensors", "url": "https://huggingface.co/example/flux1-krea-dev.safetensors", "directory": "diffusion_models"}]}},
            {"id": 2, "type": "DualCLIPLoader", "mode": 0, "widgets_values": ["clip_l.safetensors", "t5xxl_fp16.safetensors", "flux"],
             "properties": {"cnr_id": "comfy-core", "ver": "0.3.50"}},
            {"id": 3, "type": "CLIPTextEncode", "mode": 0, "widgets_values": ["a red bicycle, embedding:badhands"]},
            {"id": 4, "type": "LoadImage", "mode": 0, "widgets_values": ["bike.png", "image"]},
            {"id": 5, "type": "ImageResizeKJ", "mode": 0, "widgets_values": [512, 512], "properties": {"cnr_id": "comfyui-kjnodes", "ver": "1.1.0"}},
            {"id": 6, "type": "Reroute", "mode": 0},
            {"id": 7, "type": "MarkdownNote", "mode": 0, "widgets_values": ["notes"]},
            {"id": 8, "type": "SamplerFancy", "mode": 4, "widgets_values": []},
            {"id": 9, "type": sub_id, "mode": 0, "widgets_values": []},
            {"id": 10, "type": "EasyCache", "mode": 0, "properties": {"cnr_id": "comfy-core", "ver": "0.3.60"}},
        ],
        "links": [],
        "definitions": {"subgraphs": [{"id": sub_id, "name": "Upscale", "nodes": [
            {"id": 1, "type": "UpscaleModelLoader", "mode": 0, "widgets_values": ["4x-Nomos.pth"]},
            {"id": 2, "type": "PixelSharpen", "mode": 0, "properties": {"aux_id": "someone/comfy-sharpen"}},
        ]}]},
    }


def test_editor_format_from_a_template(run, comfy, tmp_path):
    comfy.models["text_encoders"].append("t5xxl_fp16.safetensors")
    _, report = check(run, comfy, write(tmp_path, editor_workflow()), ok=False)
    assert report["format"] == "editor"
    models = {m["name"]: m for m in report["missing_models"]}
    assert set(models) == {"flux1-krea-dev.safetensors", "4x-Nomos.pth"}
    assert models["flux1-krea-dev.safetensors"]["folder"] == "diffusion_models"
    assert models["flux1-krea-dev.safetensors"]["url"].startswith("https://huggingface.co/")
    assert models["4x-Nomos.pth"]["folder"] == "upscale_models"
    assert models["4x-Nomos.pth"]["subgraph"] == "Upscale"
    nodes = {m["class_type"]: m for m in report["missing_nodes"]}
    assert set(nodes) == {"ImageResizeKJ", "EasyCache", "PixelSharpen"}  # not Reroute, notes, the bypassed node or the subgraph
    assert nodes["ImageResizeKJ"]["provided_by"] == [{"id": "comfyui-kjnodes", "version": "1.1.0"}]
    assert nodes["ImageResizeKJ"]["hint_from"] == "workflow"
    assert "update ComfyUI" in nodes["EasyCache"]["provided_by"][0]["note"]
    assert nodes["PixelSharpen"]["provided_by"] == [{"repo": "https://github.com/someone/comfy-sharpen"}]
    assert [m["name"] for m in report["missing_inputs"]] == ["bike.png"]
    assert [e["name"] for e in report["missing_embeddings"]] == ["badhands"]
    assert any("bypassed" in n for n in report["notes"])


def test_no_server_and_bad_files(run, comfy, closed_url, tmp_path):
    result = run(SKILL, SCRIPT, write(tmp_path, txt2img()), "--server", closed_url, ok=False)
    assert result.code == 2 and "No ComfyUI answered" in result.err
    (tmp_path / "notes.json").write_text('{"hello": "world"}', encoding="utf-8")
    result = run(SKILL, SCRIPT, tmp_path / "notes.json", "--server", comfy.url, ok=False)
    assert result.code == 2 and "doesn't look like a ComfyUI workflow" in result.err


def test_only_a_comfyui_counts_and_errors_stay_one_line(run, other_app, tmp_path):
    wf = write(tmp_path, txt2img())
    # a web app on the port answers 200 to everything
    result = run(SKILL, SCRIPT, wf, "--server", other_app.url, ok=False)
    assert result.code == 2 and "not ComfyUI" in result.err
    # something that doesn't speak HTTP at all
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()

        def banner() -> None:
            conn = listener.accept()[0]
            with conn:
                conn.recv(65536)
                conn.sendall(b"SSH-2.0-OpenSSH\r\n")

        threading.Thread(target=banner, daemon=True).start()
        result = run(SKILL, SCRIPT, wf, "--server", f"127.0.0.1:{listener.getsockname()[1]}", ok=False)
    assert result.code == 2 and "No ComfyUI answered" in result.err and "Traceback" not in result.err
    for address in ("file:///etc", "http://127.0.0.1:port", "::1"):
        result = run(SKILL, SCRIPT, wf, "--server", address, ok=False)
        assert result.code == 2 and result.err.startswith("--server takes an address"), address
    result = run(SKILL, SCRIPT, wf, "--server", other_app.url, "--timeout", "0", ok=False)
    assert result.code == 2 and "above 0" in result.err


def test_a_redirect_to_another_host_is_not_followed(run, comfy, other_app, tmp_path):
    other_app.redirect_to = comfy.url.replace("127.0.0.1", "localhost")
    result = run(SKILL, SCRIPT, write(tmp_path, txt2img()), "--server", other_app.url, ok=False)
    assert result.code == 2 and "HTTP 302" in result.err
    assert comfy.requests == []


def test_localhost_is_asked_as_127_0_0_1(run, comfy, tmp_path):
    # on Windows "localhost" is ::1 first, where ComfyUI doesn't listen: each request would wait for that
    result = run(SKILL, SCRIPT, write(tmp_path, txt2img()), "--server", comfy.url.replace("127.0.0.1", "localhost"))
    assert result.json()["server"] == comfy.url


def test_a_workflow_saved_by_set_content(run, comfy, tmp_path):
    # Windows PowerShell 5.1's Set-Content writes the ANSI code page, not UTF-8
    path = tmp_path / "ansi.json"
    path.write_bytes(json.dumps(txt2img(**{"4.ckpt_name": "café.safetensors"}), ensure_ascii=False).encode("cp1252"))
    _, report = check(run, comfy, path, ok=False)
    assert report["missing_models"][0]["name"] == "café.safetensors"
    assert any("isn't UTF-8" in n for n in report["notes"])


def test_custom_loader_folder_ignores_choices_that_are_not_model_files(run, comfy, tmp_path):
    comfy.object_info["AcmeLoader"] = {"input": {"required": {
        "model_file": [["None", "acme-base.safetensors"], {}], "precision": [["fp16", "fp32"], {}]}}}
    comfy.models["acme"] = ["acme-base.safetensors"]
    api = {"1": {"class_type": "AcmeLoader", "inputs": {"model_file": "acme-xl.safetensors", "precision": "fp16"}}}
    editor = {"nodes": [{"id": 1, "type": "AcmeLoader", "mode": 0, "widgets_values": ["acme-xl.safetensors", "fp16"]}], "links": []}
    for wf in (api, editor):
        _, report = check(run, comfy, write(tmp_path, wf), ok=False)
        assert [(m["name"], m.get("folder")) for m in report["missing_models"]] == [("acme-xl.safetensors", "acme")]


def test_help(run):
    assert "Exit status" in run(SKILL, SCRIPT, "--help").out


def load(name: str, monkeypatch):
    """One of the skill's scripts as a module, without writing a __pycache__ into the skill folder."""
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    path = Path(__file__).resolve().parents[3] / "skills" / "athena" / SKILL / "scripts" / name
    spec = importlib.util.spec_from_file_location(name.replace(".py", "_under_test"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_tries_the_usual_addresses_in_turn(comfy, closed_url, monkeypatch):
    module = load(SCRIPT, monkeypatch)
    module.DEFAULT_SERVERS = [closed_url, comfy.url.replace("http://", "")]
    assert module.find_server(None, 5).url == comfy.url


def test_which_addresses_skip_the_system_proxy(monkeypatch):
    check, upload = load("comfy_check.py", monkeypatch), load("comfy_upload.py", monkeypatch)
    assert inspect.getsource(check.direct) == inspect.getsource(upload.direct)  # one rule for both scripts
    local = ["127.0.0.1", "localhost", "::1", "192.168.1.20", "10.0.0.5", "172.16.3.4", "169.254.7.1", "100.101.5.9",
             "fd12:3456::1", "fe80::1", "studio-pc", "studio-pc.local", "STUDIO.LOCAL."]
    beyond = ["8.8.8.8", "2606:4700::1111", "comfy.example.com", "gpu.mycompany.net"]
    for host in local:
        assert check.direct(host), host
    for host in beyond:
        assert not check.direct(host), host


def test_the_system_proxy_is_skipped_for_this_machine_and_the_local_network(run, comfy, proxy, tmp_path):
    wf = write(tmp_path, txt2img())
    assert run(SKILL, SCRIPT, wf, "--server", comfy.url).json()["ready"] is True
    result = run(SKILL, SCRIPT, wf, "--server", "http://192.168.254.254:8188", "--timeout", "1", ok=False)
    assert result.code == 2 and "No ComfyUI answered" in result.err
    assert proxy.requests == []
    result = run(SKILL, SCRIPT, wf, "--server", "http://comfy.example:8188", "--timeout", "5", ok=False)
    assert result.code == 2 and "HTTP 502" in result.err
    assert proxy.requests == ["http://comfy.example:8188/system_stats"]
