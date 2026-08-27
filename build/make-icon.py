"""
Generate the application icon.

Checked in as a script rather than a binary so the mark can be adjusted without
anyone hunting for an original file. Run: python build/make-icon.py

The mark: a pit wall seen from the track — one heavy vertical stroke with timing
bars beside it. Monochrome, matching the documents. Drawn at 8x and downsampled,
because ImageDraw has no anti-aliasing of its own and a hard-edged 256px icon
falls apart once Windows scales it to 16.
"""

from PIL import Image, ImageDraw

INK = (0x17, 0x17, 0x15, 255)  # ground
LIGHT = (0xED, 0xED, 0xEA, 255)  # wall and the loud bars
DIM = (0x8D, 0x8D, 0x86, 255)  # one quieter bar, so it reads as data

SIZES = [16, 24, 32, 48, 64, 128, 256]
SUPERSAMPLE = 8

# Course of bricks: (row, [(start, width), ...]) as fractions of the wall.
# Offset each course so the joints stagger, which is what makes it read as a
# wall rather than a stack of bars.
# Three courses, not four. Four blurs into grey at 16px, where most people
# actually meet an icon.
COURSES = [
    [(0.00, 0.60), (0.66, 0.34)],
    [(0.00, 0.30), (0.36, 0.64)],
    [(0.00, 0.60), (0.66, 0.34)],
]


def render(size: int) -> Image.Image:
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=INK)

    pad = s * 0.21
    inner = s - pad * 2

    joint = inner * 0.085  # mortar gap, wide enough to survive downsampling
    course_h = (inner - joint * (len(COURSES) - 1)) / len(COURSES)
    radius = min(course_h * 0.30, inner * 0.05)

    for row, bricks in enumerate(COURSES):
        y = pad + row * (course_h + joint)
        # One brick per wall is lit differently, so the eye reads masonry and
        # not a progress bar.
        for col, (start, width) in enumerate(bricks):
            x = pad + start * inner
            w = width * inner - joint
            colour = DIM if (row, col) == (1, 1) else LIGHT
            draw.rounded_rectangle([x, y, x + w, y + course_h], radius=radius, fill=colour)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    largest = render(SIZES[-1])
    largest.save("build/icon.png")
    largest.save("build/icon.ico", sizes=[(n, n) for n in SIZES])
    print(f"wrote build/icon.ico and build/icon.png at {SIZES}")


if __name__ == "__main__":
    main()
