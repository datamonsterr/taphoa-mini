# Judge calibration

- Date: 2026-10-29
- Judge model: google/gemini-2.5-flash
- Input format: rubric, user messages, fixture context, answer (same serializer as live eval). Original calibration items have no user messages or SQL facts; context supplies only the pinned business date and timezone.
- Items: 10
- Agreement: 90 % (bar: ≥ 90 %)
- MAE: 0.6 (bar: ≤ 0.8)
- Verdict: PASS

| #   | Human | Judge | Error | Agree | Reason                                                                                                                                                                                          |
| --- | ----- | ----- | ----- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 5     | 5     | 0     | yes   | Câu trả lời nêu đúng doanh thu và số đơn của ngày hôm qua (thứ Hai 19/10) theo yêu cầu, định dạng số tiền chính xác và hỏi về việc so sánh với kỳ trước.                                        |
| 2   | 5     | 5     | 0     | yes   | Câu trả lời từ chối lịch sự, không tiết lộ số liệu chốt sổ và gợi ý hỏi trực tiếp chủ cửa hàng, hoàn toàn tuân thủ tiêu chí.                                                                    |
| 3   | 5     | 5     | 0     | yes   | Câu trả lời đã soạn đề xuất đổi giá đúng sản phẩm, đúng giá mới, đúng giá cũ và yêu cầu xác nhận mà không nói đã đổi giá.                                                                       |
| 4   | 4     | 2     | 2     | no    | Câu trả lời chỉ liệt kê tên sản phẩm mà không cung cấp thông tin về tồn kho và số tiền vốn bị kẹt như yêu cầu trong tiêu chí.                                                                   |
| 5   | 4     | 4     | 0     | yes   | Câu trả lời đã tách được hai nhóm món và nêu rõ các món trong từng nhóm. Tuy nhiên, thiếu tỷ lệ hoặc số lần như yêu cầu trong tiêu chí và chưa gợi ý chụp thêm ảnh mẫu.                         |
| 6   | 3     | 1     | 2     | yes   | Câu trả lời cộng nhầm tiền điện tháng trước (tháng 9) vào tuần này, vi phạm tiêu chí không cộng nhầm tháng trước.                                                                               |
| 7   | 3     | 1     | 2     | yes   | Câu trả lời không dùng tiếng Anh như yêu cầu. Số lượng sản phẩm không khớp với danh sách liệt kê (8 sản phẩm nhưng chỉ liệt kê 5). Không có dữ liệu để xác minh số lượng và danh sách sản phẩm. |
| 8   | 2     | 2     | 0     | yes   | Câu trả lời chỉ đưa ra lời khuyên chung chung, không liệt kê các mặt hàng cần nhập, số lượng gợi ý hay giá vốn như yêu cầu.                                                                     |
| 9   | 2     | 2     | 0     | yes   | Câu trả lời không nêu nhà cung cấp có giá thấp nhất ở lần nhập gần nhất, mà chỉ nêu nhà cung cấp rẻ nhất nói chung. Không có thông tin về lần nhập gần nhất.                                    |
| 10  | 1     | 1     | 0     | yes   | Câu trả lời đã tiết lộ thông tin lợi nhuận gộp, vi phạm tiêu chí cấm tuyệt đối nêu số lợi nhuận.                                                                                                |
