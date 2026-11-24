export function otpText(code: string): string {
  return `کد ورود لیبل مد: ${code}\nاعتبار: دو دقیقه. کد را در اختیار دیگران نگذارید.`;
}

export function invoiceText(shop: string, number: string, amount: string, link: string): string {
  return `${shop}\nفاکتور ${number} ثبت شد.\nمبلغ: ${amount} تومان\n${link}`;
}
