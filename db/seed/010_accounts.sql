-- =====================================================================
-- کدینگ حساب پیشنهادی
-- =====================================================================
-- ⚠️ این کدینگ پیشنهادی است و باید توسط حسابدار مسئول تصویب شود.
-- تا زمان تصویب، هیچ داده واقعی وارد سیستم نشود.
-- تغییر بعدی کد حساب‌ها فقط UPDATE روی این جدول و posting_rule است،
-- بدون تغییر در کد اپلیکیشن.
-- =====================================================================

BEGIN;

INSERT INTO ledger.account (code, parent_code, name, level, nature, type, is_postable) VALUES
-- ۱ دارایی‌های جاری -----------------------------------------------------
('1',    NULL, 'دارایی‌های جاری',                    'kol',     'debit',  'asset',   false),
('11',   '1',  'موجودی نقد و بانک',                  'moin',    'debit',  'asset',   false),
('1101', '11', 'صندوق فروشگاه',                      'tafsili', 'debit',  'asset',   true),
('1102', '11', 'بانک — حساب جاری',                   'tafsili', 'debit',  'asset',   true),
('1103', '11', 'وجوه در راه کارت‌خوان',              'tafsili', 'debit',  'asset',   true),
('1104', '11', 'وجوه در راه درگاه پرداخت',           'tafsili', 'debit',  'asset',   true),
('1105', '11', 'وجوه در راه کارت‌به‌کارت',            'tafsili', 'debit',  'asset',   true),
-- تراکنشی که نتیجه‌اش معلوم نیست، پول نیست. تا استعلام انسانی اینجا می‌ماند
-- و هرگز مستقیم وارد بانک یا وجوه در راه کارت‌خوان نمی‌شود.
('1106', '11', 'پرداخت نامشخص — در انتظار استعلام',  'tafsili', 'debit',  'asset',   true),
('12',   '1',  'حساب‌های دریافتنی',                   'moin',    'debit',  'asset',   false),
('1201', '12', 'حساب دریافتنی تجاری — مشتریان',      'tafsili', 'debit',  'asset',   true),
('13',   '1',  'موجودی کالا',                        'moin',    'debit',  'asset',   false),
('1301', '13', 'موجودی کالای فروشگاه',               'tafsili', 'debit',  'asset',   true),
('14',   '1',  'پیش‌پرداخت و اعتبار مالیاتی',         'moin',    'debit',  'asset',   false),
('1401', '14', 'مالیات ارزش افزوده خرید — اعتبار',   'tafsili', 'debit',  'asset',   true),

-- ۲ بدهی‌های جاری -------------------------------------------------------
('2',    NULL, 'بدهی‌های جاری',                      'kol',     'credit', 'liability', false),
('21',   '2',  'حساب‌های پرداختنی',                   'moin',    'credit', 'liability', false),
('2101', '21', 'حساب پرداختنی تجاری — تأمین‌کنندگان','tafsili', 'credit', 'liability', true),
-- کرایه حمل و هزینه جانبیِ شخص ثالث بدهی به تأمین‌کننده کالا نیست
('2103', '21', 'سایر حساب‌های پرداختنی',           'tafsili', 'credit', 'liability', true),
('22',   '2',  'بدهی مالیاتی',                       'moin',    'credit', 'liability', false),
('2201', '22', 'مالیات و عوارض ارزش افزوده پرداختنی','tafsili', 'credit', 'liability', true),
('23',   '2',  'سایر بدهی‌ها',                        'moin',    'credit', 'liability', false),
('2301', '23', 'بدهی امتیاز و اعتبار مشتریان',       'tafsili', 'credit', 'liability', true),
('2302', '23', 'بدهی کارت هدیه',                     'tafsili', 'credit', 'liability', true),

-- ۳ حقوق مالکانه --------------------------------------------------------
('3',    NULL, 'حقوق مالکانه',                       'kol',     'credit', 'equity',  false),
('31',   '3',  'سرمایه و سود انباشته',               'moin',    'credit', 'equity',  false),
('3101', '31', 'سرمایه',                             'tafsili', 'credit', 'equity',  true),
('3102', '31', 'سود و زیان انباشته',                 'tafsili', 'credit', 'equity',  true),

-- ۴ درآمد ---------------------------------------------------------------
('4',    NULL, 'درآمد',                              'kol',     'credit', 'revenue', false),
('41',   '4',  'فروش',                               'moin',    'credit', 'revenue', false),
('4101', '41', 'فروش کالا',                          'tafsili', 'credit', 'revenue', true),
('4102', '41', 'تخفیفات اعطایی',                     'tafsili', 'debit',  'contra_revenue', true),
('4103', '41', 'برگشت از فروش',                      'tafsili', 'debit',  'contra_revenue', true),
('42',   '4',  'درآمد متفرقه',                       'moin',    'credit', 'revenue', false),
('4201', '42', 'درآمد حمل و ارسال',                  'tafsili', 'credit', 'revenue', true),
('4202', '42', 'درآمد متفرقه',                       'tafsili', 'credit', 'revenue', true),
('4203', '42', 'مغایرت صندوق',                       'tafsili', 'credit', 'revenue', true),

-- ۵ بهای تمام‌شده -------------------------------------------------------
('5',    NULL, 'بهای تمام‌شده',                      'kol',     'debit',  'expense', false),
('51',   '5',  'بهای تمام‌شده کالای فروش‌رفته',       'moin',    'debit',  'expense', false),
('5101', '51', 'بهای تمام‌شده کالای فروش‌رفته',       'tafsili', 'debit',  'expense', true),
('5102', '51', 'تعدیل بهای تمام‌شده',                'tafsili', 'debit',  'expense', true),
('5103', '51', 'کسری و ضایعات انبار',                'tafsili', 'debit',  'expense', true),
('5104', '51', 'کالای معیوب',                        'tafsili', 'debit',  'expense', true),

-- ۶ هزینه‌های عملیاتی ---------------------------------------------------
('6',    NULL, 'هزینه‌های عملیاتی',                  'kol',     'debit',  'expense', false),
('61',   '6',  'هزینه‌های فروش',                     'moin',    'debit',  'expense', false),
('6101', '61', 'هزینه کارمزد بانکی',                 'tafsili', 'debit',  'expense', true),
('6102', '61', 'هزینه حمل و ارسال',                  'tafsili', 'debit',  'expense', true),
('6103', '61', 'هزینه بسته‌بندی',                    'tafsili', 'debit',  'expense', true),
('6104', '61', 'هزینه باشگاه مشتریان',               'tafsili', 'debit',  'expense', true),
('62',   '6',  'هزینه‌های اداری',                    'moin',    'debit',  'expense', false),
('6201', '62', 'هزینه اجاره',                        'tafsili', 'debit',  'expense', true),
('6202', '62', 'هزینه حقوق و دستمزد',                'tafsili', 'debit',  'expense', true),
('6203', '62', 'هزینه‌های متفرقه',                   'tafsili', 'debit',  'expense', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO ledger.cost_center (code, name) VALUES
('STORE', 'فروشگاه حضوری'),
('WEB',   'فروش اینترنتی'),
('ADMIN', 'اداری')
ON CONFLICT (code) DO NOTHING;

COMMIT;
