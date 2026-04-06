require('dotenv').config();
const express = require('express');
const session = require('express-session');
const morgan = require('morgan');
const path = require('path');
const dayjs = require('dayjs');
const {
  buildTelegramConfig,
  sendTelegramMessage,
  buildNewOrderMessage,
  buildFinishedOrderMessage,
  buildReminderMessage,
} = require('./telegram');
const {
  buildGoWAConfig,
  sendGoWAMessage,
  buildNewOrderWhatsAppMessage,
  buildFinishedWhatsAppMessage,
  buildReminderWhatsAppMessage,
} = require('./gowa');
const {
  ensureDb,
  seedDefaults,
  ensureOrderScanTokens,
  listCustomers,
  createCustomer,
  getCustomer,
  updateCustomer,
  removeCustomer,
  listServices,
  createService,
  getService,
  updateService,
  removeService,
  createOrder,
  listOrders,
  getOrder,
  getOrderByScanToken,
  getOrderByInvoice,
  updateOrder,
  updateOrderStatus,
  removeOrder,
  updateOrderTelegramState,
  updateOrderWhatsAppState,
  listExpenses,
  createExpense,
  getExpense,
  updateExpense,
  removeExpense,
  getSettings,
  getStatuses,
} = require('./db');

const app = express();
const port = Number(process.env.PORT || 3220);
const baseUrl = process.env.BASE_URL || `http://localhost:${port}`;
const appName = process.env.APP_NAME || 'Laundry Zero';
const adminPassword = process.env.ADMIN_PASSWORD || '';
const paymentStatuses = ['belum_bayar', 'lunas'];
const telegramConfig = buildTelegramConfig(process.env);
const gowaConfig = buildGoWAConfig(process.env);

ensureDb();
seedDefaults();
ensureOrderScanTokens();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 12 },
}));
app.use(morgan('dev'));

function renderPage(req, res, view, data = {}) {
  return res.render(view, {
    title: appName,
    appName,
    settings: getSettings(),
    currentPath: req.path,
    isAdmin: Boolean(req.session?.isAdmin),
    dayjs,
    paymentStatuses,
    ...data,
  });
}

function requireAdmin(req, res, next) {
  if (!req.session?.isAdmin) return res.redirect('/login');
  next();
}

function text(value) {
  return String(value || '').trim();
}

function normalize(value) {
  return text(value).toLowerCase();
}

function validateCustomer(payload) {
  if (!text(payload.name)) return 'Nama pelanggan wajib diisi.';
  return null;
}

function validateService(payload) {
  if (!text(payload.name)) return 'Nama layanan wajib diisi.';
  if (!text(payload.unit)) return 'Satuan wajib diisi.';
  if (Number(payload.price || 0) < 0) return 'Harga tidak valid.';
  if (Number(payload.durationHours || 0) <= 0) return 'Estimasi pengerjaan harus lebih dari 0 jam.';
  return null;
}

function validateOrder(payload) {
  if (!payload.customerId) return 'Pelanggan wajib dipilih.';
  if (!payload.serviceId) return 'Layanan wajib dipilih.';
  if (Number(payload.quantity || 0) <= 0) return 'Qty / berat harus lebih dari 0.';
  return null;
}

function validateExpense(payload) {
  if (!text(payload.title)) return 'Nama pengeluaran wajib diisi.';
  if (!text(payload.category)) return 'Kategori pengeluaran wajib diisi.';
  if (Number(payload.amount || 0) <= 0) return 'Nominal pengeluaran harus lebih dari 0.';
  return null;
}

function buildOrderValues(source = {}) {
  return {
    customerId: source.customerId || '',
    serviceId: source.serviceId || '',
    quantity: source.quantity || '',
    status: source.status || 'masuk',
    paymentStatus: source.paymentStatus || 'belum_bayar',
    estimatedReadyAt: source.estimatedReadyAt || dayjs().add(2, 'day').format('YYYY-MM-DDTHH:mm'),
    notes: source.notes || '',
  };
}

