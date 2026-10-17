#!/usr/bin/env bash
# فقط محلی و مصنوعی: وردپرس ۷٫۰٫۷ (حداقلِ ووکامرس ۱۱٫۱٫۱) (GitHub) + ووکامرس ۱۱٫۱٫۱ (انتشار GitHub) + MariaDB محلی.
#   setup.sh <work-dir> <plugin-dir> <db-socket>
# هیچ کلید یا دادهٔ واقعی؛ رمز پایگاه داده فقط برای همین نمونهٔ محلی است.
set -euo pipefail
W="$1"; PLUGIN="$2"; SOCK="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
[ -d "$W/wp" ] || git clone -q --depth 1 --branch 7.0.7 https://github.com/WordPress/WordPress "$W/wp"
if [ ! -d "$W/wp/wp-content/plugins/woocommerce" ]; then
  curl -sSfL -o "$W/woocommerce.zip" https://github.com/woocommerce/woocommerce/releases/download/11.1.1/woocommerce.zip
  (cd "$W/wp/wp-content/plugins" && unzip -q -o "$W/woocommerce.zip")
fi
# نسخه‌ها سنجیده می‌شوند، نه فرض: بازتولید فقط برای همین دو نسخه ادعا شده است.
grep -q "^\$wp_version = '7.0.7';" "$W/wp/wp-includes/version.php" || { echo "وردپرس 7.0.7 نیست" >&2; exit 1; }
grep -q '^ \* Version: 11.1.1$' "$W/wp/wp-content/plugins/woocommerce/woocommerce.php" || { echo "ووکامرس 11.1.1 نیست" >&2; exit 1; }
mkdir -p "$W/wp/wp-content/mu-plugins"
ln -sfn "$HERE/mu-repro.php" "$W/wp/wp-content/mu-plugins/lmc-repro.php"   # پیوند، نه کپی: نسخهٔ جاری همیشه اجرا شود
ln -sfn "$PLUGIN" "$W/wp/wp-content/plugins/labelmod-connector"
cat > "$W/wp/wp-config.php" <<PHP
<?php
define('DB_NAME', 'wpr'); define('DB_USER', 'wp'); define('DB_PASSWORD', 'synthetic-local-only');
define('DB_HOST', 'localhost:$SOCK'); define('DB_CHARSET', 'utf8mb4'); define('DB_COLLATE', '');
\$table_prefix = 'wp_';
define('DISABLE_WP_CRON', true); define('WP_DEBUG', false); define('AUTOMATIC_UPDATER_DISABLED', true);
foreach (['AUTH_KEY','SECURE_AUTH_KEY','LOGGED_IN_KEY','NONCE_KEY','AUTH_SALT','SECURE_AUTH_SALT','LOGGED_IN_SALT','NONCE_SALT'] as \$k) { define(\$k, 'synthetic-local-' . \$k); }
\$_SERVER['HTTP_HOST'] = 'repro.invalid'; define('WP_HOME', 'http://repro.invalid'); define('WP_SITEURL', 'http://repro.invalid');
if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }
require_once ABSPATH . 'wp-settings.php';
PHP
php "$HERE/actor.php" "$W/wp" install-wp
php "$HERE/actor.php" "$W/wp" activate
php "$HERE/actor.php" "$W/wp" install-wc
