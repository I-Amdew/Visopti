from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

CLASS_NAME_TO_ID = {
    "tree_deciduous": 0,
    "tree_pine": 1,
    "billboard": 2,
    "stop_sign": 3,
}

IGNORED_CLASSES = {"dense_cover"}
NEGATIVE_CLASS = "negative"


@dataclass(frozen=True)
class YoloBox:
    class_id: int
    x_center: float
    y_center: float
    width: float
    height: float


def clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def normalize_box(
    x0: float, y0: float, x1: float, y1: float, width: int, height: int
) -> tuple[float, float, float, float] | None:
    x0 = clamp(x0, 0, width)
    x1 = clamp(x1, 0, width)
    y0 = clamp(y0, 0, height)
    y1 = clamp(y1, 0, height)

    box_w = x1 - x0
    box_h = y1 - y0
    if box_w <= 1 or box_h <= 1:
        return None

    x_center = (x0 + x1) / 2
    y_center = (y0 + y1) / 2
    return x_center, y_center, box_w, box_h


def sample_to_boxes(sample: dict, width: int, height: int) -> list[YoloBox]:
    class_name = sample.get("class")
    if class_name in IGNORED_CLASSES or class_name is None:
        return []
    if class_name == NEGATIVE_CLASS:
        return []

    class_id = CLASS_NAME_TO_ID.get(class_name)
    if class_id is None:
        return []

    annotations = sample.get("annotations")
    if not isinstance(annotations, list):
        return []

    boxes: list[YoloBox] = []
    for annotation in annotations:
        if not isinstance(annotation, dict):
            continue
        kind = annotation.get("kind")
        if kind == "circle":
            center = annotation.get("centerPx")
            radius = annotation.get("radiusPx")
            if not isinstance(center, dict) or not isinstance(radius, (int, float)):
                continue
            cx = center.get("x")
            cy = center.get("y")
            if not isinstance(cx, (int, float)) or not isinstance(cy, (int, float)):
                continue
            raw = normalize_box(cx - radius, cy - radius, cx + radius, cy + radius, width, height)
        elif kind == "bbox":
            x = annotation.get("x")
            y = annotation.get("y")
            w = annotation.get("width")
            h = annotation.get("height")
            if not all(isinstance(value, (int, float)) for value in (x, y, w, h)):
                continue
            raw = normalize_box(x, y, x + w, y + h, width, height)
        else:
            continue

        if raw is None:
            continue

        x_center, y_center, box_w, box_h = raw
        boxes.append(
            YoloBox(
                class_id=class_id,
                x_center=x_center / width,
                y_center=y_center / height,
                width=box_w / width,
                height=box_h / height,
            )
        )

    return boxes


def format_yolo_labels(boxes: Iterable[YoloBox]) -> list[str]:
    lines = []
    for box in boxes:
        lines.append(
            f"{box.class_id} {box.x_center:.6f} {box.y_center:.6f} {box.width:.6f} {box.height:.6f}"
        )
    return lines