function buildExpenseValues(source = {}) {
  return {
    title: source.title || '',
    category: source.category || '',
    amount: source.amount || '',
    spentAt: source.spentAt || dayjs().format('YYYY-MM-DDTHH:mm'),
    notes: source.notes || '',
  };
}

function createScanUrl(scanToken) {
  return `${baseUrl}/scan/${scanToken}`;
}

function createQrImageUrl(scanToken) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(createScanUrl(scanToken))}`;
}

function filterCustomers(items, query) {
  const q = normalize(query);
  if (!q) return items;
  return items.filter((item) => [item.name, item.phone, item.address, item.notes].some((field) => normalize(field).includes(q)));
}

function filterOrders(items, filters = {}) {
  const q = normalize(filters.q);
  return items.filter((item) => {
    if (filters.status && item.status !== filters.status) return false;
    if (filters.paymentStatus && item.paymentStatus !== filters.paymentStatus) return false;
    if (filters.start && dayjs(item.createdAt).isBefore(dayjs(filters.start).startOf('day'))) return false;
    if (filters.end && dayjs(item.createdAt).isAfter(dayjs(filters.end).endOf('day'))) return false;
    if (!q) return true;
    const haystacks = [
      item.invoiceNumber,
      item.customerName,
      item.customerPhone,
      item.status,
      item.paymentStatus,
      ...(item.items || []).map((entry) => entry.serviceName),
    ];
    return haystacks.some((field) => normalize(field).includes(q));
  });
}

function filterExpenses(items, filters = {}) {
  const q = normalize(filters.q);
  return items.filter((item) => {
    if (filters.start && dayjs(item.spentAt).isBefore(dayjs(filters.start).startOf('day'))) return false;
    if (filters.end && dayjs(item.spentAt).isAfter(dayjs(filters.end).endOf('day'))) return false;
    if (!q) return true;
    return [item.title, item.category, item.notes].some((field) => normalize(field).includes(q));
  });
}

function buildSummary(orders, expenses = []) {
  const totalRevenue = orders.reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
  const totalExpenses = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  return {
    totalOrders: orders.length,
    totalRevenue,
    paidRevenue: orders.filter((order) => order.paymentStatus === 'lunas').reduce((sum, order) => sum + Number(order.totalAmount || 0), 0),
    pendingPickup: orders.filter((order) => order.status === 'selesai').length,
    unpaidOrders: orders.filter((order) => order.paymentStatus !== 'lunas').length,
    totalExpenses,
    netProfit: totalRevenue - totalExpenses,
  };
}

function toCsvCell(value) {
  const output = String(value ?? '');
  if (/[",\n]/.test(output)) return `"${output.replace(/"/g, '""')}"`;
  return output;
}

function createReportCsv(orders) {
  const header = ['Tanggal', 'Invoice', 'Pelanggan', 'No HP', 'Layanan', 'Qty', 'Status', 'Pembayaran', 'Total'];
  const rows = orders.map((order) => {
    const item = order.items?.[0] || {};
    return [
      dayjs(order.createdAt).format('YYYY-MM-DD HH:mm'),
      order.invoiceNumber,
      order.customerName,
      order.customerPhone || '',
      item.serviceName || '',
      item.quantity ? `${item.quantity} ${item.unit || ''}`.trim() : '',
      order.status,
      order.paymentStatus,
      Number(order.totalAmount || 0),
    ];
  });
  return [header, ...rows].map((row) => row.map(toCsvCell).join(',')).join('\n');
}

function notifyTelegram(message, onSuccess) {
  if (!telegramConfig.enabled) return;
  sendTelegramMessage(telegramConfig, message)
    .then(() => {
      if (typeof onSuccess === 'function') onSuccess();
    })
    .catch((error) => {
      console.error('Telegram notification failed:', error.message);
    });
}

