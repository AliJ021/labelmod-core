/**
 * صندوق فروشگاهی — ناحیه مات.
 *
 * ADR-002 اینجا را «حداقلی» گذاشته و سه دلیل فنی داشت:
 *
 * ۱. **تضاد زیر نور فروشگاه.** صندوق‌دار زیر مهتابی و گاهی آفتابِ کنار
 *    ویترین کار می‌کند و باید عدد قیمت را در کسری از ثانیه بخواند.
 * ۲. **هزینه رندر.** `backdrop-filter` روی تبلت ارزان یعنی افت فریم در
 *    اسکرول سبد و تأخیر در اسکن پشت‌سرهم. صندوق کند، صف می‌سازد.
 * ۳. **راهنمای خود اپل.** شیشه به لایه کنترلی تعلق دارد، نه به محتوا.
 *
 * پس اینجا **فقط نوار بالا** شیشه‌ای است. سبد، جمع، دکمه‌ها و همه
 * اعداد `solid`اند. این تصمیم را با «زیباتر می‌شود» عوض نکنید — بودجه
 * افزودن قلم به سبد **زیر ۱۰۰ میلی‌ثانیه** است و هر افکتی که بشکندش
 * حذف می‌شود.
 */
import { useState } from "react";
import { Glass, Solid } from "../components/Glass.tsx";
import { toman } from "../lib/money.ts";

interface Line {
  id: number;
  name: string;
  variant: string;
  qty: number;
  unit: bigint;
}

const START: Line[] = [
  { id: 1, name: "پیراهن کلاسیک", variant: "مشکی · L", unit: 32_000_000n, qty: 1 },
  { id: 2, name: "شلوار جین", variant: "سرمه‌ای · ۳۲", unit: 48_000_000n, qty: 2 },
];

export function Pos() {
  const [lines, setLines] = useState<Line[]>(START);
  const [scan, setScan] = useState("");

  const total = lines.reduce((sum, l) => sum + l.unit * BigInt(l.qty), 0n);
  const count = lines.reduce((n, l) => n + l.qty, 0);

  function bump(id: number, delta: number) {
    setLines((prev) =>
      prev
        .map((l) => (l.id === id ? { ...l, qty: Math.max(0, l.qty + delta) } : l))
        .filter((l) => l.qty > 0),
    );
  }

  return (
    <div className="pos">
      {/* تنها سطح شیشه‌ای این صفحه: نوار بالا، که لایه کنترلی است. */}
      <Glass as="header" radius="md" className="pos-bar" refract={false}>
        <label className="scan">
          <span className="sr-only">بارکد کالا</span>
          <input
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="بارکد را اسکن کنید یا کد کالا را بزنید"
            inputMode="numeric"
            autoFocus
            autoComplete="off"
          />
        </label>
        <span className="pill">{count} قلم</span>
      </Glass>

      <div className="pos-body">
        {/* سبد: مات، پرتضاد، عدد هم‌عرض. */}
        <Solid as="section" className="cart">
          <h2 className="sr-only">سبد خرید</h2>
          <ul className="lines">
            {lines.map((l) => (
              <li key={l.id}>
                <div className="line-name">
                  <strong>{l.name}</strong>
                  <span className="muted small">{l.variant}</span>
                </div>
                <div className="qty">
                  <button
                    type="button"
                    onClick={() => bump(l.id, -1)}
                    aria-label={`کم کردن ${l.name}`}
                  >
                    −
                  </button>
                  <span className="num" aria-live="polite">
                    {l.qty}
                  </span>
                  <button
                    type="button"
                    onClick={() => bump(l.id, 1)}
                    aria-label={`اضافه کردن ${l.name}`}
                  >
                    +
                  </button>
                </div>
                <span className="num line-total">
                  {toman(l.unit * BigInt(l.qty))}
                </span>
              </li>
            ))}
            {lines.length === 0 && <li className="empty">سبد خالی است</li>}
          </ul>
        </Solid>

        <Solid as="aside" className="pay">
          <div className="total">
            <span className="muted">قابل پرداخت</span>
            <strong className="num total-value">{toman(total)}</strong>
            <span className="muted small">تومان</span>
          </div>
          <button type="button" className="btn btn--primary">
            دریافت وجه
          </button>
          <button type="button" className="btn">
            نسیه
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => setLines([])}
          >
            رها کردن سبد
          </button>
        </Solid>
      </div>
    </div>
  );
}
