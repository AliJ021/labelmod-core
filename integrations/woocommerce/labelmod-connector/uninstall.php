<?php
/** حذف افزونه: راز ذخیره‌شدهٔ همان سایت باقی نماند؛ اسناد و تاریخچه حذف نمی‌شوند. */
if (!defined('WP_UNINSTALL_PLUGIN')) { exit; }
if (is_multisite()) {
    // تنظیمات per-site هستند، نه network option.
    $offset = 0;
    do {
        $ids = get_sites(['fields' => 'ids', 'number' => 100, 'offset' => $offset]);
        foreach ($ids as $id) {
            switch_to_blog((int) $id);
            delete_option('labelmod_connector_push_secret');
            restore_current_blog();
        }
        $offset += count($ids);
    } while (count($ids) === 100);
} else {
    delete_option('labelmod_connector_push_secret');
}
