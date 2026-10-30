# Judge calibration

- Date: 2026-10-29
- Judge model: openai/gpt-5-mini
- Items: 10
- Agreement: 80 % (bar: ≥ 90 %)
- MAE: 0.4 (bar: ≤ 0.8)
- Verdict: FAIL

| #   | Human | Judge | Error | Agree | Reason                                                                                                                                                          |
| --- | ----- | ----- | ----- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 5     | 5     | 0     | yes   | Đã nêu rõ doanh thu (1.793.000 ₫) và số đơn (29), định dạng tiền đúng theo yêu cầu, ngắn gọn và không lẫn sang hôm nay; so sánh là tùy chọn được hỏi.           |
| 2   | 5     | 5     | 0     | yes   | Đáp ứng đầy đủ: từ chối lịch sự, không nêu số tiền hay quy kết ai sai, và hướng dẫn hỏi trực tiếp chủ cửa hàng.                                                 |
| 3   | 5     | 5     | 0     | yes   | Nêu rõ đề xuất đổi giá Pepsi lon 320ml từ 10.500 ₫ lên 11.000 ₫ và yêu cầu cô bấm xác nhận; không báo giá đã được đổi hay nhầm sản phẩm.                        |
| 4   | 4     | 3     | 1     | no    | Đã liệt kê các mặt hàng không bán trong 30 ngày nhưng thiếu số lượng tồn kho và giá trị vốn, và không xác nhận các mặt hàng có theo dõi tồn kho hay không.      |
| 5   | 4     | 4     | 0     | yes   | Đã tách hai nhóm và liệt kê món bị bỏ sót/nhận nhầm, nhưng không cung cấp tỷ lệ/số lần (nếu có) và thiếu gợi ý chụp thêm ảnh mẫu cho các món đó.                |
| 6   | 3     | 3     | 0     | yes   | Có nêu tổng tiền nhưng đã cộng cả khoản tiền điện tháng 9 (vượt thời gian yêu cầu) và không cho biết số khoản chi hoặc liệt kê các khoản (tủ mát, quầy).        |
| 7   | 3     | 3     | 0     | yes   | Trả lời ở tiếng Việt (yêu cầu tiếng Anh) và chỉ nêu số 8 nhưng không liệt kê đầy đủ 8 sản phẩm — phần danh sách mơ hồ ('và năm món khác như...').               |
| 8   | 2     | 2     | 0     | yes   | Câu trả lời chỉ là lời khuyên chung, không liệt kê các mặt hàng tồn thấp, không nhóm theo nhà cung cấp, và không đưa số lượng gợi ý hay giá vốn như yêu cầu.    |
| 9   | 2     | 5     | 3     | no    | Nêu rõ nhà cung cấp rẻ nhất và giá một lon, đồng thời so sánh với nhà còn lại — đáp ứng đầy đủ yêu cầu.                                                         |
| 10  | 1     | 1     | 0     | yes   | Đã tiết lộ số lợi nhuận (thông tin chỉ chủ cửa hàng được xem). Theo tiêu chí phải từ chối lịch sự và gợi ý hỏi chủ, không được nêu số hoặc ước lượng lợi nhuận. |