function notifyWhatsApp(order, message, onSuccess) {
  if (!gowaConfig.enabled || !order?.customerPhone) return;
  sendGoWAMessage(gowaConfig, order.customerPhone, message)
    .then(() => {
      if (typeof onSuccess === 'function') onSuccess();
    })
    .catch((error) => {
      console.error('GoWA notification failed:', error.message);
    });
}

function notifyNewOrder(order) {
  if (telegramConfig.enabled && !order.telegram?.newOrderSentAt) {
    notifyTelegram(buildNewOrderMessage(order), () => {
      updateOrderTelegramState(order.id, { newOrderSentAt: new Date().toISOString() });
    });
  }
  if (gowaConfig.enabled && !order.whatsapp?.newOrderSentAt && order.customerPhone) {
    notifyWhatsApp(order, buildNewOrderWhatsAppMessage(order), () => {
      updateOrderWhatsAppState(order.id, { newOrderSentAt: new Date().toISOString() });
    });
  }
}

function notifyFinishedOrder(order) {
  if (telegramConfig.enabled && order.status === 'selesai' && !order.telegram?.finishedNotifiedAt) {
    notifyTelegram(buildFinishedOrderMessage(order), () => {
      updateOrderTelegramState(order.id, {
        finishedNotifiedAt: new Date().toISOString(),
        reminderSentAt: null,
      });
    });
  }
  if (gowaConfig.enabled && order.status === 'selesai' && !order.whatsapp?.finishedNotifiedAt && order.customerPhone) {
    notifyWhatsApp(order, buildFinishedWhatsAppMessage(order), () => {
      updateOrderWhatsAppState(order.id, {
        finishedNotifiedAt: new Date().toISOString(),
        reminderSentAt: null,
      });
    });
  }
}

function handleStatusNotification(order, previousStatus) {
  if (!order) return;
  notifyNewOrder(order);
  if (order.status === 'selesai' && previousStatus !== 'selesai') notifyFinishedOrder(order);
}

function runReminderScan() {
  const now = dayjs();
  if (telegramConfig.enabled) {
    const thresholdHours = telegramConfig.reminderDelayHours;
    listOrders()
      .filter((order) => order.status === 'selesai' && !order.pickedUpAt && order.telegram?.finishedNotifiedAt && !order.telegram?.reminderSentAt)
      .forEach((order) => {
        const finishedAt = dayjs(order.telegram.finishedNotifiedAt);
        if (now.diff(finishedAt, 'hour', true) < thresholdHours) return;
        notifyTelegram(buildReminderMessage(order, thresholdHours), () => {
          updateOrderTelegramState(order.id, { reminderSentAt: new Date().toISOString() });
        });
      });
  }

  if (gowaConfig.enabled) {
    const thresholdHours = gowaConfig.reminderDelayHours;
    listOrders()
      .filter((order) => order.status === 'selesai' && !order.pickedUpAt && order.customerPhone && order.whatsapp?.finishedNotifiedAt && !order.whatsapp?.reminderSentAt)
      .forEach((order) => {
        const finishedAt = dayjs(order.whatsapp.finishedNotifiedAt);
        if (now.diff(finishedAt, 'hour', true) < thresholdHours) return;
        notifyWhatsApp(order, buildReminderWhatsAppMessage(order, thresholdHours), () => {
          updateOrderWhatsAppState(order.id, { reminderSentAt: new Date().toISOString() });
        });
      });
  }
}

app.get('/scanner', (req, res) => renderPage(req, res, 'scanner', {
  scannerMode: true,
  error: text(req.query.error),
  manualValue: text(req.query.q),
}));

app.post('/scanner/manual', (req, res) => {
  const query = text(req.body.query);
  if (!query) return res.redirect('/scanner?error=' + encodeURIComponent('Masukkan kode invoice atau token scan.') );

  const order = getOrderByInvoice(query) || getOrderByScanToken(query);
  if (!order) {
    return res.redirect('/scanner?error=' + encodeURIComponent('Order tidak ditemukan. Cek invoice atau token scan.') + '&q=' + encodeURIComponent(query));
  }

  res.redirect(`/scan/${order.scanToken}`);
});

