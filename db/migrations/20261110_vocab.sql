CREATE TABLE IF NOT EXISTS app.vocab_topics (
  id uuid PRIMARY KEY,
  slug varchar(48) NOT NULL UNIQUE,
  name varchar(80) NOT NULL,
  icon varchar(16) NOT NULL,
  description varchar(240) NOT NULL,
  display_order smallint NOT NULL UNIQUE CHECK (display_order > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.vocab_words (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id uuid NOT NULL REFERENCES app.vocab_topics(id) ON DELETE CASCADE,
  word varchar(120) NOT NULL,
  phonetic varchar(160) NOT NULL,
  part_of_speech varchar(32) NOT NULL,
  meaning_vi varchar(240) NOT NULL,
  example_en text NOT NULL,
  example_vi text NOT NULL,
  audio_url text,
  alternative_answers text[] NOT NULL DEFAULT '{}',
  display_order smallint NOT NULL CHECK (display_order > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (topic_id, word),
  UNIQUE (topic_id, display_order)
);
CREATE INDEX IF NOT EXISTS vocab_words_topic_order
  ON app.vocab_words (topic_id, display_order);

CREATE TABLE IF NOT EXISTS app.vocab_user_settings (
  user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  timezone varchar(64) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  welcome_popup_dismissed_at timestamptz,
  welcome_popup_opt_out boolean NOT NULL DEFAULT false,
  reminder_time time,
  weekly_summary_enabled boolean NOT NULL DEFAULT true,
  last_reminder_sent_on date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.vocab_user_word_progress (
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  word_id uuid NOT NULL REFERENCES app.vocab_words(id) ON DELETE CASCADE,
  status varchar(12) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'learning', 'mastered')),
  correct_count integer NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  wrong_count integer NOT NULL DEFAULT 0 CHECK (wrong_count >= 0),
  review_interval_days smallint NOT NULL DEFAULT 0 CHECK (review_interval_days >= 0),
  last_reviewed_at timestamptz,
  next_review_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, word_id)
);
CREATE INDEX IF NOT EXISTS vocab_progress_due
  ON app.vocab_user_word_progress (user_id, next_review_at)
  WHERE status <> 'new';
CREATE INDEX IF NOT EXISTS vocab_progress_status
  ON app.vocab_user_word_progress (user_id, status);

CREATE TABLE IF NOT EXISTS app.vocab_study_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES app.vocab_topics(id),
  mode varchar(20) NOT NULL CHECK (mode IN ('flashcard', 'fill_blank', 'listen_fill')),
  word_count smallint NOT NULL CHECK (word_count IN (10, 15, 30)),
  score numeric(5,2) NOT NULL DEFAULT 0 CHECK (score >= 0),
  total_questions smallint NOT NULL DEFAULT 0 CHECK (total_questions >= 0),
  duration_sec integer CHECK (duration_sec IS NULL OR duration_sec >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (id, user_id),
  CHECK (total_questions = 0 OR score <= total_questions)
);
CREATE INDEX IF NOT EXISTS vocab_sessions_user_started
  ON app.vocab_study_sessions (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS app.vocab_session_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL,
  user_id uuid NOT NULL,
  word_id uuid NOT NULL REFERENCES app.vocab_words(id),
  question_index smallint NOT NULL CHECK (question_index > 0),
  user_answer text NOT NULL DEFAULT '',
  is_correct boolean NOT NULL,
  hint_count smallint NOT NULL DEFAULT 0 CHECK (hint_count BETWEEN 0 AND 20),
  answered_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (session_id, user_id)
    REFERENCES app.vocab_study_sessions(id, user_id) ON DELETE CASCADE,
  UNIQUE (session_id, question_index)
);
CREATE INDEX IF NOT EXISTS vocab_answers_user_word
  ON app.vocab_session_answers (user_id, word_id, answered_at DESC);

CREATE TABLE IF NOT EXISTS app.vocab_daily_stats (
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  study_date date NOT NULL,
  sessions integer NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  words integer NOT NULL DEFAULT 0 CHECK (words >= 0),
  correct numeric(8,2) NOT NULL DEFAULT 0 CHECK (correct >= 0),
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  minutes integer NOT NULL DEFAULT 0 CHECK (minutes >= 0),
  PRIMARY KEY (user_id, study_date),
  CHECK (correct <= total)
);
CREATE INDEX IF NOT EXISTS vocab_daily_stats_user_date
  ON app.vocab_daily_stats (user_id, study_date DESC);

ALTER TABLE app.vocab_study_sessions
  ALTER COLUMN score TYPE numeric(5,2) USING score::numeric;
ALTER TABLE app.vocab_session_answers
  ADD COLUMN IF NOT EXISTS hint_count smallint NOT NULL DEFAULT 0 CHECK (hint_count BETWEEN 0 AND 20);
ALTER TABLE app.vocab_daily_stats
  ALTER COLUMN correct TYPE numeric(8,2) USING correct::numeric;

INSERT INTO app.vocab_topics (id, slug, name, icon, description, display_order)
VALUES
  ('a1000000-0000-4000-8000-000000000001', 'office', 'Văn phòng', '📁',
   'Từ vựng thường gặp khi làm việc, họp hành và trao đổi công việc.', 1),
  ('a1000000-0000-4000-8000-000000000002', 'travel', 'Du lịch công tác', '✈️',
   'Chuẩn bị cho chuyến đi, đặt dịch vụ và xử lý tình huống tại sân bay.', 2),
  ('a1000000-0000-4000-8000-000000000003', 'finance', 'Tài chính', '📊',
   'Các khái niệm ngân sách, thanh toán và báo cáo tài chính cơ bản.', 3)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  icon = EXCLUDED.icon,
  description = EXCLUDED.description,
  display_order = EXCLUDED.display_order;

WITH seed(topic_slug, word, phonetic, part_of_speech, meaning_vi, example_en, example_vi) AS (
  VALUES
  ('office','agenda','/əˈdʒendə/','noun','chương trình nghị sự','Please review the agenda before the meeting.','Vui lòng xem chương trình nghị sự trước cuộc họp.'),
  ('office','appointment','/əˈpɔɪntmənt/','noun','cuộc hẹn','The appointment is scheduled for Thursday morning.','Cuộc hẹn được lên lịch vào sáng thứ Năm.'),
  ('office','assignment','/əˈsaɪnmənt/','noun','nhiệm vụ được giao','The assignment is due at the end of the month.','Nhiệm vụ phải hoàn thành vào cuối tháng.'),
  ('office','attendee','/ˌætenˈdiː/','noun','người tham dự','Each attendee received a copy of the report.','Mỗi người tham dự đã nhận một bản báo cáo.'),
  ('office','breakroom','/ˈbreɪkruːm/','noun','phòng nghỉ','The breakroom is on the second floor.','Phòng nghỉ ở tầng hai.'),
  ('office','colleague','/ˈkɑːliːɡ/','noun','đồng nghiệp','A colleague will help prepare the presentation.','Một đồng nghiệp sẽ giúp chuẩn bị bài thuyết trình.'),
  ('office','conference','/ˈkɑːnfərəns/','noun','hội nghị','The annual conference attracts many business owners.','Hội nghị thường niên thu hút nhiều chủ doanh nghiệp.'),
  ('office','deadline','/ˈdedlaɪn/','noun','hạn chót','The team met the deadline without overtime.','Nhóm đã kịp hạn chót mà không phải làm thêm giờ.'),
  ('office','department','/dɪˈpɑːrtmənt/','noun','phòng ban','The finance department approved the request.','Phòng tài chính đã phê duyệt yêu cầu.'),
  ('office','document','/ˈdɑːkjumənt/','noun','tài liệu','Please attach the document to your email.','Vui lòng đính kèm tài liệu vào email.'),
  ('office','equipment','/ɪˈkwɪpmənt/','noun','thiết bị','The new equipment arrived this morning.','Thiết bị mới đã đến vào sáng nay.'),
  ('office','facility','/fəˈsɪləti/','noun','cơ sở vật chất','The facility includes several meeting rooms.','Cơ sở có một số phòng họp.'),
  ('office','feedback','/ˈfiːdbæk/','noun','ý kiến phản hồi','We appreciate your feedback on the proposal.','Chúng tôi trân trọng phản hồi của bạn về đề xuất.'),
  ('office','headquarters','/ˈhedkwɔːrtərz/','noun','trụ sở chính','The company headquarters is in Singapore.','Trụ sở chính của công ty ở Singapore.'),
  ('office','internship','/ˈɪntɜːrnʃɪp/','noun','kỳ thực tập','Her internship lasts for six months.','Kỳ thực tập của cô ấy kéo dài sáu tháng.'),
  ('office','inventory','/ˈɪnvəntɔːri/','noun','hàng tồn kho','The inventory is checked at the end of each week.','Hàng tồn kho được kiểm tra vào cuối mỗi tuần.'),
  ('office','manager','/ˈmænɪdʒər/','noun','người quản lý','The manager will lead the client meeting.','Người quản lý sẽ chủ trì cuộc họp với khách hàng.'),
  ('office','memo','/ˈmemoʊ/','noun','bản ghi nhớ','A memo was sent to all staff members.','Một bản ghi nhớ đã được gửi cho toàn bộ nhân viên.'),
  ('office','minutes','/ˈmɪnɪts/','noun','biên bản cuộc họp','She distributed the minutes after the meeting.','Cô ấy đã gửi biên bản sau cuộc họp.'),
  ('office','notice','/ˈnoʊtɪs/','noun','thông báo','The notice explains the updated office policy.','Thông báo giải thích chính sách văn phòng vừa cập nhật.'),
  ('office','policy','/ˈpɑːləsi/','noun','chính sách','The travel policy applies to every employee.','Chính sách công tác áp dụng cho mọi nhân viên.'),
  ('office','promotion','/prəˈmoʊʃn/','noun','sự thăng chức','Her promotion was announced at the staff meeting.','Việc thăng chức của cô ấy được thông báo tại cuộc họp nhân viên.'),
  ('office','receptionist','/rɪˈsepʃənɪst/','noun','nhân viên lễ tân','The receptionist greeted the visitors at the entrance.','Nhân viên lễ tân chào đón khách tại lối vào.'),
  ('office','schedule','/ˈskedʒuːl/','noun','lịch trình','The updated schedule is available online.','Lịch trình cập nhật đã có trên mạng.'),
  ('office','supervisor','/ˈsuːpərvaɪzər/','noun','người giám sát','A supervisor will review the completed forms.','Người giám sát sẽ xem lại các biểu mẫu đã hoàn tất.'),
  ('office','workshop','/ˈwɜːrkʃɑːp/','noun','buổi hội thảo thực hành','The workshop focuses on customer service.','Buổi hội thảo tập trung vào dịch vụ khách hàng.'),
  ('office','proposal','/prəˈpoʊzl/','noun','bản đề xuất','The proposal includes a detailed project timeline.','Bản đề xuất bao gồm tiến độ dự án chi tiết.'),
  ('office','orientation','/ˌɔːriənˈteɪʃn/','noun','buổi định hướng','The orientation introduces new staff to company procedures.','Buổi định hướng giới thiệu quy trình công ty cho nhân viên mới.'),
  ('office','workload','/ˈwɜːrkloʊd/','noun','khối lượng công việc','The workload increases during the busy season.','Khối lượng công việc tăng trong mùa cao điểm.'),
  ('office','workspace','/ˈwɜːrkspeɪs/','noun','không gian làm việc','The renovated workspace has more natural light.','Không gian làm việc được cải tạo có nhiều ánh sáng tự nhiên hơn.'),
  ('travel','accommodation','/əˌkɑːməˈdeɪʃn/','noun','chỗ ở','The accommodation is close to the convention center.','Chỗ ở gần trung tâm hội nghị.'),
  ('travel','arrival','/əˈraɪvl/','noun','sự đến nơi','The arrival time may change because of the weather.','Thời gian đến nơi có thể thay đổi do thời tiết.'),
  ('travel','boarding','/ˈbɔːrdɪŋ/','noun','việc lên máy bay','Boarding begins thirty minutes before departure.','Việc lên máy bay bắt đầu trước giờ khởi hành ba mươi phút.'),
  ('travel','booking','/ˈbʊkɪŋ/','noun','việc đặt chỗ','Your booking includes breakfast for two guests.','Đặt chỗ của bạn bao gồm bữa sáng cho hai khách.'),
  ('travel','cancellation','/ˌkænsəˈleɪʃn/','noun','việc hủy bỏ','The cancellation policy is listed on the receipt.','Chính sách hủy được ghi trên hóa đơn.'),
  ('travel','carry-on','/ˈkæri ɑːn/','noun','hành lý xách tay','Each passenger may bring one carry-on bag.','Mỗi hành khách có thể mang một túi hành lý xách tay.'),
  ('travel','departure','/dɪˈpɑːrtʃər/','noun','sự khởi hành','The departure gate changed to Gate 12.','Cổng khởi hành đã đổi sang Cổng 12.'),
  ('travel','destination','/ˌdestɪˈneɪʃn/','noun','điểm đến','The destination is popular with business travelers.','Điểm đến này phổ biến với khách công tác.'),
  ('travel','excursion','/ɪkˈskɜːrʒn/','noun','chuyến tham quan','The hotel offers a short excursion to the harbor.','Khách sạn có chuyến tham quan ngắn tới bến cảng.'),
  ('travel','fare','/fer/','noun','giá vé','The train fare is lower when booked in advance.','Giá vé tàu thấp hơn khi đặt trước.'),
  ('travel','itinerary','/aɪˈtɪnəreri/','noun','lịch trình chuyến đi','The itinerary lists every client visit.','Lịch trình chuyến đi liệt kê mọi buổi gặp khách hàng.'),
  ('travel','luggage','/ˈlʌɡɪdʒ/','noun','hành lý','The airline delivered the luggage to the hotel.','Hãng hàng không đã chuyển hành lý tới khách sạn.'),
  ('travel','passport','/ˈpæspɔːrt/','noun','hộ chiếu','Please keep your passport in a secure place.','Vui lòng giữ hộ chiếu ở nơi an toàn.'),
  ('travel','reservation','/ˌrezərˈveɪʃn/','noun','việc đặt trước','The reservation is under the company name.','Đặt chỗ được thực hiện dưới tên công ty.'),
  ('travel','shuttle','/ˈʃʌtl/','noun','xe đưa đón','A shuttle runs between the airport and the hotel.','Xe đưa đón chạy giữa sân bay và khách sạn.'),
  ('travel','terminal','/ˈtɜːrmɪnl/','noun','nhà ga','The international terminal is being renovated.','Nhà ga quốc tế đang được cải tạo.'),
  ('travel','transfer','/ˈtrænsfɜːr/','noun','chuyến trung chuyển','The transfer takes about twenty minutes.','Chuyến trung chuyển mất khoảng hai mươi phút.'),
  ('travel','vacancy','/ˈveɪkənsi/','noun','phòng còn trống','The hotel has a vacancy for Saturday night.','Khách sạn còn phòng vào tối thứ Bảy.'),
  ('travel','vehicle','/ˈviːəkl/','noun','phương tiện','The rental vehicle is parked outside the lobby.','Phương tiện thuê đang đỗ bên ngoài sảnh.'),
  ('travel','visa','/ˈviːzə/','noun','thị thực','The visa application requires a recent photograph.','Đơn xin thị thực cần một ảnh chụp gần đây.'),
  ('travel','aisle','/aɪl/','noun','lối đi giữa các hàng ghế','She chose an aisle seat for the long flight.','Cô ấy chọn ghế cạnh lối đi cho chuyến bay dài.'),
  ('travel','customs','/ˈkʌstəmz/','noun','hải quan','All visitors must pass through customs.','Mọi du khách đều phải qua khu vực hải quan.'),
  ('travel','delay','/dɪˈleɪ/','noun','sự trì hoãn','The delay was caused by heavy rain.','Sự trì hoãn xảy ra do mưa lớn.'),
  ('travel','lobby','/ˈlɑːbi/','noun','sảnh','The driver is waiting in the hotel lobby.','Tài xế đang đợi ở sảnh khách sạn.'),
  ('travel','receipt','/rɪˈsiːt/','noun','biên lai','Keep the receipt for your expense report.','Hãy giữ biên lai cho báo cáo chi phí.'),
  ('travel','route','/ruːt/','noun','tuyến đường','The bus route stops near the exhibition hall.','Tuyến xe buýt dừng gần nhà triển lãm.'),
  ('travel','suitcase','/ˈsuːtkeɪs/','noun','va-li','The suitcase fits in the overhead compartment.','Va-li vừa với ngăn hành lý phía trên.'),
  ('travel','tourism','/ˈtʊrɪzəm/','noun','ngành du lịch','Tourism supports many local businesses.','Ngành du lịch hỗ trợ nhiều doanh nghiệp địa phương.'),
  ('travel','weather','/ˈweðər/','noun','thời tiết','The weather forecast predicts clear skies.','Dự báo thời tiết cho biết trời quang.'),
  ('travel','check-in','/ˈtʃek ɪn/','noun','thủ tục nhận phòng','Check-in begins at three o’clock in the afternoon.','Thủ tục nhận phòng bắt đầu lúc ba giờ chiều.'),
  ('finance','account','/əˈkaʊnt/','noun','tài khoản','The account shows the latest transaction.','Tài khoản hiển thị giao dịch mới nhất.'),
  ('finance','asset','/ˈæset/','noun','tài sản','The building is a valuable company asset.','Tòa nhà là một tài sản có giá trị của công ty.'),
  ('finance','balance','/ˈbæləns/','noun','số dư','The balance was checked before the payment.','Số dư đã được kiểm tra trước khi thanh toán.'),
  ('finance','budget','/ˈbʌdʒɪt/','noun','ngân sách','The department stayed within its annual budget.','Phòng ban đã chi tiêu trong phạm vi ngân sách năm.'),
  ('finance','capital','/ˈkæpɪtl/','noun','vốn','The company raised capital for a new facility.','Công ty đã huy động vốn cho cơ sở mới.'),
  ('finance','cashier','/kæˈʃɪr/','noun','nhân viên thu ngân','The cashier issued a receipt for the purchase.','Nhân viên thu ngân đã xuất hóa đơn cho giao dịch mua.'),
  ('finance','cost','/kɔːst/','noun','chi phí','The cost includes delivery and installation.','Chi phí bao gồm giao hàng và lắp đặt.'),
  ('finance','credit','/ˈkredɪt/','noun','tín dụng','The supplier offered credit to regular customers.','Nhà cung cấp cho khách hàng thân thiết mua chịu.'),
  ('finance','currency','/ˈkɜːrənsi/','noun','tiền tệ','The exchange office displays the local currency rate.','Quầy đổi tiền niêm yết tỷ giá tiền tệ địa phương.'),
  ('finance','deposit','/dɪˈpɑːzɪt/','noun','khoản tiền đặt cọc','A deposit is required to confirm the order.','Cần đặt cọc để xác nhận đơn hàng.'),
  ('finance','discount','/ˈdɪskaʊnt/','noun','khoản giảm giá','The supplier gave us a discount on bulk orders.','Nhà cung cấp giảm giá cho đơn hàng số lượng lớn.'),
  ('finance','expense','/ɪkˈspens/','noun','khoản chi phí','Every business expense needs a supporting receipt.','Mỗi khoản chi phí kinh doanh cần có biên lai đi kèm.'),
  ('finance','forecast','/ˈfɔːrkæst/','noun','dự báo','The forecast estimates higher sales next quarter.','Dự báo ước tính doanh số quý tới sẽ cao hơn.'),
  ('finance','income','/ˈɪnkʌm/','noun','thu nhập','The report compares income across four regions.','Báo cáo so sánh thu nhập giữa bốn khu vực.'),
  ('finance','invoice','/ˈɪnvɔɪs/','noun','hóa đơn thanh toán','The invoice is payable within thirty days.','Hóa đơn cần được thanh toán trong vòng ba mươi ngày.'),
  ('finance','investment','/ɪnˈvestmənt/','noun','khoản đầu tư','The investment supports the expansion plan.','Khoản đầu tư hỗ trợ kế hoạch mở rộng.'),
  ('finance','loan','/loʊn/','noun','khoản vay','The bank approved a loan for the equipment purchase.','Ngân hàng đã duyệt khoản vay mua thiết bị.'),
  ('finance','loss','/lɔːs/','noun','khoản lỗ','The company reported a smaller loss this year.','Công ty báo cáo khoản lỗ nhỏ hơn trong năm nay.'),
  ('finance','margin','/ˈmɑːrdʒɪn/','noun','biên lợi nhuận','The product has a higher profit margin.','Sản phẩm có biên lợi nhuận cao hơn.'),
  ('finance','payment','/ˈpeɪmənt/','noun','khoản thanh toán','The payment arrived before the due date.','Khoản thanh toán đã đến trước ngày đến hạn.'),
  ('finance','profit','/ˈprɑːfɪt/','noun','lợi nhuận','The store used its profit to improve the service.','Cửa hàng dùng lợi nhuận để cải thiện dịch vụ.'),
  ('finance','receipt','/rɪˈsiːt/','noun','biên lai','Please submit the receipt with your claim.','Vui lòng nộp biên lai cùng với yêu cầu hoàn tiền.'),
  ('finance','revenue','/ˈrevənuː/','noun','doanh thu','Online sales generated most of the revenue.','Doanh số trực tuyến tạo ra phần lớn doanh thu.'),
  ('finance','salary','/ˈsæləri/','noun','tiền lương','The salary is reviewed once a year.','Tiền lương được xem xét mỗi năm một lần.'),
  ('finance','savings','/ˈseɪvɪŋz/','noun','tiền tiết kiệm','The company used its savings for renovations.','Công ty sử dụng tiền tiết kiệm để sửa sang.'),
  ('finance','statement','/ˈsteɪtmənt/','noun','bảng sao kê','The monthly statement lists all account activity.','Bảng sao kê hàng tháng liệt kê mọi hoạt động tài khoản.'),
  ('finance','tax','/tæks/','noun','thuế','The tax rate depends on the type of service.','Mức thuế phụ thuộc vào loại dịch vụ.'),
  ('finance','transaction','/trænˈzækʃn/','noun','giao dịch','The transaction appears on the online statement.','Giao dịch xuất hiện trên sao kê trực tuyến.'),
  ('finance','wage','/weɪdʒ/','noun','tiền công','The hourly wage is listed in the employment agreement.','Mức tiền công theo giờ được ghi trong thỏa thuận lao động.'),
  ('finance','withdrawal','/wɪðˈdrɔːəl/','noun','khoản rút tiền','The withdrawal was recorded on the same day.','Khoản rút tiền được ghi nhận trong cùng ngày.')
),
numbered AS (
  SELECT t.id AS topic_id, s.word, s.phonetic, s.part_of_speech, s.meaning_vi,
         s.example_en, s.example_vi,
         row_number() OVER (PARTITION BY t.id ORDER BY s.word)::smallint AS display_order
  FROM seed s
  JOIN app.vocab_topics t ON t.slug = s.topic_slug
)
INSERT INTO app.vocab_words
  (topic_id, word, phonetic, part_of_speech, meaning_vi, example_en, example_vi, display_order)
SELECT topic_id, word, phonetic, part_of_speech, meaning_vi, example_en, example_vi, display_order
FROM numbered
ON CONFLICT (topic_id, word) DO UPDATE SET
  phonetic = EXCLUDED.phonetic,
  part_of_speech = EXCLUDED.part_of_speech,
  meaning_vi = EXCLUDED.meaning_vi,
  example_en = EXCLUDED.example_en,
  example_vi = EXCLUDED.example_vi,
  display_order = EXCLUDED.display_order;

GRANT SELECT ON app.vocab_topics, app.vocab_words TO vchat_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.vocab_user_settings,
  app.vocab_user_word_progress,
  app.vocab_study_sessions,
  app.vocab_session_answers,
  app.vocab_daily_stats
TO vchat_app;

ALTER TABLE app.vocab_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vocab_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vocab_user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vocab_user_word_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vocab_study_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vocab_session_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vocab_daily_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vchat_app_read ON app.vocab_topics;
CREATE POLICY vchat_app_read ON app.vocab_topics FOR SELECT TO vchat_app USING (true);
DROP POLICY IF EXISTS vchat_app_read ON app.vocab_words;
CREATE POLICY vchat_app_read ON app.vocab_words FOR SELECT TO vchat_app USING (true);

DROP POLICY IF EXISTS vchat_app_all ON app.vocab_user_settings;
CREATE POLICY vchat_app_all ON app.vocab_user_settings
  TO vchat_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS vchat_app_all ON app.vocab_user_word_progress;
CREATE POLICY vchat_app_all ON app.vocab_user_word_progress
  TO vchat_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS vchat_app_all ON app.vocab_study_sessions;
CREATE POLICY vchat_app_all ON app.vocab_study_sessions
  TO vchat_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS vchat_app_all ON app.vocab_session_answers;
CREATE POLICY vchat_app_all ON app.vocab_session_answers
  TO vchat_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS vchat_app_all ON app.vocab_daily_stats;
CREATE POLICY vchat_app_all ON app.vocab_daily_stats
  TO vchat_app USING (true) WITH CHECK (true);
