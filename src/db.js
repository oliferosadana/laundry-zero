const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dayjs = require('dayjs');

const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || './data/laundry.json');

const defaultDb = {
  counters: {
    customer: 0,
    service: 0,
    order: 0,
    item: 0,
    expense: 0,
  },
  settings: {
    storeName: process.env.STORE_NAME || 'Laundry Kamu',
    phone: process.env.STORE_PHONE || '',
    address: process.env.STORE_ADDRESS || '',
    receiptFooter: process.env.RECEIPT_FOOTER || 'Terima kasih sudah menggunakan layanan kami.',
  },
  statuses: ['masuk', 'diproses', 'selesai', 'diambil'],
  customers: [],
  services: [],
  orders: [],
  expenses: [],
};

function ensureDb() {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify(defaultDb, null, 2));
  }
}

function loadDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
}

function saveDb(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

function nextId(db, key) {
  db.counters[key] = Number(db.counters[key] || 0) + 1;
  return db.counters[key];
}

function seedDefaults() {
  const db = loadDb();
  if (!db.services.length) {
    const defaults = [
      { name: 'Cuci Kiloan Reguler', category: 'kiloan', unit: 'kg', price: 7000, durationHours: 48, active: true },
      { name: 'Cuci Kiloan Express', category: 'kiloan', unit: 'kg', price: 12000, durationHours: 24, active: true },
      { name: 'Setrika', category: 'kiloan', unit: 'kg', price: 5000, durationHours: 24, active: true },
      { name: 'Cuci Selimut', category: 'satuan', unit: 'pcs', price: 25000, durationHours: 72, active: true },
    ];
    defaults.forEach((service) => {
      db.services.push({
        id: nextId(db, 'service'),
        ...service,
        createdAt: new Date().toISOString(),
      });
    });
    saveDb(db);
  }
}

function listCustomers() {
  return [...loadDb().customers].sort((a, b) => a.name.localeCompare(b.name));
}

function createCustomer(payload) {
  const db = loadDb();
  const customer = {
    id: nextId(db, 'customer'),
    name: payload.name.trim(),
    phone: String(payload.phone || '').trim(),
    address: String(payload.address || '').trim(),
    notes: String(payload.notes || '').trim(),
    createdAt: new Date().toISOString(),
  };
  db.customers.push(customer);
  saveDb(db);
  return customer;
}

function getCustomer(id) {
  return loadDb().customers.find((item) => item.id === Number(id)) || null;
}

function updateCustomer(id, payload) {
  const db = loadDb();
  const index = db.customers.findIndex((item) => item.id === Number(id));
  if (index === -1) return null;
  db.customers[index] = {
    ...db.customers[index],
    name: payload.name.trim(),
    phone: String(payload.phone || '').trim(),
    address: String(payload.address || '').trim(),
    notes: String(payload.notes || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return db.customers[index];
}

function removeCustomer(id) {
  const db = loadDb();
  const numericId = Number(id);
  if (db.orders.some((order) => order.customerId === numericId)) return { ok: false, reason: 'in_use' };
  const index = db.customers.findIndex((item) => item.id === numericId);
  if (index === -1) return { ok: false, reason: 'not_found' };
  db.customers.splice(index, 1);
  saveDb(db);
  return { ok: true };
}

function listServices() {
  return [...loadDb().services].sort((a, b) => a.name.localeCompare(b.name));
}

function createService(payload) {
  const db = loadDb();
  const service = {
    id: nextId(db, 'service'),
    name: payload.name.trim(),
    category: payload.category,
    unit: payload.unit.trim(),
    price: Number(payload.price || 0),
    durationHours: Number(payload.durationHours || 24),
    active: payload.active === 'on' || payload.active === true,
    createdAt: new Date().toISOString(),
  };
  db.services.push(service);
  saveDb(db);
  return service;
}

function getService(id) {
  return loadDb().services.find((item) => item.id === Number(id)) || null;
}

function updateService(id, payload) {
  const db = loadDb();
  const index = db.services.findIndex((item) => item.id === Number(id));
  if (index === -1) return null;
  db.services[index] = {
    ...db.services[index],
    name: payload.name.trim(),
    category: payload.category,
    unit: payload.unit.trim(),
    price: Number(payload.price || 0),
    durationHours: Number(payload.durationHours || 24),
    active: payload.active === 'on' || payload.active === true,
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return db.services[index];
}

function removeService(id) {
  const db = loadDb();
  const numericId = Number(id);
  if (db.orders.some((order) => (order.items || []).some((item) => item.serviceId === numericId))) return { ok: false, reason: 'in_use' };
  const index = db.services.findIndex((item) => item.id === numericId);
  if (index === -1) return { ok: false, reason: 'not_found' };
  db.services.splice(index, 1);
  saveDb(db);
  return { ok: true };
}

function buildInvoice(orderId) {
  return `LZ-${dayjs().format('YYYYMMDD')}-${String(orderId).padStart(4, '0')}`;
}

function generateScanToken() {
  return crypto.randomBytes(12).toString('hex');
}

function ensureOrderScanTokens() {
  const db = loadDb();
  let changed = false;
  const used = new Set();

  db.orders.forEach((order) => {
    if (!order.scanToken || used.has(order.scanToken)) {
      let token = generateScanToken();
      while (used.has(token)) token = generateScanToken();
      order.scanToken = token;
      changed = true;
    }
    used.add(order.scanToken);
  });

  if (changed) saveDb(db);
}

function createOrder(payload) {
  const db = loadDb();
  const orderId = nextId(db, 'order');
  const items = (payload.items || []).map((item) => ({
    id: nextId(db, 'item'),
    serviceId: Number(item.serviceId),
    serviceName: item.serviceName,
    quantity: Number(item.quantity || 0),
    unit: item.unit,
    unitPrice: Number(item.unitPrice || 0),
    subtotal: Number(item.subtotal || 0),
  }));
  const order = {
    id: orderId,
    invoiceNumber: buildInvoice(orderId),
    scanToken: payload.scanToken || generateScanToken(),
    customerId: Number(payload.customerId),
    customerName: payload.customerName,
    customerPhone: payload.customerPhone || '',
    status: payload.status,
    paymentStatus: payload.paymentStatus,
    notes: String(payload.notes || '').trim(),
    estimatedReadyAt: payload.estimatedReadyAt || null,
    pickedUpAt: payload.status === 'diambil' ? new Date().toISOString() : null,
    totalAmount: Number(payload.totalAmount || 0),
    items,
    telegram: payload.telegram || {},
    createdAt: new Date().toISOString(),
  };
  db.orders.push(order);
  saveDb(db);
  return order;
}

function listOrders() {
  return [...loadDb().orders].sort((a, b) => b.id - a.id);
}

function getOrder(id) {
  return loadDb().orders.find((item) => item.id === Number(id)) || null;
}

function getOrderByScanToken(scanToken) {
  return loadDb().orders.find((item) => item.scanToken === scanToken) || null;
}

function getOrderByInvoice(invoiceNumber) {
  const normalized = String(invoiceNumber || '').trim().toLowerCase();
  return loadDb().orders.find((item) => String(item.invoiceNumber || '').trim().toLowerCase() === normalized) || null;
}

function updateOrder(id, payload) {
  const db = loadDb();
  const index = db.orders.findIndex((item) => item.id === Number(id));
  if (index === -1) return null;
  const current = db.orders[index];
  db.orders[index] = {
    ...current,
    customerId: Number(payload.customerId),
    customerName: payload.customerName,
    customerPhone: payload.customerPhone || '',
    status: payload.status,
    paymentStatus: payload.paymentStatus,
    notes: String(payload.notes || '').trim(),
    estimatedReadyAt: payload.estimatedReadyAt || null,
    totalAmount: Number(payload.totalAmount || 0),
    items: (payload.items || []).map((item) => ({
      id: item.id || nextId(db, 'item'),
      serviceId: Number(item.serviceId),
      serviceName: item.serviceName,
      quantity: Number(item.quantity || 0),
      unit: item.unit,
      unitPrice: Number(item.unitPrice || 0),
      subtotal: Number(item.subtotal || 0),
    })),
    telegram: payload.telegram || current.telegram || {},
    pickedUpAt: payload.status === 'diambil' ? current.pickedUpAt || new Date().toISOString() : current.pickedUpAt,
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return db.orders[index];
}

function updateOrderStatus(id, status) {
  const db = loadDb();
  const index = db.orders.findIndex((item) => item.id === Number(id));
  if (index === -1) return null;
  db.orders[index] = {
    ...db.orders[index],
    status,
    pickedUpAt: status === 'diambil' ? db.orders[index].pickedUpAt || new Date().toISOString() : db.orders[index].pickedUpAt,
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return db.orders[index];
}

function removeOrder(id) {
  const db = loadDb();
  const index = db.orders.findIndex((item) => item.id === Number(id));
  if (index === -1) return { ok: false, reason: 'not_found' };
  db.orders.splice(index, 1);
  saveDb(db);
  return { ok: true };
}

function updateOrderTelegramState(id, telegramPatch) {
  const db = loadDb();
  const index = db.orders.findIndex((item) => item.id === Number(id));
  if (index === -1) return null;
  db.orders[index] = {
    ...db.orders[index],
    telegram: {
      ...(db.orders[index].telegram || {}),
      ...telegramPatch,
    },
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return db.orders[index];
}

function updateOrderWhatsAppState(id, whatsappPatch) {
  const db = loadDb();
  const index = db.orders.findIndex((item) => item.id === Number(id));
  if (index === -1) return null;
  db.orders[index] = {
    ...db.orders[index],
    whatsapp: {
      ...(db.orders[index].whatsapp || {}),
      ...whatsappPatch,
    },
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return db.orders[index];
}

function listExpenses() {
  return [...(loadDb().expenses || [])].sort((a, b) => dayjs(b.spentAt).valueOf() - dayjs(a.spentAt).valueOf());
}

function createExpense(payload) {
  const db = loadDb();
  const expense = {
    id: nextId(db, 'expense'),
    title: payload.title.trim(),
    category: payload.category.trim(),
    amount: Number(payload.amount || 0),
    spentAt: payload.spentAt || new Date().toISOString(),
    notes: String(payload.notes || '').trim(),
    createdAt: new Date().toISOString(),
  };
  db.expenses = db.expenses || [];
  db.expenses.push(expense);
  saveDb(db);
  return expense;
}

function getExpense(id) {
  return (loadDb().expenses || []).find((item) => item.id === Number(id)) || null;
}

function updateExpense(id, payload) {
  const db = loadDb();
  db.expenses = db.expenses || [];
  const index = db.expenses.findIndex((item) => item.id === Number(id));
  if (index === -1) return null;
  db.expenses[index] = {
    ...db.expenses[index],
    title: payload.title.trim(),
    category: payload.category.trim(),
    amount: Number(payload.amount || 0),
    spentAt: payload.spentAt || db.expenses[index].spentAt,
    notes: String(payload.notes || '').trim(),
    updatedAt: new Date().toISOString(),
  };
  saveDb(db);
  return db.expenses[index];
}

function removeExpense(id) {
  const db = loadDb();
  db.expenses = db.expenses || [];
  const index = db.expenses.findIndex((item) => item.id === Number(id));
  if (index === -1) return { ok: false, reason: 'not_found' };
  db.expenses.splice(index, 1);
  saveDb(db);
  return { ok: true };
}

function getSettings() {
  return loadDb().settings;
}

function getStatuses() {
  return loadDb().statuses;
}

module.exports = {
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
};
