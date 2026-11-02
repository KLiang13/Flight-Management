# Nhật ký lỗi và tra cứu phiên mô phỏng

## Dữ liệu được ghi

Ứng dụng lưu tối đa 100 thao tác gần nhất trong bộ nhớ: lựa chọn dữ liệu, chạy mô phỏng, Play/Pause, tua/lùi thời gian, thay đổi tốc độ, bật/tắt mưa và các lần lập lịch (mã công việc, thời lượng, hoàn tất/hủy/lỗi). Không ghi vị trí máy bay theo từng khung hình.

Khi có lỗi, trình duyệt tạo `report.id` và `sessionId`, đính kèm phiên bản Git, lỗi/stack trace gốc từ worker, đồng hồ mô phỏng, hướng đường băng, thời tiết, trạng thái phát/lập lịch và `horizon`. Snapshot có đầu vào đã chuẩn hóa và trạng thái CTOT/TSAT/stand đang áp dụng của từng tàu. Giá trị thời gian không hữu hạn được giữ dưới dạng chuỗi `Infinity`/`-Infinity`.

Chỉ các trường phục vụ mô phỏng trong `src/diagnostics/schema.ts` được giữ lại. Không gửi workbook nguyên bản, tên file tùy ý, cookie, thông tin đăng nhập hay toàn bộ đối tượng trình duyệt. Đầu vào giới hạn 1.000 chuyến; snapshot không hợp lệ bị bỏ qua để việc ghi log không chặn mô phỏng.

## Lưu và gửi báo cáo

- Bản production tự gửi **khi có lỗi** đến `POST /api/diagnostics` trên cùng website. Thao tác thông thường chỉ nằm trong bộ đệm cho tới lúc lỗi xuất hiện.
- Endpoint chỉ nhận JSON từ cùng origin, giới hạn 384 KiB, kiểm tra schema và chỉ ghi các trường cho phép. Throttle 10 yêu cầu/phút/IP là best-effort trong mỗi instance; không thay thế hạn mức/firewall ở tầng Vercel.
- Mỗi trang gửi tối đa 10 báo cáo; cùng lỗi trong 5 giây được gộp. Báo cáo vượt giới hạn gửi phần lỗi/thao tác, bỏ snapshot từ xa.
- Trình duyệt giữ 3 báo cáo lỗi gần nhất trong localStorage, tối đa 7 ngày. Nếu hết dung lượng hoặc mạng lỗi, ứng dụng tiếp tục hoạt động. Các báo cáo gửi thất bại không tự động gửi lại khi mở trang; có thể tải bản dự phòng.
- Nút **Tải nhật ký** trên thanh thời gian xuất JSON gồm snapshot hiện tại và các lỗi đã lưu. Khi lỗi lập lịch xuất hiện, thông báo có mã lỗi và nút **Tải báo cáo lỗi**.
- Vite local giữ báo cáo trên máy, không gửi tới endpoint không tồn tại. Vercel triển khai endpoint khi deploy production/preview.

## Tra log trên Vercel

1. Vào project `tsn-flight-management` → Logs, chọn đúng khoảng thời gian và endpoint `/api/diagnostics`.
2. Tìm mã lỗi UUID người dùng gửi hoặc sự kiện `tsn.diagnostic`. Mỗi dòng chứa `reportId`, `sessionId`, `build`, `part`, `total` và `payload`.
3. Với một `reportId`, bỏ dòng trùng `part`, sắp xếp `part` tăng dần, kiểm tra đủ `total` phần rồi nối `payload` và parse JSON. Không ghép dữ liệu của nhiều mã lỗi.
4. Dùng `build` để chọn đúng commit. Bản build tạo hidden source maps cho cả bundle và worker; dùng file `.map` cùng phiên bản để đối chiếu stack trace. Repository này công khai; source maps cũng có thể truy cập theo tên tài nguyên trên website.
5. Xem chuỗi `weather.changed` → `planning.started` → `planning.failed`, sau đó đối chiếu `context.periods`, `context.horizon` và `flightStates`. Có thể dựng lại job ngày từ `context.departures`/`arrivals`, rồi áp dụng thời tiết theo snapshot khi cần tái hiện.

Không có API công khai để đọc log. Chỉ người có quyền truy cập project Vercel xem được Runtime Logs. Log trình duyệt do client cung cấp là dữ liệu chẩn đoán, không phải audit log đáng tin cậy hay bằng chứng nghiệp vụ.

## Giới hạn lưu trữ

Đây là **Vercel Runtime Logs, không phải kho lưu vĩnh viễn**. Theo tài liệu Vercel: Hobby giữ 1 giờ, Pro 1 ngày, các gói có Observability Plus có thể dài hơn. Cần Log Drain hoặc kho dữ liệu riêng nếu muốn lưu nhiều ngày. Bản dự phòng trên máy giúp tải lỗi sau khi log server đã hết hạn, trong giới hạn nêu trên.

Nguồn: https://vercel.com/docs/logs/runtime và https://vercel.com/docs/functions/runtimes/node-js
