ALTER TABLE app.vocab_topics
  ADD COLUMN IF NOT EXISTS group_slug varchar(32) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS group_name varchar(100) NOT NULL DEFAULT 'Bộ cũ',
  ADD COLUMN IF NOT EXISTS group_order smallint NOT NULL DEFAULT 11;

UPDATE app.vocab_topics
SET display_order = display_order + 100
WHERE group_slug = 'legacy' AND display_order <= 100;

WITH catalog(id, slug, name, icon, description, display_order, group_slug, group_name, group_order) AS (
  VALUES
  ('a1000000-0000-4000-8000-000000000004','contracts','Contracts & Agreements – Hợp đồng','📄','Từ vựng về điều khoản, nghĩa vụ và quy trình ký kết hợp đồng.',1,'business','Business & Management – Kinh doanh và quản lý',1),
  ('a1000000-0000-4000-8000-000000000005','marketing','Marketing & Market Research – Tiếp thị','📣','Từ vựng về chiến dịch, khách hàng và nghiên cứu thị trường.',2,'business','Business & Management – Kinh doanh và quản lý',1),
  ('a1000000-0000-4000-8000-000000000006','warranties','Warranties & Guarantees – Bảo hành','🛠️','Từ vựng về bảo hành, đổi trả và hỗ trợ sản phẩm.',3,'business','Business & Management – Kinh doanh và quản lý',1),
  ('a1000000-0000-4000-8000-000000000007','planning','Business Planning – Kế hoạch kinh doanh','📈','Từ vựng về mục tiêu, dự báo và lập kế hoạch kinh doanh.',4,'business','Business & Management – Kinh doanh và quản lý',1),
  ('a1000000-0000-4000-8000-000000000008','conferences','Conferences & Business Events – Hội nghị','🎤','Từ vựng về hội nghị, diễn giả và sự kiện doanh nghiệp.',5,'business','Business & Management – Kinh doanh và quản lý',1),
  ('a1000000-0000-4000-8000-000000000009','computers-it','Computers & IT – Máy tính và CNTT','💻','Phần mềm, hệ thống và thao tác công nghệ trong môi trường làm việc.',6,'office','Office & Administration – Văn phòng và hành chính',2),
  ('a1000000-0000-4000-8000-000000000010','office-equipment','Office Equipment – Thiết bị văn phòng','🖨️','Thiết bị, vật tư và bảo trì nơi làm việc.',7,'office','Office & Administration – Văn phòng và hành chính',2),
  ('a1000000-0000-4000-8000-000000000011','office-procedures','Office Procedures – Quy trình văn phòng','📋','Quy định, phê duyệt và quy trình hành chính.',8,'office','Office & Administration – Văn phòng và hành chính',2),
  ('a1000000-0000-4000-8000-000000000012','electronics','Electronics – Thiết bị điện tử','🔌','Linh kiện điện tử, vận hành và sửa chữa thiết bị.',9,'office','Office & Administration – Văn phòng và hành chính',2),
  ('a1000000-0000-4000-8000-000000000013','correspondence','Correspondence – Thư tín và email','✉️','Thư tín, email và trao đổi thông tin công việc.',10,'office','Office & Administration – Văn phòng và hành chính',2),
  ('a1000000-0000-4000-8000-000000000014','job-recruiting','Job Advertising & Recruiting – Quảng cáo tuyển dụng','📢','Tin tuyển dụng, ứng viên và quy trình tìm nhân sự.',11,'hr','Human Resources – Nhân sự và tuyển dụng',3),
  ('a1000000-0000-4000-8000-000000000015','applying-interviewing','Applying & Interviewing – Ứng tuyển và phỏng vấn','📝','Hồ sơ ứng tuyển, phỏng vấn và năng lực nghề nghiệp.',12,'hr','Human Resources – Nhân sự và tuyển dụng',3),
  ('a1000000-0000-4000-8000-000000000016','hiring-training','Hiring & Training – Tuyển dụng và đào tạo','🎓','Tuyển nhân viên mới, định hướng và đào tạo tại nơi làm việc.',13,'hr','Human Resources – Nhân sự và tuyển dụng',3),
  ('a1000000-0000-4000-8000-000000000017','salaries-benefits','Salaries & Benefits – Lương và phúc lợi','💼','Lương, phụ cấp và chế độ dành cho nhân viên.',14,'hr','Human Resources – Nhân sự và tuyển dụng',3),
  ('a1000000-0000-4000-8000-000000000018','promotions-awards','Promotions & Awards – Thăng chức và khen thưởng','🏆','Thăng chức, thành tích và hình thức khen thưởng.',15,'hr','Human Resources – Nhân sự và tuyển dụng',3),
  ('a1000000-0000-4000-8000-000000000019','shopping-retail','Shopping & Retail – Mua sắm','🛍️','Mua hàng, giá bán, giảm giá và giao dịch bán lẻ.',16,'purchasing','Purchasing & Customer Service – Mua sắm và khách hàng',4),
  ('a1000000-0000-4000-8000-000000000020','ordering-supplies','Ordering Supplies – Đặt hàng vật tư','📦','Nhà cung cấp, đơn đặt hàng và số lượng vật tư.',17,'purchasing','Purchasing & Customer Service – Mua sắm và khách hàng',4),
  ('a1000000-0000-4000-8000-000000000021','shipping-delivery','Shipping & Delivery – Vận chuyển','🚚','Gửi hàng, giao nhận và theo dõi lô hàng.',18,'purchasing','Purchasing & Customer Service – Mua sắm và khách hàng',4),
  ('a1000000-0000-4000-8000-000000000022','invoices-billing','Invoices & Billing – Hóa đơn','🧾','Hóa đơn, khoản thanh toán và phí dịch vụ.',19,'purchasing','Purchasing & Customer Service – Mua sắm và khách hàng',4),
  ('a1000000-0000-4000-8000-000000000023','customer-service','Customer Service – Chăm sóc khách hàng','🎧','Khiếu nại, hỗ trợ và giải pháp dành cho khách hàng.',20,'purchasing','Purchasing & Customer Service – Mua sắm và khách hàng',4),
  ('a1000000-0000-4000-8000-000000000024','travel','Business Travel – Công tác','🧳','Lịch trình, chi phí và các sắp xếp cho chuyến công tác.',21,'travel','Travel & Transportation – Du lịch và giao thông',5),
  ('a1000000-0000-4000-8000-000000000025','airlines-air-travel','Airlines & Air Travel – Hàng không','✈️','Chuyến bay, khởi hành và thủ tục lên máy bay.',22,'travel','Travel & Transportation – Du lịch và giao thông',5),
  ('a1000000-0000-4000-8000-000000000026','public-transportation','Public Transportation – Giao thông công cộng','🚉','Hành khách, tuyến đường và phương tiện công cộng.',23,'travel','Travel & Transportation – Du lịch và giao thông',5),
  ('a1000000-0000-4000-8000-000000000027','hotels-accommodation','Hotels & Accommodation – Khách sạn','🏨','Đặt phòng, chỗ trống và dịch vụ lưu trú.',24,'travel','Travel & Transportation – Du lịch và giao thông',5),
  ('a1000000-0000-4000-8000-000000000028','car-rentals','Car Rentals – Thuê xe','🚗','Thuê xe, phương tiện và bảo hiểm chuyến đi.',25,'travel','Travel & Transportation – Du lịch và giao thông',5),
  ('a1000000-0000-4000-8000-000000000029','movies-cinema','Movies & Cinema – Điện ảnh','🎬','Suất chiếu, đạo diễn và dịch vụ tại rạp phim.',26,'entertainment','Entertainment & Media – Giải trí và truyền thông',6),
  ('a1000000-0000-4000-8000-000000000030','theater-performing-arts','Theater & Performing Arts – Nghệ thuật biểu diễn','🎭','Buổi diễn, khán giả và sân khấu.',27,'entertainment','Entertainment & Media – Giải trí và truyền thông',6),
  ('a1000000-0000-4000-8000-000000000031','music-concerts','Music & Concerts – Âm nhạc','🎵','Buổi hòa nhạc, dàn nhạc và lễ hội âm nhạc.',28,'entertainment','Entertainment & Media – Giải trí và truyền thông',6),
  ('a1000000-0000-4000-8000-000000000032','museums-exhibitions','Museums & Exhibitions – Bảo tàng','🖼️','Triển lãm, hiện vật và bộ sưu tập.',29,'entertainment','Entertainment & Media – Giải trí và truyền thông',6),
  ('a1000000-0000-4000-8000-000000000033','media-publishing','Media & Publishing – Truyền thông','📰','Ấn phẩm, nhà báo và hoạt động phát sóng.',30,'entertainment','Entertainment & Media – Giải trí và truyền thông',6),
  ('a1000000-0000-4000-8000-000000000034','doctors-office','Doctor''s Office – Phòng khám','🩺','Cuộc hẹn, bác sĩ và triệu chứng thường gặp.',31,'healthcare','Healthcare – Y tế và sức khỏe',7),
  ('a1000000-0000-4000-8000-000000000035','dentistry','Dentistry – Nha khoa','🦷','Khám răng, điều trị và chăm sóc nha khoa.',32,'healthcare','Healthcare – Y tế và sức khỏe',7),
  ('a1000000-0000-4000-8000-000000000036','health-insurance','Health Insurance – Bảo hiểm y tế','🏥','Phạm vi bảo hiểm, phí bảo hiểm và yêu cầu chi trả.',33,'healthcare','Healthcare – Y tế và sức khỏe',7),
  ('a1000000-0000-4000-8000-000000000037','hospitals','Hospitals – Bệnh viện','🏨','Nhập viện, chăm sóc bệnh nhân và xuất viện.',34,'healthcare','Healthcare – Y tế và sức khỏe',7),
  ('a1000000-0000-4000-8000-000000000038','pharmacy','Pharmacy – Nhà thuốc','💊','Đơn thuốc, liều dùng và thuốc điều trị.',35,'healthcare','Healthcare – Y tế và sức khỏe',7),
  ('a1000000-0000-4000-8000-000000000003','finance','Banking – Ngân hàng','🏦','Tài khoản, tiền gửi, rút tiền và giao dịch ngân hàng.',36,'finance','Finance & Accounting – Tài chính và kế toán',8),
  ('a1000000-0000-4000-8000-000000000039','accounting','Accounting – Kế toán','🧮','Số dư, tính toán và ghi nhận chi phí.',37,'finance','Finance & Accounting – Tài chính và kế toán',8),
  ('a1000000-0000-4000-8000-000000000040','investments','Investments – Đầu tư','📊','Đầu tư, cổ đông và thị trường chứng khoán.',38,'finance','Finance & Accounting – Tài chính và kế toán',8),
  ('a1000000-0000-4000-8000-000000000041','taxes-compliance','Taxes & Compliance – Thuế','📑','Thuế, khoản khấu trừ và tuân thủ quy định.',39,'finance','Finance & Accounting – Tài chính và kế toán',8),
  ('a1000000-0000-4000-8000-000000000042','financial-statements','Financial Statements – Báo cáo tài chính','📈','Doanh thu, lợi nhuận và các báo cáo tài chính.',40,'finance','Finance & Accounting – Tài chính và kế toán',8),
  ('a1000000-0000-4000-8000-000000000043','board-meetings','Board Meetings – Họp ban điều hành','🗣️','Chương trình họp, ủy ban và nghị quyết.',41,'property','Property & Manufacturing – Bất động sản và sản xuất',9),
  ('a1000000-0000-4000-8000-000000000044','quality-control','Quality Control – Kiểm soát chất lượng','✅','Kiểm tra, phát hiện lỗi và tiêu chuẩn chất lượng.',42,'property','Property & Manufacturing – Bất động sản và sản xuất',9),
  ('a1000000-0000-4000-8000-000000000045','product-development','Product Development – Phát triển sản phẩm','💡','Nguyên mẫu, đổi mới và nghiên cứu sản phẩm.',43,'property','Property & Manufacturing – Bất động sản và sản xuất',9),
  ('a1000000-0000-4000-8000-000000000046','renting-leasing','Renting & Leasing – Thuê mặt bằng','🔑','Hợp đồng thuê, người thuê và chủ nhà.',44,'property','Property & Manufacturing – Bất động sản và sản xuất',9),
  ('a1000000-0000-4000-8000-000000000047','real-estate','Real Estate – Bất động sản','🏢','Tài sản, mua bán và xây dựng bất động sản.',45,'property','Property & Manufacturing – Bất động sản và sản xuất',9),
  ('a1000000-0000-4000-8000-000000000048','manufacturing','Manufacturing – Sản xuất','🏭','Nhà máy, chế tạo và lắp ráp sản phẩm.',46,'industry','Industry & Daily Activities – Công nghiệp và hoạt động thường ngày',10),
  ('a1000000-0000-4000-8000-000000000049','environment-safety','Environment & Safety – Môi trường và an toàn','♻️','Ô nhiễm, an toàn lao động và tái chế.',47,'industry','Industry & Daily Activities – Công nghiệp và hoạt động thường ngày',10),
  ('a1000000-0000-4000-8000-000000000050','restaurants-dining','Restaurants & Dining – Nhà hàng','🍽️','Thực đơn, đồ uống và đặt bàn tại nhà hàng.',48,'industry','Industry & Daily Activities – Công nghiệp và hoạt động thường ngày',10),
  ('a1000000-0000-4000-8000-000000000051','cooking-food-preparation','Cooking & Food Preparation – Chế biến thực phẩm','🥗','Nguyên liệu, sơ chế và phục vụ món ăn.',49,'industry','Industry & Daily Activities – Công nghiệp và hoạt động thường ngày',10),
  ('a1000000-0000-4000-8000-000000000052','community-relations','Community Relations – Quan hệ cộng đồng','🤝','Hoạt động từ thiện, tài trợ và đóng góp cộng đồng.',50,'industry','Industry & Daily Activities – Công nghiệp và hoạt động thường ngày',10)
)
INSERT INTO app.vocab_topics (id, slug, name, icon, description, display_order, group_slug, group_name, group_order)
SELECT id::uuid, slug, name, icon, description, display_order, group_slug, group_name, group_order
FROM catalog
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  icon = EXCLUDED.icon,
  description = EXCLUDED.description,
  display_order = EXCLUDED.display_order,
  group_slug = EXCLUDED.group_slug,
  group_name = EXCLUDED.group_name,
  group_order = EXCLUDED.group_order;