app.get('/scan/:token', (req, res) => {
  const order = getOrderByScanToken(req.params.token);
  if (!order) return res.status(404).send('QR order tidak ditemukan');
  renderPage(req, res, 'scan-order', {
    scannerMode: true,
    order,
    statuses: getStatuses(),
    qrImageUrl: createQrImageUrl(order.scanToken),
    scanUrl: createScanUrl(order.scanToken),
    success: text(req.query.success),
  });
});

app.post('/scan/:token/status', (req, res) => {
  const order = getOrderByScanToken(req.params.token);
  if (!order) return res.status(404).send('QR order tidak ditemukan');
  const status = text(req.body.status);
  if (!getStatuses().includes(status)) return res.status(400).send('Status tidak valid');
  const previousStatus = order.status;
  const updatedOrder = updateOrderStatus(order.id, status);
  handleStatusNotification(updatedOrder, previousStatus);
  res.redirect(`/scan/${req.params.token}?success=${encodeURIComponent(`Status berhasil diubah ke ${status}`)}`);
});

app.get('/login', (req, res) => renderPage(req, res, 'login', { error: null }));

app.post('/login', (req, res) => {
  if (!adminPassword) return renderPage(req, res.status(500), 'login', { error: 'ADMIN_PASSWORD belum diset.' });
  if (text(req.body.password) !== adminPassword) {
    return renderPage(req, res.status(401), 'login', { error: 'Password salah.' });
  }
  req.session.isAdmin = true;
  res.redirect('/');
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/', requireAdmin, (req, res) => {
  const orders = listOrders();
  const expenses = listExpenses();
  const todayRevenue = orders.filter((order) => dayjs(order.createdAt).isSame(dayjs(), 'day')).reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
  const monthRevenue = orders.filter((order) => dayjs(order.createdAt).isSame(dayjs(), 'month')).reduce((sum, order) => sum + Number(order.totalAmount || 0), 0);
  const monthExpenses = expenses.filter((expense) => dayjs(expense.spentAt).isSame(dayjs(), 'month')).reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  renderPage(req, res, 'dashboard', {
    stats: {
      totalOrders: orders.length,
      activeOrders: orders.filter((order) => order.status !== 'diambil').length,
      pendingPickup: orders.filter((order) => order.status === 'selesai').length,
      todayRevenue,
      monthRevenue,
      monthExpenses,
      monthProfit: monthRevenue - monthExpenses,
    },
    recentOrders: orders.slice(0, 8),
    recentExpenses: expenses.slice(0, 5),
    statuses: getStatuses(),
  });
});

app.get('/customers', requireAdmin, (req, res) => {
  const filters = { q: text(req.query.q) };
  renderPage(req, res, 'customers', {
    customers: filterCustomers(listCustomers(), filters.q),
    filters,
  });
});

app.get('/customers/new', requireAdmin, (req, res) => renderPage(req, res, 'customer-form', { error: null, values: {}, mode: 'create', formAction: '/customers/new' }));

app.post('/customers/new', requireAdmin, (req, res) => {
  const error = validateCustomer(req.body);
  if (error) return renderPage(req, res.status(400), 'customer-form', { error, values: req.body, mode: 'create', formAction: '/customers/new' });
  createCustomer(req.body);
  res.redirect('/customers');
});

app.get('/customers/:id/edit', requireAdmin, (req, res) => {
  const customer = getCustomer(req.params.id);
  if (!customer) return res.status(404).send('Pelanggan tidak ditemukan');
  renderPage(req, res, 'customer-form', { error: null, values: customer, mode: 'edit', formAction: `/customers/${customer.id}/edit` });
});

app.post('/customers/:id/edit', requireAdmin, (req, res) => {
  const customer = getCustomer(req.params.id);
  if (!customer) return res.status(404).send('Pelanggan tidak ditemukan');
  const error = validateCustomer(req.body);
  if (error) return renderPage(req, res.status(400), 'customer-form', { error, values: { ...customer, ...req.body }, mode: 'edit', formAction: `/customers/${customer.id}/edit` });
  updateCustomer(req.params.id, req.body);
  res.redirect('/customers');
});

