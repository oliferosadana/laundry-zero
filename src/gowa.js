const http = require('http');
const https = require('https');
const { URL } = require('url');
const dayjs = require('dayjs');

function buildGoWAConfig(env = process.env) {
  return {
    enabled: Boolean(env.GOWA_BASE_URL && env.GOWA_USERNAME && env.GOWA_PASSWORD),
    baseUrl: env.GOWA_BASE_URL || '',
    username: env.GOWA_USERNAME || '',
    password: env.GOWA_PASSWORD || '',
    deviceId: env.GOWA_DEVICE_ID || '',
    countryCode: env.GOWA_COUNTRY_CODE || '62',
    reminderDelayHours: Number(env.GOWA_REMINDER_DELAY_HOURS || 6),
    reminderIntervalMinutes: Number(env.GOWA_REMINDER_INTERVAL_MINUTES || 10),
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

function toWhatsAppJid(phone, countryCode = '62') {
  const normalized = normalizePhoneNumber(phone, countryCode);
  return normalized ? `${normalized}@s.whatsapp.net` : '';
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

function sendGoWAMessage(config, targetPhone, message) {
  if (!config.enabled) return Promise.resolve({ ok: false, skipped: true, reason: 'gowa_disabled' });
  const phone = toWhatsAppJid(targetPhone, config.countryCode);
  if (!phone) return Promise.resolve({ ok: false, skipped: true, reason: 'invalid_target' });

  const targetUrl = new URL('/send/message', config.baseUrl);
  const payload = JSON.stringify({ phone, message });
  const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
  const client = targetUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (config.deviceId) headers['X-Device-Id'] = config.deviceId;

    const req = client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      headers,
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
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, statusCode: res.statusCode, body: parsed, target: phone });
        } else {
          reject(new Error(`GoWA API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = {
  buildGoWAConfig,
  normalizePhoneNumber,
  toWhatsAppJid,
  sendGoWAMessage,
  buildNewOrderWhatsAppMessage,
  buildFinishedWhatsAppMessage,
  buildReminderWhatsAppMessage,
};
