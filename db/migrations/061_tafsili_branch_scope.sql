-- تفصیلی باید پیش از اعمال دامنه API به تفکیک شعبه جمع شود.
-- اگر شعبه بعد از aggregation افزوده شود، گردش شعبه نامجاز از مانده
-- شخص حذف‌شدنی نیست حتی اگر خود سطر در API فیلتر شود.

CREATE OR REPLACE VIEW ledger.party_tafsili AS
SELECT l.account_code                        AS parent_code,
       a.name                                AS parent_name,
       l.party_type,
       l.party_id,
       coalesce(c.tafsili_no, s.tafsili_no)  AS tafsili_no,
       l.account_code || '-' ||
         lpad(coalesce(c.tafsili_no, s.tafsili_no)::text, 4, '0') AS code,
       coalesce(c.full_name, s.name)         AS party_name,
       sum(l.debit)                          AS debit,
       sum(l.credit)                         AS credit,
       CASE WHEN a.nature = 'debit'
            THEN sum(l.debit) - sum(l.credit)
            ELSE sum(l.credit) - sum(l.debit) END AS balance,
       e.branch_id
  FROM ledger.journal_line l
  JOIN ledger.journal_entry e ON e.id = l.entry_id
  JOIN ledger.account a ON a.code = l.account_code
  LEFT JOIN sales.customer      c ON l.party_type = 'customer' AND c.id = l.party_id
  LEFT JOIN purchasing.supplier s ON l.party_type = 'supplier' AND s.id = l.party_id
 WHERE l.party_id IS NOT NULL
 GROUP BY l.account_code, a.name, a.nature, e.branch_id, l.party_type, l.party_id,
          c.tafsili_no, s.tafsili_no, c.full_name, s.name;

COMMENT ON VIEW ledger.party_tafsili IS
  'تفصیلی اشخاص به تفکیک شعبه — API دامنه شعب مجاز را پیش از جمع نهایی اعمال می‌کند.';
