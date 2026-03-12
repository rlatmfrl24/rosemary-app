"""Generate Rosemary app icons.

Requires:
	python -m pip install Pillow
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD_DIR = ROOT / "build"
RESOURCES_DIR = ROOT / "resources"
MASTER_SIZE = 1024
PNG_SIZE = 512


def solid_image(size: int, color: tuple[int, int, int, int]) -> Image.Image:
	return Image.new("RGBA", (size, size), color)


def diagonal_mask(size: int, angle: float) -> Image.Image:
	mask = Image.linear_gradient("L")
	mask = mask.resize((size * 3, size * 3), Image.Resampling.BICUBIC)
	mask = mask.rotate(angle, expand=False, resample=Image.Resampling.BICUBIC)
	offset = size
	return mask.crop((offset, offset, offset + size, offset + size))


def background(size: int) -> Image.Image:
	base = solid_image(size, (18, 49, 39, 255))
	top = solid_image(size, (40, 86, 67, 255))
	mask = diagonal_mask(size, 38)
	gradient = Image.composite(top, base, mask)

	glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
	glow_draw = ImageDraw.Draw(glow)
	glow_draw.ellipse(
		(size * 0.52, size * 0.04, size * 1.02, size * 0.66),
		fill=(123, 171, 146, 110),
	)
	glow = glow.filter(ImageFilter.GaussianBlur(size // 11))
	gradient.alpha_composite(glow)

	depth = Image.new("RGBA", (size, size), (0, 0, 0, 0))
	depth_draw = ImageDraw.Draw(depth)
	depth_draw.ellipse(
		(-size * 0.08, size * 0.58, size * 0.68, size * 1.18),
		fill=(6, 17, 14, 90),
	)
	depth = depth.filter(ImageFilter.GaussianBlur(size // 7))
	gradient.alpha_composite(depth)

	mask = Image.new("L", (size, size), 0)
	mask_draw = ImageDraw.Draw(mask)
	mask_draw.rounded_rectangle((0, 0, size, size), radius=int(size * 0.22), fill=255)
	gradient.putalpha(mask)
	return gradient


def add_shadow(
	image: Image.Image,
	box: tuple[float, float, float, float],
	radius: int,
	offset: tuple[int, int],
	blur: int,
	opacity: int,
) -> None:
	shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
	draw = ImageDraw.Draw(shadow)
	translated = (
		box[0] + offset[0],
		box[1] + offset[1],
		box[2] + offset[0],
		box[3] + offset[1],
	)
	draw.rounded_rectangle(translated, radius=radius, fill=(0, 0, 0, opacity))
	shadow = shadow.filter(ImageFilter.GaussianBlur(blur))
	image.alpha_composite(shadow)


def draw_box(base: Image.Image) -> None:
	add_shadow(
		base,
		(184, 310, 840, 466),
		radius=118,
		offset=(0, 22),
		blur=32,
		opacity=86,
	)
	add_shadow(
		base,
		(210, 416, 814, 804),
		radius=102,
		offset=(0, 26),
		blur=42,
		opacity=110,
	)

	box_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
	draw = ImageDraw.Draw(box_layer)

	lid_rect = (184, 310, 840, 466)
	body_rect = (210, 416, 814, 804)
	draw.rounded_rectangle(lid_rect, radius=118, fill=(204, 160, 105, 255))
	draw.rounded_rectangle(body_rect, radius=102, fill=(241, 227, 197, 255))
	draw.rounded_rectangle((248, 348, 776, 430), radius=42, fill=(226, 191, 139, 255))
	draw.rounded_rectangle((252, 474, 772, 770), radius=84, fill=(248, 238, 216, 255))

	draw.rounded_rectangle((384, 710, 640, 768), radius=28, fill=(38, 79, 61, 255))
	draw.rounded_rectangle((400, 724, 624, 736), radius=6, fill=(108, 156, 131, 255))
	draw.rounded_rectangle((400, 742, 572, 754), radius=6, fill=(108, 156, 131, 255))

	draw.rounded_rectangle((198, 452, 826, 470), radius=10, fill=(161, 118, 69, 255))
	draw.rounded_rectangle((226, 560, 266, 700), radius=18, fill=(232, 215, 183, 255))
	draw.rounded_rectangle((758, 560, 798, 700), radius=18, fill=(232, 215, 183, 255))

	highlight = Image.new("RGBA", base.size, (0, 0, 0, 0))
	highlight_draw = ImageDraw.Draw(highlight)
	highlight_draw.rounded_rectangle((206, 426, 818, 456), radius=14, fill=(255, 247, 231, 130))
	highlight_draw.rounded_rectangle((270, 328, 754, 352), radius=12, fill=(255, 230, 180, 90))
	highlight = highlight.filter(ImageFilter.GaussianBlur(10))

	base.alpha_composite(box_layer)
	base.alpha_composite(highlight)


def cubic_point(
	p0: tuple[float, float],
	p1: tuple[float, float],
	p2: tuple[float, float],
	p3: tuple[float, float],
	t: float,
) -> tuple[float, float]:
	mt = 1 - t
	x = (
		mt * mt * mt * p0[0]
		+ 3 * mt * mt * t * p1[0]
		+ 3 * mt * t * t * p2[0]
		+ t * t * t * p3[0]
	)
	y = (
		mt * mt * mt * p0[1]
		+ 3 * mt * mt * t * p1[1]
		+ 3 * mt * t * t * p2[1]
		+ t * t * t * p3[1]
	)
	return (x, y)


def cubic_tangent(
	p0: tuple[float, float],
	p1: tuple[float, float],
	p2: tuple[float, float],
	p3: tuple[float, float],
	t: float,
) -> tuple[float, float]:
	mt = 1 - t
	x = (
		3 * mt * mt * (p1[0] - p0[0])
		+ 6 * mt * t * (p2[0] - p1[0])
		+ 3 * t * t * (p3[0] - p2[0])
	)
	y = (
		3 * mt * mt * (p1[1] - p0[1])
		+ 6 * mt * t * (p2[1] - p1[1])
		+ 3 * t * t * (p3[1] - p2[1])
	)
	return (x, y)


def draw_leaf(
	canvas: Image.Image,
	center: tuple[float, float],
	length: int,
	width: int,
	angle: float,
	fill: tuple[int, int, int, int],
) -> None:
	leaf = Image.new("RGBA", (length * 2, length * 2), (0, 0, 0, 0))
	draw = ImageDraw.Draw(leaf)
	w = width
	h = length
	cx = length
	cy = length
	points = [
		(cx, cy - h // 2),
		(cx + w // 2, cy - h // 6),
		(cx + w // 3, cy + h // 2),
		(cx, cy + h // 2 + w // 4),
		(cx - w // 3, cy + h // 2),
		(cx - w // 2, cy - h // 6),
	]
	draw.polygon(points, fill=fill)
	draw.ellipse((cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 10), fill=fill)
	leaf = leaf.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
	x = int(center[0] - leaf.width / 2)
	y = int(center[1] - leaf.height / 2)
	canvas.alpha_composite(leaf, (x, y))


def draw_rosemary(base: Image.Image) -> None:
	sprig_shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
	shadow_draw = ImageDraw.Draw(sprig_shadow)

	p0 = (513, 724)
	p1 = (512, 610)
	p2 = (570, 465)
	p3 = (620, 308)

	stem_points = [cubic_point(p0, p1, p2, p3, index / 80) for index in range(81)]
	shadow_draw.line(stem_points, fill=(0, 0, 0, 92), width=34, joint="curve")

	for t, side, length in [
		(0.12, -1, 116),
		(0.18, 1, 124),
		(0.30, -1, 112),
		(0.39, 1, 108),
		(0.50, -1, 102),
		(0.59, 1, 96),
		(0.70, -1, 90),
		(0.78, 1, 82),
	]:
		point = cubic_point(p0, p1, p2, p3, t)
		tangent = cubic_tangent(p0, p1, p2, p3, t)
		theta = math.atan2(tangent[1], tangent[0])
		normal = theta + math.pi / 2
		offset = 36 * side
		center = (
			point[0] + math.cos(normal) * offset,
			point[1] + math.sin(normal) * offset,
		)
		rotation = math.degrees(theta) + (112 if side > 0 else -112)
		draw_leaf(
			sprig_shadow,
			center,
			length=length,
			width=max(28, length // 3),
			angle=rotation,
			fill=(0, 0, 0, 78),
		)

	sprig_shadow = sprig_shadow.filter(ImageFilter.GaussianBlur(14))
	sprig_shadow = ImageChops.offset(sprig_shadow, 0, 12)
	base.alpha_composite(sprig_shadow)

	sprig = Image.new("RGBA", base.size, (0, 0, 0, 0))
	draw = ImageDraw.Draw(sprig)
	draw.line(stem_points, fill=(30, 86, 64, 255), width=28, joint="curve")
	draw.line(stem_points, fill=(71, 131, 100, 170), width=10, joint="curve")

	for t, side, length, color in [
		(0.12, -1, 116, (58, 128, 93, 255)),
		(0.18, 1, 124, (42, 108, 79, 255)),
		(0.30, -1, 112, (66, 142, 103, 255)),
		(0.39, 1, 108, (37, 100, 73, 255)),
		(0.50, -1, 102, (69, 146, 107, 255)),
		(0.59, 1, 96, (36, 99, 72, 255)),
		(0.70, -1, 90, (78, 154, 116, 255)),
		(0.78, 1, 82, (44, 115, 84, 255)),
	]:
		point = cubic_point(p0, p1, p2, p3, t)
		tangent = cubic_tangent(p0, p1, p2, p3, t)
		theta = math.atan2(tangent[1], tangent[0])
		normal = theta + math.pi / 2
		offset = 36 * side
		center = (
			point[0] + math.cos(normal) * offset,
			point[1] + math.sin(normal) * offset,
		)
		rotation = math.degrees(theta) + (112 if side > 0 else -112)
		draw_leaf(
			sprig,
			center,
			length=length,
			width=max(28, length // 3),
			angle=rotation,
			fill=color,
		)

	for bloom in [
		(593, 318, 18),
		(628, 350, 14),
		(570, 358, 12),
	]:
		draw.ellipse(
			(bloom[0] - bloom[2], bloom[1] - bloom[2], bloom[0] + bloom[2], bloom[1] + bloom[2]),
			fill=(150, 206, 226, 245),
		)
		draw.ellipse(
			(
				bloom[0] - bloom[2] + 6,
				bloom[1] - bloom[2] + 6,
				bloom[0] + bloom[2] - 8,
				bloom[1] + bloom[2] - 8,
			),
			fill=(223, 247, 255, 120),
		)

	base.alpha_composite(sprig)


def add_frame(base: Image.Image) -> None:
	stroke = Image.new("RGBA", base.size, (0, 0, 0, 0))
	draw = ImageDraw.Draw(stroke)
	draw.rounded_rectangle(
		(12, 12, base.width - 12, base.height - 12),
		radius=int(base.width * 0.215),
		outline=(255, 255, 255, 26),
		width=10,
	)
	stroke = stroke.filter(ImageFilter.GaussianBlur(2))
	base.alpha_composite(stroke)


def create_icon() -> Image.Image:
	icon = background(MASTER_SIZE)
	draw_box(icon)
	draw_rosemary(icon)
	add_frame(icon)
	return icon


def save_assets(icon: Image.Image) -> None:
	BUILD_DIR.mkdir(exist_ok=True)
	RESOURCES_DIR.mkdir(exist_ok=True)

	png_icon = icon.resize((PNG_SIZE, PNG_SIZE), Image.Resampling.LANCZOS)
	png_icon.save(BUILD_DIR / "icon.png")
	png_icon.save(RESOURCES_DIR / "icon.png")

	icon.save(
		BUILD_DIR / "icon.ico",
		sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
	)
	icon.save(BUILD_DIR / "icon.icns")


def main() -> None:
	save_assets(create_icon())


if __name__ == "__main__":
	main()
