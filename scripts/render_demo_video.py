#!/usr/bin/env python3
"""Render a terminal-style demo video from a real `examples/demo.mjs` run.

The video is generated from the captured stdout (and the cassette it writes),
so it stays in sync with the actual demo. Frames are drawn with Pillow and
encoded to H.264 with AVFoundation (see encode_frames.swift) — no ffmpeg needed.

Usage:
    python3 scripts/render_demo_video.py
    python3 scripts/render_demo_video.py --preview 1.5,5.5,10.5,15
    python3 scripts/render_demo_video.py --no-encode --keep-frames
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FPS = 30
W, H = 1600, 900
TOTAL = 18.8

MENLO = "/System/Library/Fonts/Menlo.ttc"
EMOJI_FONT = "/System/Library/Fonts/Apple Color Emoji.ttc"

COLORS = {
    "bg0": (7, 10, 19),
    "bg1": (17, 24, 39),
    "text": (230, 237, 243),
    "dim": (139, 148, 158),
    "muted": (101, 110, 122),
    "border": (48, 54, 61),
    "panel": (13, 17, 23),
    "topbar": (22, 27, 34),
    "green": (63, 185, 80),
    "green_dim": (35, 84, 50),
    "cyan": (88, 166, 255),
    "teal": (57, 197, 207),
    "yellow": (210, 153, 34),
    "purple": (188, 140, 255),
    "red": (248, 81, 73),
    "orange": (255, 166, 87),
}

FONT_CACHE: dict[tuple[str, int, int], ImageFont.FreeTypeFont] = {}


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    key = ("menlo", size, 1 if bold else 0)
    if key not in FONT_CACHE:
        FONT_CACHE[key] = ImageFont.truetype(MENLO, size, index=1 if bold else 0)
    return FONT_CACHE[key]


def emoji_font() -> ImageFont.FreeTypeFont:
    key = ("emoji", 48, 0)
    if key not in FONT_CACHE:
        FONT_CACHE[key] = ImageFont.truetype(EMOJI_FONT, 48)
    return FONT_CACHE[key]


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if edge0 == edge1:
        return 1.0 if x >= edge1 else 0.0
    t = clamp((x - edge0) / (edge1 - edge0))
    return t * t * (3 - 2 * t)


def ease_out_cubic(x: float) -> float:
    x = clamp(x)
    return 1 - (1 - x) ** 3


def mix(a, b, t: float):
    t = clamp(t)
    return tuple(round(a[i] * (1 - t) + b[i] * t) for i in range(3))


def alpha(color, a: int):
    return (color[0], color[1], color[2], int(clamp(a, 0, 255)))


EMOJI_RE = re.compile(r"([\U0001F300-\U0001FAFF])")


@lru_cache(maxsize=64)
def emoji_image(char: str, size: int = 20) -> Image.Image:
    canvas = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.text((8, 8), char, font=emoji_font(), embedded_color=True)
    bbox = canvas.getbbox() or (0, 0, 64, 64)
    canvas = canvas.crop(bbox)
    height = max(1, round(canvas.height * size / canvas.width))
    return canvas.resize((size, height), Image.Resampling.LANCZOS)


def draw_runs(
    target: Image.Image,
    x: float,
    y: float,
    runs: list[tuple[str, tuple[int, int, int], bool]],
    size: int = 19,
    line_height: int = 24,
) -> float:
    """Draw colored runs with Menlo, falling back to Apple Color Emoji."""
    draw = ImageDraw.Draw(target)
    for text, color, bold in runs:
        f = font(size, bold)
        for part in EMOJI_RE.split(text):
            if not part:
                continue
            if EMOJI_RE.fullmatch(part):
                image = emoji_image(part, size=20)
                target.alpha_composite(image, (round(x), round(y + (line_height - image.height) / 2)))
                x += image.width + 2
            else:
                draw.text((x, y), part, font=f, fill=color)
                x += f.getlength(part)
    return x


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def make_background() -> Image.Image:
    image = Image.new("RGB", (W, H), COLORS["bg0"])
    pixels = image.load()
    for y in range(H):
        t = y / (H - 1)
        color = mix(COLORS["bg0"], COLORS["bg1"], t)
        for x in range(W):
            pixels[x, y] = color

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-500, -500, 1000, 800), fill=(18, 80, 120, 70))
    gd.ellipse((900, 300, 2100, 1300), fill=(70, 40, 120, 55))
    glow = glow.filter(ImageFilter.GaussianBlur(170))
    image = Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")

    grid = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for x in range(0, W, 48):
        gd.line((x, 0, x, H), fill=(255, 255, 255, 5))
    for y in range(0, H, 48):
        gd.line((0, y, W, y), fill=(255, 255, 255, 5))
    image = Image.alpha_composite(image.convert("RGBA"), grid).convert("RGB")

    # Soft vignette.
    vignette = Image.new("L", (W, H), 0)
    vd = ImageDraw.Draw(vignette)
    vd.ellipse((-W * 0.25, -H * 0.25, W * 1.25, H * 1.25), fill=255)
    vignette = vignette.filter(ImageFilter.GaussianBlur(180))
    black = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    black.putalpha(vignette.point(lambda v: int((255 - v) * 0.55)))
    image = Image.alpha_composite(image.convert("RGBA"), black).convert("RGB")
    return image


BACKGROUND = make_background()

# Terminal geometry.
TX, TY, TW, TH = 80, 118, 1440, 712
TITLE_H = 54
PAD_X = 40
TEXT_Y = TY + TITLE_H + 20
LINE_H = 24
TEXT_SIZE = 19
TIMELINE_Y = TY + TH - 70


def make_chrome() -> Image.Image:
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    rounded(sd, (TX - 6, TY + 18, TX + TW + 6, TY + TH + 24), 24, fill=(0, 0, 0, 190))
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    layer = Image.alpha_composite(layer, shadow)

    draw = ImageDraw.Draw(layer)
    rounded(draw, (TX, TY, TX + TW, TY + TH), 18, fill=alpha(COLORS["panel"], 255), outline=alpha(COLORS["border"], 255), width=1)
    # Title bar: rounded top, square bottom.
    rounded(draw, (TX, TY, TX + TW, TY + TITLE_H), 18, fill=alpha(COLORS["topbar"], 255))
    draw.rectangle((TX, TY + TITLE_H - 20, TX + TW, TY + TITLE_H), fill=alpha(COLORS["topbar"], 255))
    draw.line((TX, TY + TITLE_H, TX + TW, TY + TITLE_H), fill=alpha(COLORS["border"], 255), width=1)
    draw.line((TX + 18, TY + 1, TX + TW - 18, TY + 1), fill=(255, 255, 255, 14), width=1)

    for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = TX + 26 + i * 22
        draw.ellipse((cx - 6, TY + 21, cx + 6, TY + 33), fill=alpha(color, 235))

    draw.text((TX + 96, TY + 19), "llm-vcr — demo", font=font(15), fill=COLORS["dim"])

    # Header above the window.
    draw.text((TX, 42), "llm-vcr", font=font(24, True), fill=COLORS["text"])
    draw.text((TX + 116, 48), "record & replay for any LLM SDK", font=font(14), fill=COLORS["dim"])
    draw.line((TX, 80, TX + 46, 80), fill=alpha(COLORS["green"], 180), width=2)
    return layer


CHROME = make_chrome()


def draw_header(draw: ImageDraw.ImageDraw):
    draw.text((TX + TW - 238, 48), "streaming included", font=font(13), fill=COLORS["muted"])


def draw_status(layer: Image.Image, t: float):
    draw = ImageDraw.Draw(layer)
    online = t < 7.55
    color = COLORS["green"] if online else COLORS["muted"]
    fill = (18, 42, 30, 255) if online else (28, 31, 38, 255)
    x1 = TX + TW - 32
    x0 = x1 - 188
    y0 = TY + 12
    rounded(draw, (x0, y0, x1, y0 + 30), 15, fill=fill, outline=alpha(color, 180), width=1)
    draw.ellipse((x0 + 14, y0 + 11, x0 + 22, y0 + 19), fill=color)
    draw.text((x0 + 31, y0 + 6), "NETWORK ON" if online else "NETWORK OFF", font=font(12, True), fill=color)
    if not online:
        draw.line((x0 + 150, y0 + 10, x0 + 170, y0 + 20), fill=alpha(COLORS["red"], 190), width=2)


def draw_toast(layer: Image.Image, t: float):
    if t < 7.55 or t > 8.9:
        return
    alpha_t = smoothstep(7.55, 7.7, t) * (1 - smoothstep(8.5, 8.9, t))
    toast = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(toast)
    x1, y0 = TX + TW - 40, TY + 66
    x0 = x1 - 350
    rounded(draw, (x0, y0, x1, y0 + 46), 12, fill=(47, 20, 24, 245), outline=alpha(COLORS["red"], 200), width=1)
    draw.text((x0 + 18, y0 + 13), "× upstream stopped", font=font(15, True), fill=COLORS["red"])
    draw.text((x0 + 190, y0 + 14), "replaying from cassette", font=font(13), fill=COLORS["dim"])
    toast.putalpha(toast.getchannel("A").point(lambda v: int(v * alpha_t)))
    layer.alpha_composite(toast)


def body_x() -> int:
    return TX + PAD_X


def line_y(index: int) -> int:
    return TEXT_Y + index * LINE_H


def parse_demo() -> dict:
    node = os.environ.get("NODE_BIN") or shutil.which("node")
    if not node:
        raise SystemExit("node not found; set NODE_BIN=/path/to/node")
    proc = subprocess.run(
        [node, str(ROOT / "examples/demo.mjs")],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        raise SystemExit("demo failed")
    output = proc.stdout
    lines = output.splitlines()

    upstream = re.search(r"fake upstream (http://\S+) is running", output)
    cassette = re.search(r"cassette\s+(\S+\.json)", output)
    record_text = output.split("● REC", 1)[1].split("cassette", 1)[0]
    replay_text = output.split("○ PLAY", 1)[1].split("stream matched", 1)[0]
    record_tokens = re.findall(r"^\s+(\d+)ms\s+(.+)$", record_text, re.M)
    replay_tokens = re.findall(r"^\s+(\d+)ms\s+(.+)$", replay_text, re.M)
    response_line = next((line.strip() for line in lines if line.strip().startswith("response")), "")
    match_line = next((line.strip() for line in lines if "stream matched" in line), "")
    text_line = next((line.strip() for line in lines if line.strip().startswith("text")), "")
    next_line = next((line.strip() for line in lines if line.strip().startswith("npx ")), "")
    if not (upstream and cassette and record_tokens and replay_tokens):
        raise SystemExit("could not parse demo output:\n" + output)

    cassette_path = ROOT / cassette.group(1)
    data = json.loads(cassette_path.read_text(encoding="utf8"))
    stream = data["response"]["stream"]
    chunks = [int(chunk.get("at", 0)) for chunk in stream["chunks"]]
    return {
        "output": output,
        "upstream": upstream.group(1),
        "cassette": cassette.group(1),
        "record_tokens": record_tokens,
        "replay_tokens": replay_tokens,
        "response_line": response_line,
        "match_line": match_line,
        "text_line": text_line,
        "next_line": next_line,
        "chunks": chunks,
        "ttfb": int(stream.get("ttfbMs", 0)),
        "duration": int(stream.get("durationMs", 1)),
        "cassette_data": data,
    }


def build_scene(data: dict) -> dict:
    # All timings in seconds.
    intro_end = 2.5
    type_start = 2.9
    type_dur = 0.7
    enter = 3.62
    out0 = 3.82
    token0 = out0 + 0.85
    step = 0.30
    record_token_at = [token0 + i * step for i in range(len(data["record_tokens"]))]
    cassette_at = record_token_at[-1] + 0.28
    request_at = cassette_at + 0.18
    response_at = request_at + 0.18
    offline = response_at + 0.72
    play_at = offline + 0.42
    play_token_at = [play_at + 0.30 + i * 0.28 for i in range(len(data["replay_tokens"]))]
    match_at = play_token_at[-1] + 0.32
    text_at = match_at + 0.20
    next_at = text_at + 0.48
    end_start = next_at + 1.52
    end_full = end_start + 0.75
    intro_full = 0.55

    lines = []
    lines.append(
        {
            "at": out0,
            "runs": [
                ("llm-vcr demo", COLORS["text"], True),
                ("  —  no API key, no network", COLORS["dim"], False),
            ],
        }
    )
    lines.append(
        {
            "at": out0 + 0.24,
            "runs": [
                ("● ", COLORS["green"], True),
                ("fake upstream ", COLORS["dim"], False),
                (data["upstream"], COLORS["teal"], False),
                (" is running", COLORS["dim"], False),
            ],
        }
    )
    lines.append(
        {
            "at": out0 + 0.47,
            "runs": [
                ("● REC ", COLORS["green"], True),
                ("calling the model for real…", COLORS["text"], False),
            ],
        }
    )
    for (ms, token), at in zip(data["record_tokens"], record_token_at):
        lines.append(
            {
                "at": at,
                "runs": [
                    (f"{int(ms):>7}ms  ", COLORS["muted"], False),
                    (token, COLORS["yellow"], False),
                ],
            }
        )
    lines.append(
        {
            "at": cassette_at,
            "runs": [
                ("  cassette  ", COLORS["muted"], False),
                (data["cassette"], COLORS["purple"], False),
            ],
        }
    )
    lines.append(
        {
            "at": request_at,
            "runs": [
                ("  request   ", COLORS["muted"], False),
                ("POST ", COLORS["teal"], True),
                ("/v1/chat/completions", COLORS["text"], False),
                ("  (model fake-model)", COLORS["dim"], False),
            ],
        }
    )
    meta_runs = [
        ("  response  ", COLORS["muted"], False),
        ("200", COLORS["green"], True),
        (f" · {len(data['chunks'])} chunks · ttfb {data['ttfb']}ms · total {data['duration']}ms", COLORS["dim"], False),
    ]
    lines.append({"at": response_at, "runs": meta_runs})
    lines.append(
        {
            "at": play_at,
            "runs": [
                ("○ PLAY ", COLORS["cyan"], True),
                ("upstream is down  ·  offline at 1×…", COLORS["text"], False),
            ],
        }
    )
    for (ms, token), at in zip(data["replay_tokens"], play_token_at):
        lines.append(
            {
                "at": at,
                "runs": [
                    (f"{int(ms):>7}ms  ", COLORS["muted"], False),
                    (token, COLORS["teal"], False),
                ],
            }
        )
    lines.append(
        {
            "at": match_at,
            "runs": [
                ("  ✓ ", COLORS["green"], True),
                ("stream matched", COLORS["green"], False),
                (f" · {int(data['cassette_data']['meta']['chunks'])} chunks in {data['duration']}ms", COLORS["dim"], False),
            ],
        }
    )
    lines.append(
        {
            "at": text_at,
            "runs": [
                ("  text      ", COLORS["muted"], False),
                (data["text_line"].split("text", 1)[1].strip(), COLORS["text"], True),
            ],
        }
    )
    lines.append(
        {
            "at": next_at,
            "runs": [
                ("  next      ", COLORS["muted"], False),
                (data["next_line"], COLORS["cyan"], False),
            ],
        }
    )

    return {
        "intro_end": intro_end,
        "intro_full": intro_full,
        "type_start": type_start,
        "type_dur": type_dur,
        "enter": enter,
        "out0": out0,
        "lines": lines,
        "record_token_at": record_token_at,
        "cassette_at": cassette_at,
        "response_at": response_at,
        "offline": offline,
        "play_at": play_at,
        "play_token_at": play_token_at,
        "match_at": match_at,
        "text_at": text_at,
        "next_at": next_at,
        "end_start": end_start,
        "end_full": end_full,
    }


BADGES = ["ANY LANGUAGE", "SSE TIMING", "OFFLINE CI"]


def draw_intro(frame: Image.Image, t: float):
    alpha_in = smoothstep(0.05, 0.75, t) * (1 - smoothstep(2.18, 2.5, t))
    if alpha_in <= 0:
        return frame
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    draw.text((W / 2, 150), "LOCAL HTTP PROXY", font=font(14, True), fill=(*COLORS["muted"], 255), anchor="mm")
    draw.text((W / 2, 280), "llm-vcr", font=font(96, True), fill=COLORS["text"], anchor="mm")
    accent = 430 * ease_out_cubic((t - 0.5) / 0.9)
    if accent > 0:
        draw.rounded_rectangle(
            (W / 2 - accent / 2, 352, W / 2 + accent / 2, 357),
            radius=2,
            fill=COLORS["green"],
        )
    draw.text((W / 2, 408), "Record once. Replay forever.", font=font(30), fill=COLORS["text"], anchor="mm")
    draw.text(
        (W / 2, 452),
        "Any SDK. Any language. Streaming included.",
        font=font(18),
        fill=COLORS["dim"],
        anchor="mm",
    )

    if t > 1.1:
        ba = smoothstep(1.1, 1.35, t)
        widths = [font(13, True).getlength(b) + 36 for b in BADGES]
        gap = 14
        total = sum(widths) + gap * (len(BADGES) - 1)
        x = W / 2 - total / 2
        for label, width in zip(BADGES, widths):
            color = COLORS["green"] if label == "ANY LANGUAGE" else COLORS["cyan"] if label == "SSE TIMING" else COLORS["purple"]
            rounded(draw, (x, 520, x + width, 554), 17, fill=(*COLORS["panel"], 220), outline=(*color, 120), width=1)
            draw.text((x + width / 2, 537), label, font=font(13, True), fill=(*color, 255), anchor="mm")
            x += width + gap

    draw.text((W / 2, 640), "npm i -D llm-vcr-proxy", font=font(17), fill=COLORS["dim"], anchor="mm")
    draw.text((W / 2, 672), "Node 18.17+  ·  zero runtime dependencies", font=font(13), fill=COLORS["muted"], anchor="mm")

    layer.putalpha(layer.getchannel("A").point(lambda v: int(v * alpha_in)))
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


def draw_prompt(layer: Image.Image, t: float, scene: dict):
    typed_count = int(len("npm run demo") * clamp((t - scene["type_start"]) / scene["type_dur"]))
    command = "npm run demo"[:typed_count]
    cursor = "▌" if (t < scene["enter"] and int(t * 2) % 2 == 0) or t >= scene["enter"] else " "
    draw = ImageDraw.Draw(layer)
    x = body_x()
    y = line_y(0)
    x = draw_runs(layer, x, y, [("$ ", COLORS["green"], True), (command, COLORS["text"], False)])
    if t < scene["enter"]:
        draw.text((x, y), cursor, font=font(TEXT_SIZE), fill=COLORS["cyan"])


def draw_terminal(frame: Image.Image, t: float, scene: dict, data: dict) -> Image.Image:
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    layer.alpha_composite(CHROME)
    draw_header(ImageDraw.Draw(layer))
    draw_status(layer, t)
    draw_toast(layer, t)
    draw_prompt(layer, t, scene)

    draw = ImageDraw.Draw(layer)
    for index, line in enumerate(scene["lines"], start=1):
        if t < line["at"]:
            continue
        line_alpha = smoothstep(line["at"], line["at"] + 0.12, t)
        if line_alpha <= 0:
            continue
        run_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        draw_runs(run_layer, body_x(), line_y(index), line["runs"])
        if line_alpha < 1:
            run_layer.putalpha(run_layer.getchannel("A").point(lambda v: int(v * line_alpha)))
        layer.alpha_composite(run_layer)

    draw_timeline(layer, t, scene, data)
    draw_footer(layer)

    # Soft fade when the end card arrives.
    fade = 1 - smoothstep(scene["end_start"], scene["end_start"] + 0.35, t)
    if fade < 1:
        layer.putalpha(layer.getchannel("A").point(lambda v: int(v * fade)))
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


def draw_timeline(layer: Image.Image, t: float, scene: dict, data: dict):
    draw = ImageDraw.Draw(layer)
    x0 = body_x() + 100
    x1 = TX + TW - PAD_X - 16
    y_rec = TIMELINE_Y + 19
    y_play = TIMELINE_Y + 37
    width = x1 - x0

    draw.text((body_x(), TIMELINE_Y + 2), "SSE TIMELINE", font=font(11, True), fill=COLORS["muted"])
    draw.text((x1, TIMELINE_Y + 2), f"{len(data['chunks'])} chunks · {data['duration']}ms", font=font(11), fill=COLORS["muted"], anchor="ra")
    draw.text((body_x(), y_rec - 8), "REC", font=font(10, True), fill=COLORS["green_dim"])
    draw.text((body_x(), y_play - 8), "PLAY", font=font(10, True), fill=COLORS["muted"])

    for y in (y_rec, y_play):
        draw.line((x0, y + 8, x1, y + 8), fill=(255, 255, 255, 18), width=1)

    duration = max(data["duration"], max(data["chunks"] or [1]), 1)
    positions = [x0 + int(width * min(1.0, at / duration)) for at in data["chunks"]]
    rec_visible = t >= scene["response_at"]
    if rec_visible:
        for x in positions:
            draw.rounded_rectangle((x, y_rec, x + 3, y_rec + 16), radius=1, fill=COLORS["green"])
        tx = x0 + int(width * min(1.0, data["ttfb"] / duration))
        draw.line((tx, y_rec - 3, tx, y_rec + 18), fill=(63, 185, 80, 110), width=1)

    if t >= scene["play_at"]:
        progress = clamp((t - scene["play_at"]) / max(0.2, scene["match_at"] - scene["play_at"]))
        for x in positions:
            if (x - x0) / width <= progress:
                draw.rounded_rectangle((x, y_play, x + 3, y_play + 16), radius=1, fill=COLORS["teal"])
        if progress >= 1:
            draw.text((x1, y_play + 19), "✓ byte-identical", font=font(10, True), fill=COLORS["green"], anchor="ra")


def draw_footer(layer: Image.Image):
    draw = ImageDraw.Draw(layer)
    draw.text((TX, TY + TH + 20), "npx llm-vcr-proxy run --mode replay -- npm test", font=font(13), fill=COLORS["muted"])
    draw.text((TX + TW, TY + TH + 20), "cassettes are plain JSON", font=font(13), fill=COLORS["muted"], anchor="ra")


def draw_end(frame: Image.Image, t: float, scene: dict, data: dict) -> Image.Image:
    alpha_in = smoothstep(scene["end_start"], scene["end_full"], t)
    if alpha_in <= 0:
        return frame
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.rectangle((0, 0, W, H), fill=(*COLORS["bg0"], 255))
    # Subtle glow.
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((200, 20, 1400, 760), fill=(20, 80, 100, 60))
    glow = glow.filter(ImageFilter.GaussianBlur(160))
    layer.alpha_composite(glow)

    draw = ImageDraw.Draw(layer)
    draw.text((100, 70), "llm-vcr", font=font(26, True), fill=COLORS["text"])
    draw.text((238, 76), "record & replay for any LLM SDK", font=font(14), fill=COLORS["dim"])
    draw.line((100, 112, 150, 112), fill=COLORS["green"], width=2)

    draw.text((100, 205), "Record once.", font=font(64, True), fill=COLORS["text"])
    draw.text((100, 285), "Replay forever.", font=font(64, True), fill=COLORS["green"])

    cards = [
        ("RECORD", COLORS["green"], "npx llm-vcr-proxy run --mode record -- npm test"),
        ("REPLAY", COLORS["cyan"], "npx llm-vcr-proxy run --mode replay -- npm test"),
    ]
    for index, (label, color, command) in enumerate(cards):
        y = 440 + index * 86
        reveal = smoothstep(scene["end_start"] + 0.2 + index * 0.12, scene["end_full"] + index * 0.12, t)
        if reveal <= 0:
            continue
        card = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        cd = ImageDraw.Draw(card)
        rounded(cd, (100, y, 1480, y + 68), 14, fill=(*COLORS["panel"], 245), outline=(*COLORS["border"], 255), width=1)
        rounded(cd, (122, y + 17, 236, y + 51), 17, fill=(*color, 18), outline=(*color, 100), width=1)
        cd.text((179, y + 26), label, font=font(12, True), fill=(*color, 255), anchor="ma")
        cd.text((268, y + 23), command, font=font(19), fill=COLORS["text"])
        card.putalpha(card.getchannel("A").point(lambda v: int(v * reveal)))
        layer.alpha_composite(card)

    draw.text((100, 645), "Any SDK  ·  any language  ·  streaming chunk timing preserved", font=font(18), fill=COLORS["dim"])
    draw.text((100, 705), "npm i -D llm-vcr-proxy", font=font(17, True), fill=COLORS["text"])
    draw.text((380, 710), "Node 18.17+  ·  no runtime dependencies", font=font(14), fill=COLORS["muted"])

    rounded(draw, (100, 775, 330, 809), 17, fill=(*COLORS["green"], 18), outline=(*COLORS["green"], 80), width=1)
    draw.text((215, 792), "v0.1.0 · MIT", font=font(12, True), fill=COLORS["green"], anchor="mm")
    draw.text((1470, 792), "npmjs.com/package/llm-vcr-proxy", font=font(12), fill=COLORS["muted"], anchor="ra")

    layer.putalpha(layer.getchannel("A").point(lambda v: int(v * alpha_in)))
    return Image.alpha_composite(frame.convert("RGBA"), layer).convert("RGB")


def render_frame(t: float, scene: dict, data: dict) -> Image.Image:
    frame = BACKGROUND.copy()
    if t < 2.5:
        frame = draw_intro(frame, t)
    elif t < scene["end_start"]:
        frame = draw_terminal(frame, t, scene, data)
    elif t < scene["end_full"]:
        frame = draw_end(draw_terminal(frame, t, scene, data), t, scene, data)
    else:
        frame = draw_end(frame, t, scene, data)
    fade_out = smoothstep(TOTAL - 0.55, TOTAL - 0.02, t)
    if fade_out > 0:
        black = Image.new("RGBA", (W, H), (0, 0, 0, int(255 * fade_out)))
        frame = Image.alpha_composite(frame.convert("RGBA"), black).convert("RGB")
    return frame


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default=str(ROOT / "demo/llm-vcr-demo.mp4"))
    parser.add_argument("--fps", type=int, default=FPS)
    parser.add_argument("--preview", help="comma-separated timestamps to render as PNGs")
    parser.add_argument("--no-encode", action="store_true")
    parser.add_argument("--poster-only", action="store_true")
    parser.add_argument("--keep-frames", action="store_true")
    parser.add_argument("--frames-dir", default=None)
    args = parser.parse_args()

    data = parse_demo()
    scene = build_scene(data)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    frames_dir = Path(args.frames_dir or tempfile.mkdtemp(prefix="llm-vcr-frames-"))
    frames_dir.mkdir(parents=True, exist_ok=True)

    if args.poster_only:
        poster_t = scene["next_at"] + 0.45
        poster = render_frame(poster_t, scene, data)
        path = out.with_name("llm-vcr-demo-poster.png")
        poster.save(path)
        print(path)
        return 0

    if args.preview:
        for item in args.preview.split(","):
            t = float(item)
            frame = render_frame(t, scene, data)
            path = frames_dir / f"preview-{t:05.2f}.png"
            frame.save(path)
            print(path)
        print(f"preview in {frames_dir}")
        return 0

    total_frames = int(round(TOTAL * args.fps))
    for index in range(total_frames):
        t = index / args.fps
        frame = render_frame(t, scene, data)
        frame.save(frames_dir / f"frame-{index:06d}.png", compress_level=1)
        if index % 60 == 0:
            print(f"frame {index}/{total_frames}", flush=True)

    poster_t = scene["next_at"] + 0.45
    render_frame(poster_t, scene, data).save(out.with_name("llm-vcr-demo-poster.png"))

    if args.no_encode:
        print(f"frames in {frames_dir}")
        return 0

    swift = shutil.which("swift")
    if not swift:
        raise SystemExit("swift not found; install Xcode command line tools")
    subprocess.run(
        [swift, str(ROOT / "scripts/encode_frames.swift"), str(frames_dir), str(out), str(args.fps)],
        check=True,
    )
    if not args.keep_frames:
        shutil.rmtree(frames_dir, ignore_errors=True)
    size = out.stat().st_size
    print(f"video: {out} ({size / 1024 / 1024:.1f} MB)")
    print(f"poster: {out.with_name('llm-vcr-demo-poster.png')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
