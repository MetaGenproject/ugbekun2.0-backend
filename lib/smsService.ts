function digitsOnly(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export function normalizeNigerianPhone(raw?: string | null): string | null {
  const digits = digitsOnly(raw || '');
  if (!digits) return null;
  if (digits.startsWith('234') && digits.length >= 13) return `+${digits}`;
  if (digits.startsWith('0') && digits.length === 11) return `+234${digits.slice(1)}`;
  if (digits.length === 10) return `+234${digits}`;
  if (digits.startsWith('234')) return `+${digits}`;
  return null;
}

export async function sendSms(
  to: string | null | undefined,
  text: string
): Promise<{ success: boolean; channel: string }> {
  const phone = normalizeNigerianPhone(to);
  const webhook = process.env.SMS_WEBHOOK_URL;
  if (webhook && phone) {
    try {
      const response = await fetch(webhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ to: phone, text }),
      });
      if (!response.ok) {
        console.warn(`[SMS] webhook failed ${response.status} for ${phone}`);
        return { success: false, channel: 'webhook' };
      }
      return { success: true, channel: 'webhook' };
    } catch (error: any) {
      console.warn(`[SMS] webhook error for ${phone}:`, error?.message || error);
      return { success: false, channel: 'webhook' };
    }
  }

  if (phone) {
    console.info(`[SMS] ${phone}: ${text}`);
  }
  return { success: false, channel: 'log' };
}