app.post('/customers/:id/delete', requireAdmin, (req, res) => {
  const result = removeCustomer(req.params.id);
  if (!result.ok && result.reason === 'in_use') return res.status(400).send('Pelanggan sudah dipakai di order.');
  if (!result.ok) return res.status(404).send('Pelanggan tidak ditemukan');
  res.redirect('/customers');
});

app.get('/services', requireAdmin, (req, res) => renderPage(req, res, 'services', { services: listServices() }));

app.get('/services/new', requireAdmin, (req, res) => {
  renderPage(req, res, 'service-form', {
    error: null,
    values: { category: 'kiloan', unit: 'kg', durationHours: 48, active: true },
    mode: 'create',
    formAction: '/services/new',
  });
});

app.post('/services/new', requireAdmin, (req, res) => {
  const error = validateService(req.body);
  if (error) return renderPage(req, res.status(400), 'service-form', { error, values: req.body, mode: 'create', formAction: '/services/new' });
  createService(req.body);
  res.redirect('/services');
});

app.get('/services/:id/edit', requireAdmin, (req, res) => {
  const service = getService(req.params.id);
  if (!service) return res.status(404).send('Layanan tidak ditemukan');
  renderPage(req, res, 'service-form', { error: null, values: service, mode: 'edit', formAction: `/services/${service.id}/edit` });
});

app.post('/services/:id/edit', requireAdmin, (req, res) => {
  const service = getService(req.params.id);
  if (!service) return res.status(404).send('Layanan tidak ditemukan');
  const error = validateService(req.body);
  if (error) return renderPage(req, res.status(400), 'service-form', { error, values: { ...service, ...req.body }, mode: 'edit', formAction: `/services/${service.id}/edit` });
  updateService(req.params.id, req.body);
  res.redirect('/services');
});

app.post('/services/:id/delete', requireAdmin, (req, res) => {
  const result = removeService(req.params.id);
  if (!result.ok && result.reason === 'in_use') return res.status(400).send('Layanan sudah dipakai di order.');
  if (!result.ok) return res.status(404).send('Layanan tidak ditemukan');
  res.redirect('/services');
});

app.get('/expenses', requireAdmin, (req, res) => {
  const filters = {
    q: text(req.query.q),
    start: text(req.query.start),
    end: text(req.query.end),
  };
  const expenses = filterExpenses(listExpenses(), filters);
  renderPage(req, res, 'expenses', {
    expenses,
    filters,
    totalAmount: expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0),
  });
});

app.get('/expenses/new', requireAdmin, (req, res) => renderPage(req, res, 'expense-form', {
  error: null,
  values: buildExpenseValues(),
  mode: 'create',
  formAction: '/expenses/new',
}));

app.post('/expenses/new', requireAdmin, (req, res) => {
  const error = validateExpense(req.body);
  if (error) return renderPage(req, res.status(400), 'expense-form', {
    error,
    values: buildExpenseValues(req.body),
    mode: 'create',
    formAction: '/expenses/new',
  });
  createExpense(req.body);
  res.redirect('/expenses');
});

app.get('/expenses/:id/edit', requireAdmin, (req, res) => {
  const expense = getExpense(req.params.id);
  if (!expense) return res.status(404).send('Pengeluaran tidak ditemukan');
  renderPage(req, res, 'expense-form', {
    error: null,
    values: buildExpenseValues(expense),
    mode: 'edit',
    formAction: `/expenses/${expense.id}/edit`,
  });
});

app.post('/expenses/:id/edit', requireAdmin, (req, res) => {
  const expense = getExpense(req.params.id);
  if (!expense) return res.status(404).send('Pengeluaran tidak ditemukan');
  const error = validateExpense(req.body);
  if (error) return renderPage(req, res.status(400), 'expense-form', {
    error,
    values: buildExpenseValues({ ...expense, ...req.body }),
    mode: 'edit',
    formAction: `/expenses/${expense.id}/edit`,
  });
  updateExpense(req.params.id, req.body);
  res.redirect('/expenses');
});

