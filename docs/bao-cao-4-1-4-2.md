# Chương 4: Thiết kế luồng dữ liệu và bản tin DCL

## 4.1. Thiết kế mô phỏng luồng dữ liệu tự động

### 4.1.1. Khái quát

Ứng dụng tiếp nhận dữ liệu chuyến bay từ workbook, chuẩn hóa thông tin chuyến đi và chuyến đến, bổ sung dữ liệu mô phỏng còn thiếu và xây dựng lịch khai thác cho ngày được chọn. Dữ liệu phục vụ điều phối gồm số hiệu chuyến, loại tàu bay, vị trí đỗ, thời gian sẵn sàng, CTOT và thông tin di chuyển dự kiến. Hệ thống sử dụng bộ giải HiGHS chạy bằng WebAssembly để giải bài toán quy hoạch tuyến tính nguyên hỗn hợp (MILP) cho thứ tự tàu đi.

Mô hình sử dụng biến thời gian cất cánh, biến thứ tự và biến nhị phân thể hiện việc vượt biên CTOT dự kiến. Hàm mục tiêu ưu tiên giảm số trường hợp vượt biên kế hoạch, tiếp theo giảm tổng thời gian cất cánh theo mô hình; biên kế hoạch có dự phòng ba phút so với giới hạn CTOT +10 phút. Thứ tự hai tàu Heavy liên tiếp bị ràng buộc; khoảng cách thời gian giữa các lần cất cánh được đưa vào mô hình. CTOT của chuyến bay được giữ nguyên; thời gian lăn là dữ liệu đầu vào ước lượng.

Cụ thể, gọi \(t_i\) là thời gian cất cánh tương đối của chuyến \(i\), \(u_i\) là biến nhị phân cho biết chuyến vượt biên kế hoạch và \(y_{ij}\) là biến xác định thứ tự giữa hai chuyến. Hàm mục tiêu có dạng:

\[
\min \; P\sum_i u_i + \sum_i t_i,
\]

trong đó hệ số \(P\) được chọn từ giới hạn thời gian của bài toán để ưu tiên số chuyến vượt biên kế hoạch. Các ràng buộc yêu cầu chuyến không cất cánh trước thời gian sẵn sàng hoặc trước CTOT −5 phút; các cặp chuyến sử dụng đường băng phải có khoảng phân cách theo thứ tự được chọn. Biến thứ tự bổ sung ràng buộc không để hai chuyến Heavy đứng liền nhau. Mốc dự phòng là tham số của kế hoạch, còn việc ghi nhận tuân thủ vẫn đối chiếu CTOT gốc và cửa sổ −5/+10 phút.

### 4.1.2. Xử lý lịch và cập nhật khi thời tiết thay đổi

Kết quả MILP được chuyển thành lịch tàu đi, sau đó kết hợp lịch tàu đến và bộ đặt chỗ đường lăn để xây dựng chuyển động trên sơ đồ. Bước đặt chỗ kiểm tra vị trí đỗ, tuyến di chuyển và các giao cắt theo mô hình. Những điều chỉnh sau bước này có thể làm thay đổi kết quả thời gian so với nghiệm ban đầu; vì thế không được coi lịch cuối cùng là nghiệm tối ưu toàn cục đã chứng minh.

Khi người dùng bật hoặc tắt thời tiết xấu, hệ thống giữ lại các sự kiện đã diễn ra, cập nhật trạng thái tàu và lập lại thứ tự các chuyến còn lại. Bộ giải MILP được sử dụng theo các cửa sổ chuyến bay; logic nghiệp vụ và bộ đặt chỗ tiếp tục kiểm tra khả năng thực hiện, bao gồm xử lý tàu bay tại stand, điểm chờ, tàu đến chuyển hướng và giao cắt đường băng. Cách giải theo cửa sổ không chứng minh tối ưu toàn cục cho toàn bộ ngày khai thác.

Việc tính toán được thực hiện trong Web Worker để hạn chế chặn giao diện. Nếu bộ giải chạm giới hạn thời gian, hệ thống chỉ sử dụng kết quả khi các giá trị có thể được kiểm tra hợp lệ; kết quả đó không đồng nghĩa với nghiệm tối ưu đã được chứng minh. Nếu không có nghiệm hợp lệ, hệ thống thông báo lỗi lập lịch.

## 4.2. Thiết lập và mô phỏng bản tin DCL

### 4.2.1. Nội dung bản tin

Ứng dụng mô phỏng chuỗi trao đổi RCD, FSM, CLD và CDA. Bản tin được xây dựng từ dữ liệu chuyến bay và lịch mô phỏng: số hiệu chuyến, sân bay đi và đến, stand, loại tàu bay, đường băng và TSAT. CLD hiển thị TSAT theo định dạng giờ và phút; CTOT được quản lý riêng trong lịch điều phối.

Các bản tin này là dữ liệu mô phỏng hiển thị trong ứng dụng, không phải điện văn được truyền đến tàu bay hoặc hệ thống ATC thực tế. Thông báo thời tiết được trình bày trong khu vực riêng.

### 4.2.2. Quy trình tạo và cập nhật

Khi có lịch ngày, hệ thống tạo các sự kiện bản tin theo thời gian mô phỏng. Thời điểm RCD được tính từ TSAT theo quy tắc của ứng dụng; các bản tin tiếp theo được tạo theo kịch bản DCL. Trong thời tiết xấu, thông tin thời tiết được hiển thị độc lập, còn quá trình cấp huấn lệnh được xử lý theo trạng thái chuyến bay.

Đối với chuỗi thông thường, ứng dụng đặt RCD tại TSAT ban đầu trừ 20 phút, sau đó mô phỏng FSM sau 15 giây, CLD sau 40 giây và CDA sau 65 giây tính từ RCD. Nội dung CLD được tạo từ trường dữ liệu của chuyến, gồm callsign, sân bay đích, đường băng và TSAT. Các giá trị SID và mã squawk trong bản tin là thông tin minh họa của kịch bản.

Sau khi thời tiết tốt trở lại, hệ thống kiểm tra CTOT gốc, TSAT và thời gian di chuyển dự kiến. Với trường hợp đủ điều kiện cấp lại TSAT, thời điểm cấp lại và nội dung CLD được cập nhật theo quy tắc mô phỏng. Những chuyến không đủ điều kiện tiếp tục được giữ và hiển thị trạng thái phù hợp. Không phát sinh CTOT mới trong quy trình này.
