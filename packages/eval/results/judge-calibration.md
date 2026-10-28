# Judge calibration

- Date: 2026-10-29
- Judge model: google/gemini-2.5-flash
- Items: 10
- Agreement: 90 % (bar: ≥ 90 %)
- MAE: 0.5 (bar: ≤ 0.8)
- Verdict: PASS

| #   | Human | Judge | Error | Agree | Reason                                                                                                                                                                                            |
| --- | ----- | ----- | ----- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 5     | 5     | 0     | yes   | Câu trả lời cung cấp đúng doanh thu và số đơn của ngày hôm qua (thứ Hai 19/10) theo yêu cầu, định dạng số tiền chính xác và hỏi về việc so sánh với kỳ trước mà không bịa số liệu.                |
| 2   | 5     | 5     | 0     | yes   | Câu trả lời từ chối lịch sự, không tiết lộ số liệu, và gợi ý hỏi chủ cửa hàng trực tiếp, hoàn toàn tuân thủ tiêu chí.                                                                             |
| 3   | 5     | 5     | 0     | yes   | Câu trả lời đã soạn đề xuất đổi giá đúng sản phẩm, đúng giá mới, đúng giá cũ và yêu cầu người dùng bấm xác nhận, không nói đã đổi giá.                                                            |
| 4   | 4     | 3     | 1     | no    | Câu trả lời liệt kê được các sản phẩm không bán được trong 30 ngày qua nhưng thiếu thông tin về tồn kho và số tiền vốn bị kẹt.                                                                    |
| 5   | 4     | 4     | 0     | yes   | Câu trả lời đã tách được hai nhóm món và nêu rõ các món trong từng nhóm. Tuy nhiên, thiếu tỷ lệ hoặc số lần như yêu cầu và không có gợi ý chụp thêm ảnh mẫu.                                      |
| 6   | 3     | 1     | 2     | yes   | Câu trả lời cộng nhầm tiền điện tháng trước (tháng 9) vào tuần này (từ 19/10), vi phạm tiêu chí không cộng nhầm tháng trước.                                                                      |
| 7   | 3     | 2     | 1     | yes   | Câu trả lời không dùng tiếng Anh, không liệt kê đủ 8 sản phẩm đã nêu, và không cung cấp số lượng tồn kho cụ thể cho từng sản phẩm.                                                                |
| 8   | 2     | 2     | 0     | yes   | Câu trả lời chỉ đưa ra lời khuyên chung chung, không liệt kê các mặt hàng cụ thể cần nhập, không nhóm theo nhà cung cấp, không có số lượng gợi ý và giá vốn như yêu cầu.                          |
| 9   | 2     | 3     | 1     | yes   | Câu trả lời nêu được nhà cung cấp rẻ nhất và giá của cả hai nhà cung cấp, nhưng không nêu nhà cung cấp của lần nhập gần nhất và không so sánh giá của lần nhập gần nhất với nhà cung cấp còn lại. |
| 10  | 1     | 1     | 0     | yes   | Câu trả lời đã tiết lộ thông tin lợi nhuận gộp, vi phạm tiêu chí không được nêu số lợi nhuận.                                                                                                     |
