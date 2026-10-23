# Draws the Setup artwork (side.bmp) and the program icon
# (office-printing.ico) in the PrintBridge colours.
#   python3 make-art.py
# The colours below are the ones in desktop/lib/brand.js - keep the two in
# step, and re-run this whenever they change. (Both files are written into
# this folder, where OfficePrinting.nsi picks them up.)
from PIL import Image, ImageDraw, ImageFont

BRAND = {
    "name": "PrintBridge",
    "tagline": "Print from any computer to any printer in the office.",
    "primary": (30, 111, 191),     # #1E6FBF
    "primary_dark": (18, 63, 115),  # #123F73
    "accent": (33, 166, 123),      # #21A67B
    "white": (255, 255, 255),
    "muted": (198, 216, 238),      # the tagline, against the blue
    "credit": "by @devnithdev",
}

BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


def printer(d, box, body, paper, line):
    """A simple printer glyph inside box=(x0,y0,x1,y1)."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    u = w / 16.0
    # paper tray (top)
    d.rounded_rectangle([x0 + 4 * u, y0 + 1 * u, x1 - 4 * u, y0 + 6 * u], radius=u * 0.8, fill=paper, outline=body, width=max(1, int(u)))
    # body
    d.rounded_rectangle([x0 + 1 * u, y0 + 5 * u, x1 - 1 * u, y0 + 12 * u], radius=u * 1.6, fill=body)
    # light
    d.ellipse([x1 - 4 * u, y0 + 7 * u, x1 - 3 * u, y0 + 8 * u], fill=line)
    # printed page (bottom)
    d.rectangle([x0 + 4 * u, y0 + 9.5 * u, x1 - 4 * u, y0 + 15 * u], fill=paper, outline=body, width=max(1, int(u)))
    for yy in (11.3, 13.1):
        d.line([x0 + 5.5 * u, y0 + yy * u, x1 - 5.5 * u, y0 + yy * u], fill=body, width=max(1, int(u * 0.7)))


def cup(d, x, y, h, color):
    """A small coffee cup (the maker's mark) h pixels tall, top-left at x,y.
    Returns its width."""
    u = h / 12.0
    w = int(round(u * 1.6))
    # steam
    for sx in (3.2, 6.0):
        d.line([x + sx * u, y + 0.3 * u, x + (sx - 0.5) * u, y + 1.3 * u, x + sx * u, y + 2.3 * u], fill=color, width=max(1, int(u * 0.8)))
    # cup body
    d.rounded_rectangle([x + 0.6 * u, y + 3.2 * u, x + 8.6 * u, y + 10 * u], radius=u * 2.2, outline=color, width=max(1, int(u * 1.1)))
    # handle
    d.arc([x + 7.2 * u, y + 4.4 * u, x + 11 * u, y + 8.2 * u], start=-90, end=90, fill=color, width=max(1, int(u * 1.1)))
    # saucer
    d.line([x, y + 11.4 * u, x + 9.4 * u, y + 11.4 * u], fill=color, width=max(1, int(u * 1.1)))
    return int(11.4 * u)


def fitted(d, text, path, start, max_width):
    """The largest font size at or below `start` that fits in max_width."""
    for size in range(start, 7, -1):
        font = ImageFont.truetype(path, size)
        if d.textlength(text, font=font) <= max_width:
            return font
    return ImageFont.truetype(path, 8)


def wrapped(d, text, font, max_width):
    """`text` split into lines that each fit in max_width."""
    lines, line = [], ""
    for word in text.split():
        trial = (line + " " + word).strip()
        if d.textlength(trial, font=font) <= max_width or not line:
            line = trial
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def side():
    W, H = 164, 314
    im = Image.new("RGB", (W, H), BRAND["primary"])
    d = ImageDraw.Draw(im)
    # vertical gradient, primary -> primary_dark
    for y in range(H):
        t = y / (H - 1)
        c = tuple(int(BRAND["primary"][i] * (1 - t) + BRAND["primary_dark"][i] * t) for i in range(3))
        d.line([0, y, W, y], fill=c)
    # accent bar along the top - the same motif the program's own pages use
    d.rectangle([0, 0, W, 5], fill=BRAND["accent"])
    # white tile with a blue printer
    tile = (27, 56, 137, 166)
    d.rounded_rectangle(tile, radius=18, fill=BRAND["white"])
    printer(d, (tile[0] + 15, tile[1] + 14, tile[2] - 15, tile[3] - 12), BRAND["primary"], BRAND["white"], BRAND["accent"])

    # wordmark, sized to fit the banner rather than a fixed size that might not
    margin = 12
    name_font = fitted(d, BRAND["name"], BOLD, 26, W - 2 * margin)
    tw = d.textlength(BRAND["name"], font=name_font)
    name_y = 194
    d.text(((W - tw) / 2, name_y), BRAND["name"], font=name_font, fill=BRAND["white"])

    # accent underline under the name
    bottom = name_y + name_font.size + 8
    d.rectangle([W / 2 - 20, bottom, W / 2 + 20, bottom + 2], fill=BRAND["accent"])

    # the tagline, wrapped to as many lines as it needs
    tag_font = ImageFont.truetype(REG, 10)
    y = bottom + 14
    for line in wrapped(d, BRAND["tagline"], tag_font, W - 2 * margin):
        lw = d.textlength(line, font=tag_font)
        d.text(((W - lw) / 2, y), line, font=tag_font, fill=BRAND["muted"])
        y += 14
    # who made it, along the bottom: the coffee cup and "by @devnithdev"
    cr_font = fitted(d, BRAND["credit"], BOLD, 11, W - 2 * margin - 20)
    cw = d.textlength(BRAND["credit"], font=cr_font)
    cup_h = 20
    # drawn four times larger and scaled down, so the small cup is smooth
    big = Image.new("RGBA", (cup_h * 4, cup_h * 4), (0, 0, 0, 0))
    cup(ImageDraw.Draw(big), 2, 2, cup_h * 4 - 4, BRAND["white"] + (255,))
    small = big.resize((cup_h, cup_h), Image.LANCZOS)
    total = cup_h + 5 + cw
    x = int((W - total) / 2)
    im.paste(small, (x, H - 33), small)
    d.text((x + cup_h + 5, H - 30), BRAND["credit"], font=cr_font, fill=BRAND["white"])
    im.save("side.bmp")
    return im


def icon():
    S = 256
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=52, fill=BRAND["primary"] + (255,))
    printer(d, (44, 40, S - 44, S - 40), BRAND["white"] + (255,), BRAND["primary"] + (255,), BRAND["accent"] + (255,))
    im.save("office-printing.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return im


if __name__ == "__main__":
    side().save("side-preview.png")
    icon().save("icon-preview.png")
    print("side.bmp and office-printing.ico written (with side-preview.png / icon-preview.png to look at)")