UPDATE app.vocab_topics
SET name = 'Office & Administration – Văn phòng (bộ cũ)',
    description = 'Bộ từ vựng tổng quan đã lưu từ phiên bản trước; tiến độ cũ vẫn được giữ nguyên.',
    display_order = 51,
    group_slug = 'legacy',
    group_name = 'Bộ từ vựng cũ',
    group_order = 11
WHERE slug = 'office';

UPDATE app.vocab_words w
SET display_order = w.display_order + 1000
FROM app.vocab_topics t
WHERE w.topic_id = t.id AND t.display_order BETWEEN 6 AND 50;

WITH shared_words(group_slug, word, phonetic, part_of_speech, meaning_vi) AS (
  VALUES
  ('common','budget','/ˈbʌdʒɪt/','noun','ngân sách'),
  ('common','colleague','/ˈkɑːliːɡ/','noun','đồng nghiệp'),
  ('common','deadline','/ˈdedlaɪn/','noun','hạn chót'),
  ('common','department','/dɪˈpɑːrtmənt/','noun','phòng ban'),
  ('common','document','/ˈdɑːkjumənt/','noun','tài liệu'),
  ('common','feedback','/ˈfiːdbæk/','noun','ý kiến phản hồi'),
  ('common','manager','/ˈmænɪdʒər/','noun','người quản lý'),
  ('common','meeting','/ˈmiːtɪŋ/','noun','cuộc họp'),
  ('common','order','/ˈɔːrdər/','noun','đơn đặt hàng'),
  ('common','policy','/ˈpɑːləsi/','noun','chính sách'),
  ('common','project','/ˈprɑːdʒekt/','noun','dự án'),
  ('common','report','/rɪˈpɔːrt/','noun','báo cáo'),
  ('common','request','/rɪˈkwest/','noun','yêu cầu'),
  ('common','schedule','/ˈskedʒuːl/','noun','lịch trình'),
  ('common','service','/ˈsɜːrvɪs/','noun','dịch vụ'),
  ('common','staff','/stæf/','noun','nhân viên'),
  ('common','supplier','/səˈplaɪər/','noun','nhà cung cấp'),
  ('common','training','/ˈtreɪnɪŋ/','noun','việc đào tạo'),
  ('common','update','/ˈʌpdeɪt/','noun','bản cập nhật'),
  ('common','contract','/ˈkɑːntrækt/','noun','hợp đồng'),
  ('common','customer','/ˈkʌstəmər/','noun','khách hàng'),
  ('common','facility','/fəˈsɪləti/','noun','cơ sở vật chất'),
  ('common','information','/ˌɪnfərˈmeɪʃn/','noun','thông tin'),
  ('common','payment','/ˈpeɪmənt/','noun','khoản thanh toán'),
  ('common','procedure','/prəˈsiːdʒər/','noun','quy trình'),

  ('office','computer','/kəmˈpjuːtər/','noun','máy tính'),
  ('office','software','/ˈsɔːftwer/','noun','phần mềm'),
  ('office','install','/ɪnˈstɔːl/','verb','cài đặt'),
  ('office','printer','/ˈprɪntər/','noun','máy in'),
  ('office','equipment','/ɪˈkwɪpmənt/','noun','thiết bị'),
  ('office','device','/dɪˈvaɪs/','noun','thiết bị điện tử'),
  ('office','procedure','/prəˈsiːdʒər/','noun','quy trình'),
  ('office','approval','/əˈpruːvl/','noun','sự phê duyệt'),
  ('office','component','/kəmˈpoʊnənt/','noun','bộ phận; linh kiện'),
  ('office','operate','/ˈɑːpəreɪt/','verb','vận hành'),
  ('office','attachment','/əˈtætʃmənt/','noun','tệp đính kèm'),
  ('office','notify','/ˈnoʊtɪfaɪ/','verb','thông báo'),
  ('office','respond','/rɪˈspɑːnd/','verb','phản hồi'),
  ('office','keyboard','/ˈkiːbɔːrd/','noun','bàn phím'),
  ('office','spreadsheet','/ˈspredʃiːt/','noun','bảng tính'),

  ('hr','vacancy','/ˈveɪkənsi/','noun','vị trí tuyển dụng'),
  ('hr','applicant','/ˈæplɪkənt/','noun','ứng viên'),
  ('hr','recruit','/rɪˈkruːt/','verb','tuyển dụng'),
  ('hr','resume','/ˈrezəmeɪ/','noun','sơ yếu lý lịch'),
  ('hr','interview','/ˈɪntərvjuː/','noun','buổi phỏng vấn'),
  ('hr','qualification','/ˌkwɑːlɪfɪˈkeɪʃn/','noun','bằng cấp; năng lực'),
  ('hr','hire','/ˈhaɪər/','verb','thuê; tuyển dụng'),
  ('hr','orientation','/ˌɔːriənˈteɪʃn/','noun','buổi định hướng'),
  ('hr','salary','/ˈsæləri/','noun','tiền lương'),
  ('hr','allowance','/əˈlaʊəns/','noun','tiền phụ cấp'),
  ('hr','benefit','/ˈbenɪfɪt/','noun','phúc lợi'),
  ('hr','promotion','/prəˈmoʊʃn/','noun','sự thăng chức'),
  ('hr','achievement','/əˈtʃiːvmənt/','noun','thành tích'),
  ('hr','reward','/rɪˈwɔːrd/','noun','phần thưởng'),
  ('hr','appraisal','/əˈpreɪzl/','noun','đánh giá hiệu suất'),

  ('purchasing','purchase','/ˈpɜːrtʃəs/','noun','việc mua hàng'),
  ('purchasing','discount','/ˈdɪskaʊnt/','noun','mức giảm giá'),
  ('purchasing','receipt','/rɪˈsiːt/','noun','biên lai'),
  ('purchasing','quantity','/ˈkwɑːntəti/','noun','số lượng'),
  ('purchasing','shipment','/ˈʃɪpmənt/','noun','lô hàng'),
  ('purchasing','deliver','/dɪˈlɪvər/','verb','giao hàng'),
  ('purchasing','carrier','/ˈkæriər/','noun','đơn vị vận chuyển'),
  ('purchasing','invoice','/ˈɪnvɔɪs/','noun','hóa đơn'),
  ('purchasing','charge','/tʃɑːrdʒ/','noun','khoản phí'),
  ('purchasing','complaint','/kəmˈpleɪnt/','noun','lời phàn nàn'),
  ('purchasing','refund','/ˈriːfʌnd/','noun','khoản hoàn tiền'),
  ('purchasing','assistance','/əˈsɪstəns/','noun','sự hỗ trợ'),
  ('purchasing','warehouse','/ˈwerhaʊs/','noun','nhà kho'),
  ('purchasing','dispatch','/dɪˈspætʃ/','verb','gửi đi; điều phối'),
  ('purchasing','merchandise','/ˈmɜːrtʃəndaɪs/','noun','hàng hóa'),

  ('travel','itinerary','/aɪˈtɪnəreri/','noun','lịch trình chuyến đi'),
  ('travel','destination','/ˌdestɪˈneɪʃn/','noun','điểm đến'),
  ('travel','expense','/ɪkˈspens/','noun','chi phí'),
  ('travel','departure','/dɪˈpɑːrtʃər/','noun','sự khởi hành'),
  ('travel','boarding','/ˈbɔːrdɪŋ/','noun','việc lên máy bay'),
  ('travel','flight','/flaɪt/','noun','chuyến bay'),
  ('travel','passenger','/ˈpæsɪndʒər/','noun','hành khách'),
  ('travel','platform','/ˈplætfɔːrm/','noun','sân ga'),
  ('travel','route','/ruːt/','noun','tuyến đường'),
  ('travel','reservation','/ˌrezərˈveɪʃn/','noun','việc đặt chỗ'),
  ('travel','accommodation','/əˌkɑːməˈdeɪʃn/','noun','chỗ ở'),
  ('travel','rental','/ˈrentl/','noun','việc thuê'),
  ('travel','vehicle','/ˈviːəkl/','noun','phương tiện'),
  ('travel','insurance','/ɪnˈʃʊrəns/','noun','bảo hiểm'),
  ('travel','terminal','/ˈtɜːrmɪnl/','noun','nhà ga'),

  ('entertainment','screening','/ˈskriːnɪŋ/','noun','buổi chiếu'),
  ('entertainment','director','/dəˈrektər/','noun','đạo diễn'),
  ('entertainment','admission','/ədˈmɪʃn/','noun','vé vào cửa'),
  ('entertainment','performance','/pərˈfɔːrməns/','noun','buổi biểu diễn'),
  ('entertainment','audience','/ˈɔːdiəns/','noun','khán giả'),
  ('entertainment','stage','/steɪdʒ/','noun','sân khấu'),
  ('entertainment','concert','/ˈkɑːnsərt/','noun','buổi hòa nhạc'),
  ('entertainment','orchestra','/ˈɔːrkɪstrə/','noun','dàn nhạc'),
  ('entertainment','festival','/ˈfestɪvl/','noun','lễ hội'),
  ('entertainment','exhibition','/ˌeksɪˈbɪʃn/','noun','cuộc triển lãm'),
  ('entertainment','collection','/kəˈlekʃn/','noun','bộ sưu tập'),
  ('entertainment','publication','/ˌpʌblɪˈkeɪʃn/','noun','ấn phẩm'),
  ('entertainment','journalist','/ˈdʒɜːrnəlɪst/','noun','nhà báo'),
  ('entertainment','broadcast','/ˈbrɔːdkæst/','noun','chương trình phát sóng'),
  ('entertainment','exhibit','/ɪɡˈzɪbɪt/','noun','hiện vật trưng bày'),

  ('healthcare','appointment','/əˈpɔɪntmənt/','noun','cuộc hẹn'),
  ('healthcare','physician','/fɪˈzɪʃn/','noun','bác sĩ'),
  ('healthcare','symptom','/ˈsɪmptəm/','noun','triệu chứng'),
  ('healthcare','dentist','/ˈdentɪst/','noun','nha sĩ'),
  ('healthcare','treatment','/ˈtriːtmənt/','noun','việc điều trị'),
  ('healthcare','coverage','/ˈkʌvərɪdʒ/','noun','phạm vi bảo hiểm'),
  ('healthcare','premium','/ˈpriːmiəm/','noun','phí bảo hiểm'),
  ('healthcare','claim','/kleɪm/','noun','yêu cầu chi trả'),
  ('healthcare','patient','/ˈpeɪʃnt/','noun','bệnh nhân'),
  ('healthcare','discharge','/ˈdɪstʃɑːrdʒ/','noun','việc xuất viện'),
  ('healthcare','prescription','/prɪˈskrɪpʃn/','noun','đơn thuốc'),
  ('healthcare','dosage','/ˈdoʊsɪdʒ/','noun','liều lượng'),
  ('healthcare','medication','/ˌmedɪˈkeɪʃn/','noun','thuốc điều trị'),
  ('healthcare','clinic','/ˈklɪnɪk/','noun','phòng khám'),
  ('healthcare','insurance','/ɪnˈʃʊrəns/','noun','bảo hiểm'),

  ('finance','deposit','/dɪˈpɑːzɪt/','noun','khoản tiền gửi'),
  ('finance','withdraw','/wɪðˈdrɔː/','verb','rút tiền'),
  ('finance','account','/əˈkaʊnt/','noun','tài khoản'),
  ('finance','balance','/ˈbæləns/','noun','số dư'),
  ('finance','calculate','/ˈkælkjuleɪt/','verb','tính toán'),
  ('finance','investment','/ɪnˈvestmənt/','noun','khoản đầu tư'),
  ('finance','shareholder','/ˈʃerhoʊldər/','noun','cổ đông'),
  ('finance','stock','/stɑːk/','noun','cổ phiếu'),
  ('finance','tax','/tæks/','noun','thuế'),
  ('finance','deduction','/dɪˈdʌkʃn/','noun','khoản khấu trừ'),
  ('finance','regulation','/ˌreɡjuˈleɪʃn/','noun','quy định'),
  ('finance','revenue','/ˈrevənuː/','noun','doanh thu'),
  ('finance','profit','/ˈprɑːfɪt/','noun','lợi nhuận'),
  ('finance','statement','/ˈsteɪtmənt/','noun','báo cáo'),
  ('finance','interest','/ˈɪntrəst/','noun','lãi suất'),

  ('property','agenda','/əˈdʒendə/','noun','chương trình nghị sự'),
  ('property','committee','/kəˈmɪti/','noun','ủy ban'),
  ('property','resolution','/ˌrezəˈluːʃn/','noun','nghị quyết'),
  ('property','inspection','/ɪnˈspekʃn/','noun','việc kiểm tra'),
  ('property','defect','/ˈdiːfekt/','noun','lỗi'),
  ('property','standard','/ˈstændərd/','noun','tiêu chuẩn'),
  ('property','prototype','/ˈproʊtətaɪp/','noun','nguyên mẫu'),
  ('property','innovation','/ˌɪnəˈveɪʃn/','noun','sự đổi mới'),
  ('property','lease','/liːs/','noun','hợp đồng thuê'),
  ('property','tenant','/ˈtenənt/','noun','người thuê'),
  ('property','landlord','/ˈlændlɔːrd/','noun','chủ nhà'),
  ('property','property','/ˈprɑːpərti/','noun','bất động sản'),
  ('property','construction','/kənˈstrʌkʃn/','noun','việc xây dựng'),
  ('property','renovation','/ˌrenəˈveɪʃn/','noun','việc cải tạo'),
  ('property','blueprint','/ˈbluːprɪnt/','noun','bản thiết kế'),

  ('industry','factory','/ˈfæktəri/','noun','nhà máy'),
  ('industry','manufacture','/ˌmænjuˈfæktʃər/','verb','sản xuất'),
  ('industry','assembly','/əˈsembli/','noun','việc lắp ráp'),
  ('industry','pollution','/pəˈluːʃn/','noun','ô nhiễm'),
  ('industry','safety','/ˈseɪfti/','noun','an toàn'),
  ('industry','recycle','/ˌriːˈsaɪkl/','verb','tái chế'),
  ('industry','menu','/ˈmenjuː/','noun','thực đơn'),
  ('industry','beverage','/ˈbevərɪdʒ/','noun','đồ uống'),
  ('industry','ingredient','/ɪnˈɡriːdiənt/','noun','nguyên liệu'),
  ('industry','prepare','/prɪˈper/','verb','chuẩn bị'),
  ('industry','serve','/sɜːrv/','verb','phục vụ'),
  ('industry','charity','/ˈtʃærəti/','noun','tổ chức từ thiện'),
  ('industry','sponsor','/ˈspɑːnsər/','verb','tài trợ'),
  ('industry','donation','/doʊˈneɪʃn/','noun','khoản quyên góp'),
  ('industry','production','/prəˈdʌkʃn/','noun','sản xuất')
),
topic_words(topic_slug, word, part_of_speech, meaning_vi) AS (
  VALUES
  ('computers-it','software','noun','phần mềm'), ('computers-it','install','verb','cài đặt'), ('computers-it','update','verb','cập nhật'),
  ('office-equipment','printer','noun','máy in'), ('office-equipment','equipment','noun','thiết bị'), ('office-equipment','device','noun','thiết bị'),
  ('office-procedures','procedure','noun','quy trình'), ('office-procedures','policy','noun','chính sách'), ('office-procedures','approval','noun','sự phê duyệt'),
  ('electronics','electronic','adjective','thuộc về điện tử'), ('electronics','component','noun','bộ phận; linh kiện'), ('electronics','operate','verb','vận hành'),
  ('correspondence','attachment','noun','tệp đính kèm'), ('correspondence','notify','verb','thông báo'), ('correspondence','respond','verb','phản hồi'),
  ('job-recruiting','vacancy','noun','vị trí tuyển dụng'), ('job-recruiting','applicant','noun','ứng viên'), ('job-recruiting','recruit','verb','tuyển dụng'),
  ('applying-interviewing','resume','noun','sơ yếu lý lịch'), ('applying-interviewing','interview','noun','buổi phỏng vấn'), ('applying-interviewing','qualification','noun','bằng cấp; năng lực'),
  ('hiring-training','hire','verb','tuyển dụng'), ('hiring-training','train','verb','đào tạo'), ('hiring-training','orientation','noun','buổi định hướng'),
  ('salaries-benefits','salary','noun','tiền lương'), ('salaries-benefits','allowance','noun','tiền phụ cấp'), ('salaries-benefits','benefit','noun','phúc lợi'),
  ('promotions-awards','promotion','noun','sự thăng chức'), ('promotions-awards','achievement','noun','thành tích'), ('promotions-awards','reward','noun','phần thưởng'),
  ('shopping-retail','purchase','noun','việc mua hàng'), ('shopping-retail','discount','noun','mức giảm giá'), ('shopping-retail','receipt','noun','biên lai'),
  ('ordering-supplies','supplier','noun','nhà cung cấp'), ('ordering-supplies','order','noun','đơn đặt hàng'), ('ordering-supplies','quantity','noun','số lượng'),
  ('shipping-delivery','shipment','noun','lô hàng'), ('shipping-delivery','deliver','verb','giao hàng'), ('shipping-delivery','carrier','noun','đơn vị vận chuyển'),
  ('invoices-billing','invoice','noun','hóa đơn'), ('invoices-billing','payment','noun','khoản thanh toán'), ('invoices-billing','charge','noun','khoản phí'),
  ('customer-service','complaint','noun','lời phàn nàn'), ('customer-service','refund','noun','khoản hoàn tiền'), ('customer-service','assistance','noun','sự hỗ trợ'),
  ('travel','itinerary','noun','lịch trình chuyến đi'), ('travel','destination','noun','điểm đến'), ('travel','expense','noun','chi phí'),
  ('airlines-air-travel','departure','noun','sự khởi hành'), ('airlines-air-travel','boarding','noun','việc lên máy bay'), ('airlines-air-travel','flight','noun','chuyến bay'),
  ('public-transportation','passenger','noun','hành khách'), ('public-transportation','platform','noun','sân ga'), ('public-transportation','route','noun','tuyến đường'),
  ('hotels-accommodation','reservation','noun','việc đặt chỗ'), ('hotels-accommodation','vacancy','noun','phòng còn trống'), ('hotels-accommodation','accommodation','noun','chỗ ở'),
  ('car-rentals','rental','noun','việc thuê'), ('car-rentals','vehicle','noun','phương tiện'), ('car-rentals','insurance','noun','bảo hiểm'),
  ('movies-cinema','screening','noun','buổi chiếu'), ('movies-cinema','director','noun','đạo diễn'), ('movies-cinema','admission','noun','vé vào cửa'),
  ('theater-performing-arts','performance','noun','buổi biểu diễn'), ('theater-performing-arts','audience','noun','khán giả'), ('theater-performing-arts','stage','noun','sân khấu'),
  ('music-concerts','concert','noun','buổi hòa nhạc'), ('music-concerts','orchestra','noun','dàn nhạc'), ('music-concerts','festival','noun','lễ hội'),
  ('museums-exhibitions','exhibition','noun','cuộc triển lãm'), ('museums-exhibitions','exhibit','noun','hiện vật trưng bày'), ('museums-exhibitions','collection','noun','bộ sưu tập'),
  ('media-publishing','publication','noun','ấn phẩm'), ('media-publishing','journalist','noun','nhà báo'), ('media-publishing','broadcast','noun','chương trình phát sóng'),
  ('doctors-office','appointment','noun','cuộc hẹn'), ('doctors-office','physician','noun','bác sĩ'), ('doctors-office','symptom','noun','triệu chứng'),
  ('dentistry','dentist','noun','nha sĩ'), ('dentistry','dental','adjective','thuộc về nha khoa'), ('dentistry','treatment','noun','việc điều trị'),
  ('health-insurance','coverage','noun','phạm vi bảo hiểm'), ('health-insurance','premium','noun','phí bảo hiểm'), ('health-insurance','claim','noun','yêu cầu chi trả'),
  ('hospitals','admission','noun','việc nhập viện'), ('hospitals','patient','noun','bệnh nhân'), ('hospitals','discharge','noun','việc xuất viện'),
  ('pharmacy','prescription','noun','đơn thuốc'), ('pharmacy','dosage','noun','liều lượng'), ('pharmacy','medication','noun','thuốc điều trị'),
  ('accounting','balance','noun','số dư'), ('accounting','calculate','verb','tính toán'), ('accounting','expense','noun','chi phí'),
  ('investments','investment','noun','khoản đầu tư'), ('investments','shareholder','noun','cổ đông'), ('investments','stock','noun','cổ phiếu'),
  ('taxes-compliance','tax','noun','thuế'), ('taxes-compliance','deduction','noun','khoản khấu trừ'), ('taxes-compliance','regulation','noun','quy định'),
  ('financial-statements','revenue','noun','doanh thu'), ('financial-statements','profit','noun','lợi nhuận'), ('financial-statements','statement','noun','báo cáo'),
  ('board-meetings','agenda','noun','chương trình nghị sự'), ('board-meetings','committee','noun','ủy ban'), ('board-meetings','resolution','noun','nghị quyết'),
  ('quality-control','inspection','noun','việc kiểm tra'), ('quality-control','defect','noun','lỗi'), ('quality-control','standard','noun','tiêu chuẩn'),
  ('product-development','prototype','noun','nguyên mẫu'), ('product-development','innovation','noun','sự đổi mới'), ('product-development','research','noun','nghiên cứu'),
  ('renting-leasing','lease','noun','hợp đồng thuê'), ('renting-leasing','tenant','noun','người thuê'), ('renting-leasing','landlord','noun','chủ nhà'),
  ('real-estate','property','noun','bất động sản'), ('real-estate','purchase','noun','việc mua bán'), ('real-estate','construction','noun','việc xây dựng'),
  ('manufacturing','factory','noun','nhà máy'), ('manufacturing','manufacture','verb','sản xuất'), ('manufacturing','assembly','noun','việc lắp ráp'),
  ('environment-safety','pollution','noun','ô nhiễm'), ('environment-safety','safety','noun','an toàn'), ('environment-safety','recycle','verb','tái chế'),
  ('restaurants-dining','menu','noun','thực đơn'), ('restaurants-dining','beverage','noun','đồ uống'), ('restaurants-dining','reservation','noun','việc đặt bàn'),
  ('cooking-food-preparation','ingredient','noun','nguyên liệu'), ('cooking-food-preparation','prepare','verb','chuẩn bị'), ('cooking-food-preparation','serve','verb','phục vụ'),
  ('community-relations','charity','noun','tổ chức từ thiện'), ('community-relations','sponsor','verb','tài trợ'), ('community-relations','donation','noun','khoản quyên góp')
),
target_topics AS (
  SELECT t.id, t.slug, t.group_slug
  FROM app.vocab_topics t
  WHERE t.display_order BETWEEN 6 AND 50
),
target_samples AS (
  SELECT tt.id AS topic_id, tt.group_slug, tw.word, tw.part_of_speech, tw.meaning_vi
  FROM topic_words tw
  JOIN target_topics tt ON tt.slug = tw.topic_slug
),
available_shared AS (
  SELECT DISTINCT tt.id AS topic_id, sw.word, sw.phonetic, sw.part_of_speech, sw.meaning_vi
  FROM target_topics tt
  JOIN shared_words sw ON sw.group_slug IN ('common', tt.group_slug)
  WHERE NOT EXISTS (
    SELECT 1 FROM target_samples sample
    WHERE sample.topic_id = tt.id AND lower(sample.word) = lower(sw.word)
  )
),
ranked_shared AS (
  SELECT *, row_number() OVER (PARTITION BY topic_id ORDER BY word) AS word_rank
  FROM available_shared
),
all_words AS (
  SELECT topic_id, word, phonetic, part_of_speech, meaning_vi FROM ranked_shared WHERE word_rank <= 27
  UNION ALL
  SELECT topic_id, word, '', part_of_speech, meaning_vi FROM target_samples
),
numbered_words AS (
  SELECT topic_id, word, phonetic, part_of_speech, meaning_vi,
         row_number() OVER (PARTITION BY topic_id ORDER BY word)::smallint AS display_order
  FROM all_words
),
seeded AS (
  SELECT topic_id, word, phonetic, part_of_speech, meaning_vi,
         'The word "' || word || '" appears in the team''s workplace guide.' AS example_en,
         'Từ "' || word || '" xuất hiện trong tài liệu hướng dẫn công việc của nhóm.' AS example_vi,
         display_order
  FROM numbered_words
)
INSERT INTO app.vocab_words
  (topic_id, word, phonetic, part_of_speech, meaning_vi, example_en, example_vi, display_order)
SELECT topic_id, word, phonetic, part_of_speech, meaning_vi, example_en, example_vi, display_order
FROM seeded
ON CONFLICT (topic_id, word) DO UPDATE SET
  phonetic = EXCLUDED.phonetic,
  part_of_speech = EXCLUDED.part_of_speech,
  meaning_vi = EXCLUDED.meaning_vi,
  example_en = EXCLUDED.example_en,
  example_vi = EXCLUDED.example_vi,
  display_order = EXCLUDED.display_order;

GRANT SELECT ON app.vocab_topics TO vchat_app;
