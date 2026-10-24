#!/usr/bin/env python3
"""Deterministic Vietnamese receipt photos and line-amount ground truth (Pillow)."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = Path(__file__).resolve().parents[1] / "crates/recognition/tests/fixtures/receipts"
FONT = "/usr/share/fonts/TTF/DejaVuSans.ttf"


def render(number, rows, items, total):
    paper = Image.new("RGB", (900, 80 + 56 * len(rows)), (250, 248, 240))
    draw = ImageDraw.Draw(paper)
    for i, (text, size) in enumerate(rows):
        # Table rows use fixed columns so the detector can preserve individual crops.
        columns = [(40, text)] if isinstance(text, str) else text
        for x, value in columns:
            draw.text((x, 40 + i * 56), value, font=ImageFont.truetype(FONT, size), fill=(20, 20, 20))
    photo = Image.new("RGB", (paper.width + 300, paper.height + 300), (90, 80, 70))
    photo.paste(paper, (150, 150))
    photo = photo.rotate(1.5, fillcolor=(90, 80, 70)).filter(ImageFilter.GaussianBlur(0.6))
    path = OUT / f"receipt-{number}.jpg"
    photo.save(path, quality=85)
    assert path.stat().st_size < 200_000
    data = {"lines": [dict(product_name=n, quantity=q, cost=c) for n, q, c in items], "total": total}
    path.with_suffix(".json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    render(1, [
        ("ĐẠI LÝ TẠP HÓA MINH ANH", 34),
        ("12 Nguyễn Trãi, Q.1, TP.HCM", 26),
        ("HÓA ĐƠN BÁN HÀNG  25/10/2026", 26),
        ("Tên hàng          SL   Đơn giá   T.Tiền", 26),
        ("Coca-Cola lon 330ml  24   8.500   204.000", 26),
        ("Mì Hảo Hảo tôm chua cay  30  4.200  126.000", 26),
        ("Nước suối Aquafina 500ml  12  5.000  60.000", 26),
        ("Bánh Chocopie hộp  5  13.200  66.000", 26),
        ("Tổng cộng:  456.000", 30),
        ("Cảm ơn quý khách!", 26),
    ], [("Coca-Cola lon 330ml", 24, 204000), ("Mì Hảo Hảo tôm chua cay", 30, 126000),
        ("Nước suối Aquafina 500ml", 12, 60000), ("Bánh Chocopie hộp", 5, 66000)], 456000)
    items2 = [("Sữa tươi Vinamilk 180ml", 24, 168000), ("Dầu ăn Neptune 1L", 6, 270000),
              ("Bột giặt OMO 800g", 5, 190000), ("Đường Biên Hòa 1kg", 10, 240000),
              ("Nước mắm Nam Ngư 500ml", 6, 180000), ("Bánh Oreo 133g", 8, 96000)]
    render(2, [("ĐẠI LÝ MINH ANH", 34), ("PHIẾU NHẬP HÀNG 26/10/2026", 26),
               ([(40, "SL"), (140, "Tên hàng"), (700, "Thành tiền")], 26)] +
           [([(40, str(q)), (140, n), (720, f"{c:,}".replace(",", "."))], 26) for n, q, c in items2] +
           [("Tổng cộng: 1.144.000", 30), ("Cảm ơn quý khách!", 26)], items2, 1144000)
    items3 = [("Cà phê G7 3in1", 10, 450000), ("Trà xanh Không Độ 500ml", 24, 216000),
              ("Sữa đặc Ông Thọ 380g", 12, 336000), ("Mì Hảo Hảo tôm chua cay", 30, 126000)]
    render(3, [("TẠP HÓA MINH ANH", 34), ("HÓA ĐƠN 27/10/2026", 26),
               ([(40, "Tên hàng"), (600, "Số lượng"), (740, "Thành tiền")], 26)] +
           [([(40, n), (620, f"x{q}"), (740, f"{c:,}".replace(",", "."))], 26) for n, q, c in items3] +
           [("Chiết khấu: 28.000", 26), ("Thanh toán: 1.100.000", 30), ("Cảm ơn quý khách!", 26)], items3, 1100000)


if __name__ == "__main__":
    main()
