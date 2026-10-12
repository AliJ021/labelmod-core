<?php
/** راز امضای Push؛ مستقل از تنظیمات عمومی و فقط رمز‌شده در دیتابیس. */
if (!defined('ABSPATH')) { exit; }

class LMC_Push_Secret
{
    const OPTION = 'labelmod_connector_push_secret';
    const CONTEXT = 'labelmod-connector/push-secret/v1';

    /** نبود گزینه تنها حالتِ مجازِ بازگشت به ثابت قدیمی است. */
    public static function read(): string
    {
        $saved = get_option(self::OPTION, null);
        if ($saved === null) {
            return defined('LMC_PUSH_SECRET') ? (string) constant('LMC_PUSH_SECRET') : '';
        }
        if (!is_array($saved) || ($saved['version'] ?? null) !== 1 || ($saved['disabled'] ?? false) === true) { return ''; }
        if (!self::available()) { return ''; }
        foreach (['iv', 'tag', 'ciphertext'] as $field) {
            if (!isset($saved[$field]) || !is_string($saved[$field])) { return ''; }
        }
        $iv = base64_decode($saved['iv'], true);
        $tag = base64_decode($saved['tag'], true);
        $ciphertext = base64_decode($saved['ciphertext'], true);
        if (!is_string($iv) || strlen($iv) !== 12 || !is_string($tag) || strlen($tag) !== 16
            || !is_string($ciphertext) || strlen($ciphertext) < 32 || strlen($ciphertext) > 512) { return ''; }
        // خرابی ذخیره یا عوض‌شدن کلیدهای وردپرس: رد امن؛ ثابت قدیمی فعال نمی‌شود.
        $plain = openssl_decrypt($ciphertext, 'aes-256-gcm', self::encryption_key(), OPENSSL_RAW_DATA, $iv, $tag, self::CONTEXT);
        return is_string($plain) && self::valid($plain) ? $plain : '';
    }

    public static function status(): string
    {
        $saved = get_option(self::OPTION, null);
        if ($saved === null) { return self::read() === '' ? 'missing' : 'legacy'; }
        if (is_array($saved) && ($saved['version'] ?? null) === 1 && ($saved['disabled'] ?? false) === true) { return 'disabled'; }
        return self::read() === '' ? 'unreadable' : 'saved';
    }

    /** فقط ثابت‌های موجود؛ wp_salt ممکن است کلید جایگزین را در همان دیتابیس بسازد. */
    public static function available(): bool
    {
        foreach (['AUTH_KEY', 'AUTH_SALT'] as $name) {
            if (!defined($name) || !is_string(constant($name)) || strlen(constant($name)) < 32
                || stripos(constant($name), 'put your unique phrase here') !== false) { return false; }
        }
        return function_exists('openssl_encrypt') && function_exists('openssl_decrypt')
            && in_array('aes-256-gcm', openssl_get_cipher_methods(), true);
    }

    private static function encryption_key(): string
    {
        return hash_hkdf('sha256', AUTH_KEY . "\0" . AUTH_SALT, 32, self::CONTEXT);
    }

    private static function valid(string $secret): bool
    {
        return preg_match('/^[\x21-\x7e]{32,512}$/D', $secret) === 1;
    }

    /** خالی = حفظ؛ پاک‌کردن صریح حتی ثابت قدیمی را تا ورود کلید تازه غیرفعال می‌کند. */
    public static function save(string $secret, bool $clear = false): bool
    {
        if ($clear) { return self::persist(['version' => 1, 'disabled' => true]); }
        if ($secret === '') { return true; }
        if (!self::valid($secret) || !self::available()) { return false; }
        try {
            $iv = random_bytes(12);
            $tag = '';
            $ciphertext = openssl_encrypt($secret, 'aes-256-gcm', self::encryption_key(), OPENSSL_RAW_DATA, $iv, $tag, self::CONTEXT, 16);
            if (!is_string($ciphertext) || strlen($tag) !== 16) { return false; }
            return self::persist(['version' => 1, 'iv' => base64_encode($iv), 'tag' => base64_encode($tag), 'ciphertext' => base64_encode($ciphertext)]);
        } catch (Throwable $error) {
            // متن استثنا یا ورودی هرگز به لاگ/HTML/نشانی هدایت نمی‌رود.
            return false;
        }
    }

    private static function persist(array $value): bool
    {
        // false یعنی autoload خاموش؛ شکست نوشتن نباید موفقیت کاذب بدهد.
        update_option(self::OPTION, $value, false);
        return get_option(self::OPTION, null) === $value;
    }
}