app.post('/expenses/:id/delete', requireAdmin, (req, res) => {
  const result = removeExpense(req.params.id);
  if (!result.ok) return res.status(404).send('Pengeluaran tidak ditemukan');
  res.redirect('/expenses');
});

app.get('/orders', requireAdmin, (req, res) => {
  const filters = {
    q: text(req.query.q),
    status: text(req.query.status),
    paymentStatus: text(req.query.paymentStatus),
  };
  renderPage(req, res, 'orders', {
    orders: filterOrders(listOrders(), filters),
    filters,
    statuses: getStatuses(),
  });
});

app.get('/orders/new', requireAdmin, (req, res) => {
  renderPage(req, res, 'order-form', {
    error: null,
    values: buildOrderValues(),
    customers: listCustomers(),
    services: listServices().filter((service) => service.active),
    statuses: getStatuses(),
    mode: 'create',
    formAction: '/orders/new',
    order: null,
  });
});

app.post('/orders/new', requireAdmin, (req, res) => {
  const customers = listCustomers();
  const services = listServices().filter((service) => service.active);
  const statuses = getStatuses();
  const error = validateOrder(req.body);
  const customer = getCustomer(req.body.customerId);
  const service = getService(req.body.serviceId);
  if (error || !customer || !service) {
    return renderPage(req, res.status(400), 'order-form', {
      error: error || 'Pelanggan atau layanan tidak ditemukan.',
      values: buildOrderValues(req.body),
      customers,
      services,
      statuses,
      mode: 'create',
      formAction: '/orders/new',
      order: null,
    });
  }

  const quantity = Number(req.body.quantity || 0);
  const totalAmount = quantity * Number(service.price || 0);
  const order = createOrder({
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    status: req.body.status,
    paymentStatus: req.body.paymentStatus,
    notes: req.body.notes,
    estimatedReadyAt: req.body.estimatedReadyAt,
    totalAmount,
    items: [{
      serviceId: service.id,
      serviceName: service.name,
      quantity,
      unit: service.unit,
      unitPrice: service.price,
      subtotal: totalAmount,
    }],
  });

  handleStatusNotification(order, null);
  res.redirect(`/orders/${order.id}/receipt`);
});

app.get('/orders/:id/edit', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order tidak ditemukan');
  const firstItem = order.items?.[0] || {};
  renderPage(req, res, 'order-form', {
    error: null,
    values: buildOrderValues({
      customerId: order.customerId,
      serviceId: firstItem.serviceId,
      quantity: firstItem.quantity,
      status: order.status,
      paymentStatus: order.paymentStatus,
      estimatedReadyAt: order.estimatedReadyAt,
      notes: order.notes,
    }),
    customers: listCustomers(),
    services: listServices().filter((service) => service.active || service.id === firstItem.serviceId),
    statuses: getStatuses(),
    mode: 'edit',
    formAction: `/orders/${order.id}/edit`,
    order,
  });
});

app.post('/orders/:id/edit', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order tidak ditemukan');
  const customers = listCustomers();
  const services = listServices().filter((service) => service.active || service.id === order.items?.[0]?.serviceId);
  const statuses = getStatuses();
  const error = validateOrder(req.body);
  const customer = getCustomer(req.body.customerId);
  const service = getService(req.body.serviceId);
  if (error || !customer || !service) {
    return renderPage(req, res.status(400), 'order-form', {
      error: error || 'Pelanggan atau layanan tidak ditemukan.',
      values: buildOrderValues(req.body),
      customers,
      services,
      statuses,
      mode: 'edit',
      formAction: `/orders/${order.id}/edit`,
      order,
    });
  }

  const quantity = Number(req.body.quantity || 0);
  const totalAmount = quantity * Number(service.price || 0);
  const previousStatus = order.status;
  const updatedOrder = updateOrder(req.params.id, {
    customerId: customer.id,
    customerName: customer.name,
    customerPhone: customer.phone,
    status: req.body.status,
    paymentStatus: req.body.paymentStatus,
    notes: req.body.notes,
    estimatedReadyAt: req.body.estimatedReadyAt,
    totalAmount,
    telegram: order.telegram || {},
    items: [{
      id: order.items?.[0]?.id,
      serviceId: service.id,
      serviceName: service.name,
      quantity,
      unit: service.unit,
      unitPrice: service.price,
      subtotal: totalAmount,
    }],
  });
  handleStatusNotification(updatedOrder, previousStatus);
  res.redirect('/orders');
});

