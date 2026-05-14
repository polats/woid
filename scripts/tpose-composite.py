#!/usr/bin/env python3
"""Side-by-side composite (avatar | tpose_reference) + right-half crop.

Mirrors the bridge's sharp-based logic in server.js (buildTposeComposite +
cropRightHalf) so local comfy-kontext output matches the cloud path.

Subcommands:
  composite --avatar a.png --reference r.png --out c.png
  crop-right --in result.png --out right.png
"""
import argparse, sys
from PIL import Image

PANEL_W, PANEL_H = 768, 1024
BG = (245, 240, 230)


def fit(img: Image.Image, w: int, h: int) -> Image.Image:
    img = img.convert("RGB")
    img.thumbnail((w, h), Image.LANCZOS)
    canvas = Image.new("RGB", (w, h), BG)
    canvas.paste(img, ((w - img.width) // 2, (h - img.height) // 2))
    return canvas


def composite(avatar_path, ref_path, out_path):
    left = fit(Image.open(avatar_path), PANEL_W, PANEL_H)
    right = fit(Image.open(ref_path), PANEL_W, PANEL_H)
    canvas = Image.new("RGB", (PANEL_W * 2, PANEL_H), BG)
    canvas.paste(left, (0, 0))
    canvas.paste(right, (PANEL_W, 0))
    canvas.save(out_path, "PNG")


def crop_right(in_path, out_path):
    img = Image.open(in_path).convert("RGB")
    w, h = img.size
    img.crop((w // 2, 0, w, h)).save(out_path, "PNG")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("composite")
    c.add_argument("--avatar", required=True)
    c.add_argument("--reference", required=True)
    c.add_argument("--out", required=True)
    r = sub.add_parser("crop-right")
    r.add_argument("--in", dest="inp", required=True)
    r.add_argument("--out", required=True)
    args = ap.parse_args()
    if args.cmd == "composite":
        composite(args.avatar, args.reference, args.out)
    else:
        crop_right(args.inp, args.out)


if __name__ == "__main__":
    sys.exit(main() or 0)
