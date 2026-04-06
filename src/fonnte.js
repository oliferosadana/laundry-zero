const https = require('https');
const querystring = require('querystring');
const dayjs = require('dayjs');

function buildFonnteConfig(env = process.env) {
  return {
    enabled: Boolean(env.FONNTE_TOKEN),
    token: env.FONNTE_TOKEN || '',
    countryCode: env.FONNTE_COUNTRY_CODE || '62',
    reminderDelayHours: Number(env.FONNTE_REMINDER_DELAY_HOURS || env.WA_REMINDER_DELAY_HOURS || 6),
    reminderIntervalMinutes: Number(env.FONNTE_REMINDER_INTERVAL_MINUTES || env.WA_REMINDER_INTERVAL_MINUTES || 10),
  };
}

function normalizePhoneNumber(phone, countryCode = '62') {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0')) return `${countryCode}${digits.slice(1)}`;
  if (digits.startsWith(countryCode)) return digits;
  if (digits.startsWith('62')) return digits;
  return `${countryCode}${digits}`;
}

function formatCurrency(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function buildOrderBody(order) {
  const item = order.items?.[0] || {};
  const quantity = item.quantity ? `${item.quantity} ${item.unit || ''}`.trim() : '-';
  return [
    `Kode: ${order.invoiceNumber}`,
    `Layanan: ${item.serviceName || '-'}`,
    `Qty: ${quantity}`,
    `Status: ${order.status}`,
    `Pembayaran: ${order.paymentStatus}`,
    `Total: ${formatCurrency(order.totalAmount)}`,
  ];
}

function buildNewOrderWhatsAppMessage(order) {
  return [
    `Halo ${order.customerName}, laundry Anda sudah kami terima.`,
    ...buildOrderBody(order),
    order.estimatedReadyAt ? `Estimasi selesai: ${dayjs(order.estimatedReadyAt).format('DD/MM/YYYY HH:mm')}` : null,
    order.notes ? `Catatan: ${order.notes}` : null,
    'Terima kasih 🙏',
  ].filter(Boolean).join('\n');
}

function buildFinishedWhatsAppMessage(order) {
  return [
    `Halo ${order.customerName}, laundry Anda sudah selesai dan siap diambil.`,
    ...buildOrderBody(order),
    'Silakan datang saat sempat. Terima kasih 🙏',
  ].join('\n');
}

function buildReminderWhatsAppMessage(order, delayHours) {
  return [
    `Halo ${order.customerName}, kami mengingatkan bahwa laundry Anda sudah selesai namun belum diambil.`,
    ...buildOrderBody(order),
    `Reminder ini dikirim setelah lebih dari ${delayHours} jam sejak status selesai.`,
    'Jika sudah diambil, pesan ini bisa diabaikan 🙏',
  ].join('\n');
}

function sendFonnteMessage(config, target, message) {
  if (!config.enabled) return Promise.resolve({ ok: false, skipped: true, reason: 'fonnte_disabled' });
  const normalizedTarget = normalizePhoneNumber(target, config.countryCode);
  if (!normalizedTarget) return Promise.resolve({ ok: false, skipped: true, reason: 'invalid_target' });

  const payload = querystring.stringify({
    target: normalizedTarget,
    message,
    countryCode: config.countryCode,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.fonnte.com',
      path: '/send',
      method: 'POST',
      headers: {
        Authorization: config.token,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(data);
        } catch {
          parsed = { raw: data };
        }
        if (res.statusCode >= 200 && res.statusCode < 300 && (parsed.status === true || parsed.detail || parsed.process)) {
          resolve({ ok: true, statusCode: res.statusCode, body: parsed, target: normalizedTarget });
        } else {
          reject(new Error(`Fonnte API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  buildFonnteConfig,
  normalizePhoneNumber,
  sendFonnteMessage,
  buildNewOrderWhatsAppMessage,
  buildFinishedWhatsAppMessage,
  buildReminderWhatsAppMessage,
};