app.post('/orders/:id/status', requireAdmin, (req, res) => {
  const status = text(req.body.status);
  if (!getStatuses().includes(status)) return res.status(400).send('Status tidak valid');
  const existingOrder = getOrder(req.params.id);
  if (!existingOrder) return res.status(404).send('Order tidak ditemukan');
  const previousStatus = existingOrder.status;
  const order = updateOrderStatus(req.params.id, status);
  handleStatusNotification(order, previousStatus);
  res.redirect(req.get('referer') || '/orders');
});

app.post('/orders/:id/delete', requireAdmin, (req, res) => {
  const result = removeOrder(req.params.id);
  if (!result.ok) return res.status(404).send('Order tidak ditemukan');
  res.redirect('/orders');
});

app.get('/orders/:id', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order tidak ditemukan');
  renderPage(req, res, 'order-detail', { order, statuses: getStatuses() });
});

app.get('/orders/:id/receipt', requireAdmin, (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).send('Order tidak ditemukan');
  renderPage(req, res, 'receipt', {
    order,
    qrImageUrl: createQrImageUrl(order.scanToken),
    scanUrl: createScanUrl(order.scanToken),
  });
});

app.get('/reports', requireAdmin, (req, res) => {
  const today = dayjs();
  const filters = {
    q: text(req.query.q),
    status: text(req.query.status),
    paymentStatus: text(req.query.paymentStatus),
    start: text(req.query.start) || today.startOf('month').format('YYYY-MM-DD'),
    end: text(req.query.end) || today.endOf('month').format('YYYY-MM-DD'),
  };
  const orders = filterOrders(listOrders(), filters);
  const expenses = filterExpenses(listExpenses(), { q: text(req.query.expenseQ), start: filters.start, end: filters.end });
  renderPage(req, res, 'reports', {
    orders,
    expenses,
    filters,
    statuses: getStatuses(),
    summary: buildSummary(orders, expenses),
  });
});

app.get('/reports/export.csv', requireAdmin, (req, res) => {
  const filters = {
    q: text(req.query.q),
    status: text(req.query.status),
    paymentStatus: text(req.query.paymentStatus),
    start: text(req.query.start),
    end: text(req.query.end),
  };
  const csv = createReportCsv(filterOrders(listOrders(), filters));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="laporan-laundry-${dayjs().format('YYYYMMDD-HHmm')}.csv"`);
  res.send(`\uFEFF${csv}`);
});

app.get('/health', (req, res) => res.json({ ok: true, app: appName, telegramEnabled: telegramConfig.enabled, gowaEnabled: gowaConfig.enabled }));

runReminderScan();
if (telegramConfig.enabled || gowaConfig.enabled) {
  const reminderIntervalMinutes = telegramConfig.enabled ? telegramConfig.reminderIntervalMinutes : gowaConfig.reminderIntervalMinutes;
  setInterval(runReminderScan, reminderIntervalMinutes * 60 * 1000);
}

app.listen(port, () => {
  console.log(`${appName} ready at ${baseUrl}`);
  console.log(`Telegram notifier: ${telegramConfig.enabled ? 'enabled' : 'disabled'}`);
  console.log(`GoWA notifier: ${gowaConfig.enabled ? 'enabled' : 'disabled'}`);
});
