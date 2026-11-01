# Hiệu năng lập lịch

## Đo ngày 01/11/2026

Môi trường: trình duyệt local, bộ `21102026.xlsx`, khai thác 01/10/2026. Phát lại được dừng, bật mưa lúc 14:00 và tắt lúc 14:40. Thời gian phản hồi được đo từ thao tác công tắc đến hai nhịp `requestAnimationFrame` tiếp theo.

| Thao tác | Trước | Sau khi chuyển sang Worker |
| --- | ---: | ---: |
| Bật mưa | 1.055 ms | 20–50 ms |
| Tắt mưa | 18.517 ms | 20–60 ms |

Các số trên đo khả năng phản hồi/vẽ giao diện, **không phải tổng thời gian tính xong lịch**. Lịch vẫn có thể cần vài giây ở nền; phát lại tạm dừng trong lúc tính và thông báo không làm thay đổi bố cục. Số đo phụ thuộc máy và dữ liệu, không phải cam kết độ trễ trên mọi thiết bị.

## Nguyên nhân và thay đổi

- Trước đây `applyWeatherPeriods` chạy đồng bộ trong `useMemo` của màn hình chính, chặn xử lý tương tác và vẽ khung hình.
- Lập lịch ngày và thời tiết chuyển sang Web Worker. Yêu cầu cũ bị hủy khi đổi dữ liệu, thời tiết hoặc mốc RCD; kết quả cũ không thay thế yêu cầu mới.
- Không tiếp tục tìm slot cất cánh sau khi CTOT cố định không còn khả thi. Xung đột vĩnh viễn không được thử lại từng hai giây suốt 48 giờ.
- Khi dựng quỹ đạo, các khoảng đứng yên được đi qua bằng các mốc chuyển pha đã biết; chuyển động vẫn được lấy mẫu để kiểm tra phân cách.
- Tìm đoạn chuyển động hiện tại bằng tìm kiếm nhị phân thay cho duyệt toàn bộ các đoạn mỗi khung hình.

## Kiểm tra trước khi phát hành

1. Chạy lại cùng dữ liệu và giờ bật/tắt mưa, kiểm tra phản hồi công tắc và kết quả lập lịch riêng biệt.
2. Kiểm tra không có cảnh báo lập lịch, CTOT không đổi, tàu bị giữ không tự khởi hành lại.
3. Kiểm tra phân cách trên tọa độ hiển thị, bao gồm tàu dừng lâu tại stand.
4. Thử đổi dữ liệu hoặc bật/tắt liên tiếp khi Worker còn đang tính; chỉ kết quả của yêu cầu cuối được áp dụng.
