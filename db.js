const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = path.join(dataDir, "stock.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    tenant_id INTEGER,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    unit TEXT NOT NULL,
    min_qty REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER,
    product_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    qty REAL NOT NULL,
    note TEXT,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    plan_name TEXT NOT NULL,
    price REAL NOT NULL,
    status TEXT NOT NULL,
    trial_started_at TEXT,
    trial_ends_at TEXT,
    paid_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT NOT NULL,
    reference TEXT,
    slip_path TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    approved_at TEXT,
    approved_by INTEGER,
    note TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (approved_by) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS invoice_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE NOT NULL,
    business_name TEXT NOT NULL,
    tax_id TEXT,
    branch TEXT,
    address TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

const addColumnIfMissing = (table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((col) => col.name);
  if (!columns.includes(column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
};

addColumnIfMissing("users", "tenant_id", "INTEGER");
addColumnIfMissing("products", "tenant_id", "INTEGER");
addColumnIfMissing("stock_movements", "tenant_id", "INTEGER");

const ensureAdmin = () => {
  const userCount = db.prepare("SELECT COUNT(*) AS count FROM users").get();
  if (userCount.count === 0) {
    const passwordHash = bcrypt.hashSync("admin123", 10);
    const result = db.prepare(
      "INSERT INTO users (username, password_hash, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run("admin", passwordHash, "admin", null, new Date().toISOString());
    db.prepare("UPDATE users SET tenant_id = id WHERE id = ?").run(result.lastInsertRowid);
  }
};

ensureAdmin();

const ensureTenantIds = () => {
  db.prepare("UPDATE users SET tenant_id = id WHERE tenant_id IS NULL").run();
  const admin = db
    .prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1")
    .get();
  if (admin) {
    db.prepare("UPDATE products SET tenant_id = ? WHERE tenant_id IS NULL").run(admin.id);
    db.prepare("UPDATE stock_movements SET tenant_id = ? WHERE tenant_id IS NULL").run(admin.id);
  }
};

ensureTenantIds();

module.exports = db;
