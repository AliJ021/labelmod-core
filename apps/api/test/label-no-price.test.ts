import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelPage, labelGeometry, ROLL_PRESETS_MM } from '../src/catalog/label.ts';

const item = { barcode: '2000000014012', sku: 'SKU-1', productName: 'شلوار', color: 'مشکی', size: 'XL', priceRial: 12345670n, count: 2 };
for (const size of [...ROLL_PRESETS_MM, { width: 70, height: 37 }]) {
  test(`چاپ بدون قیمت ${size.width}×${size.height}: حذف کامل قیمت، حفظ داده و هندسه`, () => {
    const opts = { layout: size.width === 70 ? 'a4' as const : 'roll' as const, shopName: 'Label Mod', rollMm: size };
    const items = [item, { ...item, priceRial: null, count: 1 }];
    const before = structuredClone(items);
    const html = labelPage(items, { ...opts, hidePrice: true });
    assert.equal((html.match(/class="label"/g) ?? []).length, 3);
    assert.doesNotMatch(html, /class="price"|class="noprice"|1,234,567|<small>تومان/);
    assert.equal((html.match(/<svg/g) ?? []).length, 3);
    assert.match(html, /شلوار/);
    assert.deepEqual(items, before);
    assert.equal(labelPage(items, { ...opts, hidePrice: false }), labelPage(items, opts));
    assert.match(labelPage(items, opts), /1,234,567/);
    for (const prefer of ['barcode', 'text', 'text3'] as const) {
      const g = labelGeometry(opts.layout, size.width, size.height, undefined, prefer, true);
      assert.equal(g.rows.price, 0);
      assert.ok(g.fits && g.barHeightMm >= 5 && g.moduleMm >= .25);
      const rows = [g.rows.code, g.rows.desc, ...(g.showShop ? [g.rows.shop] : [])];
      const total = rows.reduce((a, b) => a + b, 0) + (rows.length - 1) * .4 + g.padY[0] + g.padY[1];
      assert.ok(total <= size.height + 1e-9, `height ${total}`);
    }
  });
}
test('رول دو ستونه بدون قیمت: تعداد، خانهٔ شروع و ترتیب بارکد حفظ می‌شوند', () => {
  const html = labelPage([item, { ...item, barcode: '12345678901234567', count: 1 }], {
    layout: 'roll', shopName: 'Label Mod', rollMm: { width: 50, height: 30 }, hidePrice: true,
    rollRow: { columns: 2, gapMm: 3, mediaWidthMm: 106, offsetXMm: 0, startSlot: 2 },
  });
  assert.match(html, /@page \{ size: 106mm 30mm/);
  assert.equal((html.match(/class="label"/g) ?? []).length, 3);
  assert.equal((html.match(/class="row" data-row=/g) ?? []).length, 2);
  assert.equal((html.match(/slot--empty"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /class="price"|1,234,567|<small>تومان/);
  assert.match(html, /12345678901234567/);
});
