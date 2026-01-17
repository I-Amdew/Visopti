#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from ultralytics import YOLO
except ImportError:
    YOLO = None

from PIL import Image

from utils.yolo_labels import (
    CLASS_NAME_TO_ID,
    NEGATIVE_CLASS,
    format_yolo_labels,
    sample_to_boxes,
)

ALLOWED_IMAGE_EXTS = [".png", ".jpg", ".jpeg"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Train the tree/sign detector and export ONNX.")
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--model", type=str, default="yolov8n.pt")
    parser.add_argument("--device", type=str, default=None)
    parser.add_argument("--opset", type=int, default=12)
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def find_image_path(sample_id: str, images_dir: Path) -> Path | None:
    for ext in ALLOWED_IMAGE_EXTS:
        candidate = images_dir / f"{sample_id}{ext}"
        if candidate.exists():
            return candidate
    return None


def clear_directory(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def link_or_copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def build_yolo_labels(labels_json_dir: Path, images_dir: Path, labels_yolo_dir: Path) -> list[str]:
    labels_yolo_dir.mkdir(parents=True, exist_ok=True)
    for txt_path in labels_yolo_dir.glob("*.txt"):
        txt_path.unlink()

    sample_ids: list[str] = []
    for label_path in sorted(labels_json_dir.glob("*.json")):
        sample_id = label_path.stem
        image_path = find_image_path(sample_id, images_dir)
        if not image_path:
            print(f"[warn] Missing image for sample {sample_id}")
            continue

        try:
            with label_path.open("r", encoding="utf-8") as handle:
                sample = json.load(handle)
        except json.JSONDecodeError:
            print(f"[warn] Invalid JSON: {label_path}")
            continue

        try:
            with Image.open(image_path) as image:
                width, height = image.size
        except OSError:
            print(f"[warn] Unable to read image {image_path}")
            continue

        class_name = sample.get("class")
        if class_name not in CLASS_NAME_TO_ID and class_name != NEGATIVE_CLASS:
            continue

        boxes = sample_to_boxes(sample, width, height)
        lines = format_yolo_labels(boxes)

        label_out = labels_yolo_dir / f"{sample_id}.txt"
        label_out.write_text("\n".join(lines), encoding="utf-8")
        sample_ids.append(sample_id)

    return sample_ids


def build_yolo_dataset(dataset_root: Path, labels_yolo_dir: Path, images_dir: Path) -> Path:
    yolo_root = dataset_root / "yolo"
    yolo_images = yolo_root / "images" / "train"
    yolo_labels = yolo_root / "labels" / "train"

    clear_directory(yolo_root)
    yolo_images.mkdir(parents=True, exist_ok=True)
    yolo_labels.mkdir(parents=True, exist_ok=True)

    for label_path in sorted(labels_yolo_dir.glob("*.txt")):
        sample_id = label_path.stem
        image_path = find_image_path(sample_id, images_dir)
        if not image_path:
            continue
        link_or_copy(image_path, yolo_images / image_path.name)
        link_or_copy(label_path, yolo_labels / label_path.name)

    data_yaml = yolo_root / "data.yaml"
    names_yaml = "\n".join(
        [f"  {class_id}: {name}" for name, class_id in CLASS_NAME_TO_ID.items()]
    )
    data_yaml.write_text(
        "\n".join(
            [
                f"path: {yolo_root}",
                "train: images/train",
                "val: images/train",
                "names:",
                names_yaml,
            ]
        ),
        encoding="utf-8",
    )

    return data_yaml


def resolve_weights_dir(train_result) -> Path | None:
    if train_result is None:
        return None
    save_dir = getattr(train_result, "save_dir", None)
    if save_dir is None:
        return None
    return Path(save_dir) / "weights"


def find_exported_onnx(export_result, fallback_dir: Path) -> Path | None:
    if isinstance(export_result, (str, Path)):
        candidate = Path(export_result)
        if candidate.exists():
            return candidate
    if isinstance(export_result, dict):
        value = export_result.get("onnx")
        if isinstance(value, (str, Path)) and Path(value).exists():
            return Path(value)
    candidates = list(fallback_dir.glob("*.onnx"))
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def file_sha256(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def resolve_git_sha(root: Path) -> str | None:
    try:
        output = subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=root)
        return output.decode("utf-8").strip()
    except Exception:
        return None


def main() -> int:
    args = parse_args()

    if YOLO is None:
        print("[error] ultralytics is not installed. Run: pip install -r ml/requirements.txt")
        return 1

    root = repo_root()
    dataset_root = root / "ml" / "datasets" / "active"
    images_dir = dataset_root / "images"
    labels_json_dir = dataset_root / "labels"
    labels_yolo_dir = dataset_root / "labels_yolo"

    if not images_dir.exists():
        print(f"[error] Missing images dir: {images_dir}")
        return 1

    if labels_json_dir.exists():
        sample_ids = build_yolo_labels(labels_json_dir, images_dir, labels_yolo_dir)
    elif labels_yolo_dir.exists():
        sample_ids = [path.stem for path in labels_yolo_dir.glob("*.txt")]
    else:
        print("[error] Missing labels. Expected labels JSON or labels_yolo directory.")
        return 1

    if not sample_ids:
        print("[error] No labeled samples found to train on.")
        return 1

    data_yaml = build_yolo_dataset(dataset_root, labels_yolo_dir, images_dir)

    models_dir = root / "ml" / "models" / "treesigns"
    models_dir.mkdir(parents=True, exist_ok=True)

    train_kwargs = {
        "data": str(data_yaml),
        "imgsz": args.imgsz,
        "epochs": args.epochs,
        "batch": args.batch,
        "project": str(models_dir),
        "name": "train",
        "exist_ok": True,
    }
    if args.device:
        train_kwargs["device"] = args.device

    model = YOLO(args.model)
    train_result = model.train(**train_kwargs)

    weights_dir = resolve_weights_dir(train_result)
    if not weights_dir:
        print("[error] Unable to locate trained weights.")
        return 1

    best_path = weights_dir / "best.pt"
    last_path = weights_dir / "last.pt"
    source_pt = best_path if best_path.exists() else last_path
    if not source_pt.exists():
        print("[error] No trained weights found in weights directory.")
        return 1

    latest_pt = models_dir / "latest.pt"
    shutil.copy2(source_pt, latest_pt)

    export_model = YOLO(str(latest_pt))
    export_result = export_model.export(format="onnx", imgsz=args.imgsz, opset=args.opset)
    onnx_path = find_exported_onnx(export_result, latest_pt.parent)
    if not onnx_path:
        print("[error] ONNX export failed.")
        return 1

    public_models = root / "public" / "models" / "treesigns"
    public_models.mkdir(parents=True, exist_ok=True)
    latest_onnx = public_models / "latest.onnx"
    shutil.copy2(onnx_path, latest_onnx)

    exported_at = dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    version = resolve_git_sha(root) or exported_at
    manifest = {
        "model": "treesigns",
        "version": version,
        "classes": list(CLASS_NAME_TO_ID.keys()),
        "input": {"width": args.imgsz, "height": args.imgsz},
        "exportedAt": exported_at,
        "sha256": file_sha256(latest_onnx),
    }
    (public_models / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    print(f"[ok] Wrote {latest_pt}")
    print(f"[ok] Wrote {latest_onnx}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
