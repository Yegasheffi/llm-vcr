# Demo video

- `llm-vcr-demo.mp4` — 1600×900, 30 fps, 18.8 s, H.264. A terminal-style demo rendered from a real `examples/demo.mjs` run: record a streaming completion, stop the fake upstream, then replay the same cassette offline at 1×.
- `llm-vcr-demo-poster.png` — 1600×900 poster frame.

Regenerate with:

```bash
NODE_BIN=/path/to/node python3 scripts/render_demo_video.py
```

The renderer uses Pillow for frames and `scripts/encode_frames.swift` + AVFoundation for H.264 encoding, so it works without ffmpeg. It prints preview frames with `--preview 1.2,5,10.5,15`.
