(() => {
    const form = document.getElementById('lmc-stock-scan');
    if (!form || !window.fetch || !window.ajaxurl) return;

    const button = form.querySelector('[type="submit"]');
    const status = document.getElementById('lmc-stock-progress');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (button.disabled) return;
        button.disabled = true;
        form.setAttribute('aria-busy', 'true');
        status.textContent = 'در حال دریافت موجودی از حسابداری…';
        try {
            let step = 'start';
            while (true) {
                const body = new FormData(form);
                body.set('action', 'lmc_stock_scan');
                body.set('step', step);
                const response = await fetch(window.ajaxurl, { method: 'POST', body, credentials: 'same-origin' });
                if (!response.ok) throw new Error();
                const result = await response.json();
                if (!result.success || !result.data) {
                    status.textContent = result.data?.message || 'همگام‌سازی کامل نشد. دوباره تلاش کنید.';
                    break;
                }
                status.textContent = result.data.message;
                if (!result.data.more) break;
                step = 'next';
            }
        } catch {
            status.textContent = 'پاسخ کامل دریافت نشد. دوباره دکمه را بزنید تا پیشرفت ذخیره‌شده بررسی شود.';
        } finally {
            button.disabled = false;
            form.removeAttribute('aria-busy');
        }
    });
})();
