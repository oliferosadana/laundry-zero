const https = require('https');
const dayjs = require('dayjs');

function buildTelegramConfig(env = process.env) {
  const enabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  return {
    enabled,
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
    reminderDelayHours: Number(env.TELEGRAM_REMINDER_DELAY_HOURS || 6),
    reminderIntervalMinutes: Number(env.TELEGRAM_REMINDER_INTERVAL_MINUTES || 10),
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sendTelegramMessage(config, htmlText) {
  if (!config.enabled) return Promise.resolve({ ok: false, skipped: true, reason: 'telegram_disabled' });

  const payload = JSON.stringify({
    chat_id: config.chatId,
    text: htmlText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${config.token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, statusCode: res.statusCode, body: data });
        } else {
          reject(new Error(`Telegram API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function formatCurrency(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function formatOrderLine(order) {
  const item = order.items?.[0] || {};
  const quantity = item.quantity ? `${item.quantity} ${item.unit || ''}`.trim() : '-';
  return [
    `<b>${escapeHtml(order.invoiceNumber)}</b>`,
    `Pelanggan: ${escapeHtml(order.customerName)}`,
    `Layanan: ${escapeHtml(item.serviceName || '-')}`,
    `Qty: ${escapeHtml(quantity)}`,
    `Status: ${escapeHtml(order.status)}`,
    `Bayar: ${escapeHtml(order.paymentStatus)}`,
    `Total: ${escapeHtml(formatCurrency(order.totalAmount))}`,
  ];
}

function buildNewOrderMessage(order) {
  return [
    '🧺 <b>Order baru masuk</b>',
    ...formatOrderLine(order),
    order.notes ? `Catatan: ${escapeHtml(order.notes)}` : null,
    order.estimatedReadyAt ? `Estimasi selesai: ${escapeHtml(dayjs(order.estimatedReadyAt).format('DD/MM/YYYY HH:mm'))}` : null,
  ].filter(Boolean).join('\n');
}

function buildFinishedOrderMessage(order) {
  return [
    '✅ <b>Order selesai</b>',
    ...formatOrderLine(order),
    order.estimatedReadyAt ? `Estimasi: ${escapeHtml(dayjs(order.estimatedReadyAt).format('DD/MM/YYYY HH:mm'))}` : null,
    'Siap diambil pelanggan.',
  ].filter(Boolean).join('\n');
}

function buildReminderMessage(order, delayHours) {
  const finishedAt = order.telegram?.finishedNotifiedAt || order.updatedAt || order.createdAt;
  return [
    '⏰ <b>Reminder order belum diambil</b>',
    ...formatOrderLine(order),
    `Sudah selesai lebih dari ${escapeHtml(delayHours)} jam.`,
    `Terakhir update: ${escapeHtml(dayjs(finishedAt).format('DD/MM/YYYY HH:mm'))}`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  buildTelegramConfig,
  sendTelegramMessage,
  buildNewOrderMessage,
  buildFinishedOrderMessage,
  buildReminderMessage,
};
