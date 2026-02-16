const fs = require("fs");
const path = require("path");
const https = require("https");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { parse } = require("csv-parse/sync");
const db = require("./db");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const slipsDir = path.join(__dirname, "data", "slips");
if (!fs.existsSync(slipsDir)) {
  fs.mkdirSync(slipsDir, { recursive: true });
}

const slipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, slipsDir),
    filename: (req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      cb(null, `${Date.now()}-${safeName}`);
    }
  })
});

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-secret";
const PLAN = {
  name: "Cafe",
  price: 399,
  periodDays: 30
};
const FREE_MODE = true;
const SELLER = {
  businessName: "Cafe Stock Co., Ltd.",
  taxId: "-",
  branch: "สำนักงานใหญ่",
  address: "-",
  email: "support@example.com",
  phone: "-"
};

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  res.locals.subscription = null;
  if (req.session.user) {
    res.locals.subscription = db
      .prepare("SELECT * FROM subscriptions WHERE user_id = ?")
      .get(req.session.user.id);
  }
  delete req.session.flash;
  next();
});

const setFlash = (req, type, message) => {
  req.session.flash = { type, message };
};

const getTenantId = (req) => {
  return req.session.user.tenant_id || req.session.user.id;
};

const generateSku = () => {
  const stamp = Date.now();
  const rand = Math.floor(Math.random() * 1000);
  return `PRD-${stamp}-${rand}`;
};

const requireLogin = (req, res, next) => {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect("/login");
  }
  return next();
};

const requireRole = (role) => (req, res, next) => {
  if (!req.session.user || req.session.user.role !== role) {
    return res.status(403).render("error", {
      title: "ไม่มีสิทธิ์เข้าถึง",
      message: "คุณไม่มีสิทธิ์ดูหน้านี้"
    });
  }
  return next();
};

const ensureSubscription = (userId) => {
  const existing = db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
  if (!existing) {
    const now = new Date();
    const trialEnds = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    db.prepare(
      `
        INSERT INTO subscriptions
        (user_id, plan_name, price, status, trial_started_at, trial_ends_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      userId,
      PLAN.name,
      PLAN.price,
      "trialing",
      now.toISOString(),
      trialEnds.toISOString(),
      now.toISOString(),
      now.toISOString()
    );
    return;
  }

  if (!existing.trial_started_at) {
    const now = new Date();
    const trialEnds = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    db.prepare(
      "UPDATE subscriptions SET trial_started_at = ?, trial_ends_at = ?, status = ?, updated_at = ? WHERE user_id = ?"
    ).run(now.toISOString(), trialEnds.toISOString(), "trialing", now.toISOString(), userId);
  }
};

const getSubscription = (userId) => {
  return db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").get(userId);
};

const isSubscriptionActive = (subscription) => {
  if (!subscription) {
    return false;
  }
  const now = Date.now();
  if (subscription.trial_ends_at && new Date(subscription.trial_ends_at).getTime() >= now) {
    return true;
  }
  if (subscription.paid_until && new Date(subscription.paid_until).getTime() >= now) {
    return true;
  }
  return false;
};

const requireSubscription = (req, res, next) => {
  if (FREE_MODE) {
    return next();
  }
  const subscription = getSubscription(req.session.user.id);
  if (isSubscriptionActive(subscription)) {
    res.locals.subscription = subscription;
    return next();
  }
  setFlash(req, "error", "หมดช่วงทดลองใช้งาน กรุณาชำระเงินเพื่อใช้งานต่อ");
  return res.redirect("/billing");
};

const getProductsWithStock = (tenantId) => {
  return db
    .prepare(
      `
        SELECT
          p.*, 
          COALESCE(
            SUM(
              CASE
                WHEN m.type = 'in' THEN m.qty
                WHEN m.type = 'out' THEN -m.qty
                WHEN m.type = 'adjust' THEN m.qty
                ELSE 0
              END
            ),
            0
          ) AS stock
        FROM products p
        LEFT JOIN stock_movements m ON m.product_id = p.id AND m.tenant_id = ?
        WHERE p.tenant_id = ?
        GROUP BY p.id
        ORDER BY p.name ASC
      `
    )
    .all(tenantId, tenantId);
};

const getCurrentStock = (productId, tenantId) => {
  const row = db
    .prepare(
      `
        SELECT
          COALESCE(
            SUM(
              CASE
                WHEN type = 'in' THEN qty
                WHEN type = 'out' THEN -qty
                WHEN type = 'adjust' THEN qty
                ELSE 0
              END
            ),
            0
          ) AS stock
        FROM stock_movements
        WHERE product_id = ? AND tenant_id = ?
      `
    )
    .get(productId, tenantId);
  return row ? row.stock : 0;
};

app.get("/", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  return res.redirect("/landing");
});

app.get("/landing", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  return res.render("landing", { title: "SmartWarehouse สำหรับคาเฟ่" });
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  return res.render("login", { title: "เข้าสู่ระบบ" });
});

app.get("/register", (req, res) => {
  if (req.session.user) {
    return res.redirect("/dashboard");
  }
  return res.render("register", { title: "สมัครสมาชิก" });
});

app.post("/register", (req, res) => {
  const { username, password, confirm_password } = req.body;

  if (!username || !password || !confirm_password) {
    setFlash(req, "error", "กรุณากรอกชื่อผู้ใช้และรหัสผ่านให้ครบถ้วน");
    return res.redirect("/register");
  }

  if (password !== confirm_password) {
    setFlash(req, "error", "รหัสผ่านไม่ตรงกัน");
    return res.redirect("/register");
  }

  try {
    const existing = db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(username.trim());
    if (existing) {
      setFlash(req, "error", "ชื่อผู้ใช้นี้ถูกใช้งานแล้ว");
      return res.redirect("/register");
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const result = db
      .prepare("INSERT INTO users (username, password_hash, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(username.trim(), passwordHash, "admin", null, new Date().toISOString());

    db.prepare("UPDATE users SET tenant_id = id WHERE id = ?").run(result.lastInsertRowid);
    req.session.user = {
      id: result.lastInsertRowid,
      username: username.trim(),
      role: "admin",
      tenant_id: result.lastInsertRowid
    };
    ensureSubscription(result.lastInsertRowid);
    return res.redirect("/dashboard");
  } catch (error) {
    setFlash(req, "error", "สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่");
    return res.redirect("/register");
  }
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = db
    .prepare("SELECT id, username, password_hash, role, tenant_id FROM users WHERE username = ?")
    .get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    setFlash(req, "error", "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง");
    return res.redirect("/login");
  }

  if (!user.tenant_id) {
    db.prepare("UPDATE users SET tenant_id = id WHERE id = ?").run(user.id);
    user.tenant_id = user.id;
  }
  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    tenant_id: user.tenant_id
  };
  ensureSubscription(user.id);
  const returnTo = req.session.returnTo || "/dashboard";
  delete req.session.returnTo;
  return res.redirect(returnTo);
});

const getLowStockItems = (tenantId) => {
  return getProductsWithStock(tenantId).filter((item) => item.stock <= item.min_qty);
};

const getDashboardStats = (tenantId) => {
  const totalProducts = db
    .prepare("SELECT COUNT(*) AS count FROM products WHERE tenant_id = ?")
    .get(tenantId).count;
  const lowStockCount = getLowStockItems(tenantId).length;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weeklyMovements = db
    .prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE tenant_id = ? AND created_at >= ?")
    .get(tenantId, weekAgo).count;
  const recentMovements = db
    .prepare(
      `
        SELECT m.*, p.name AS product_name, p.unit
        FROM stock_movements m
        JOIN products p ON p.id = m.product_id
        WHERE m.tenant_id = ?
        ORDER BY m.created_at DESC
        LIMIT 6
      `
    )
    .all(tenantId);
  const lowStockItems = getLowStockItems(tenantId).slice(0, 6);

  return {
    totalProducts,
    lowStockCount,
    weeklyMovements,
    recentMovements,
    lowStockItems
  };
};

const formatDate = (iso) => {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleDateString();
};

const getDaysLeft = (iso) => {
  if (!iso) {
    return 0;
  }
  const diffMs = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
};

app.get("/dashboard", requireLogin, requireSubscription, (req, res) => {
  const stats = getDashboardStats(getTenantId(req));
  res.render("dashboard", {
    title: "แดชบอร์ด",
    stats
  });
});

app.get("/alerts", requireLogin, requireSubscription, (req, res) => {
  const products = getLowStockItems(getTenantId(req));
  res.render("alerts", {
    title: "แจ้งเตือนสต๊อกต่ำ",
    products
  });
});

app.get("/billing", requireLogin, (req, res) => {
  const subscription = getSubscription(req.session.user.id);
  const profile = db
    .prepare("SELECT * FROM invoice_profiles WHERE user_id = ?")
    .get(req.session.user.id);
  const payments = db
    .prepare(
      "SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 8"
    )
    .all(req.session.user.id);

  res.render("billing", {
    title: "การชำระเงิน",
    subscription,
    profile,
    payments,
    plan: PLAN,
    trialDaysLeft: subscription ? getDaysLeft(subscription.trial_ends_at) : 0,
    paidUntil: subscription ? formatDate(subscription.paid_until) : "-"
  });
});

app.post("/billing/profile", requireLogin, (req, res) => {
  const { business_name, tax_id, branch, address, email, phone } = req.body;
  if (!business_name || !address) {
    setFlash(req, "error", "กรุณากรอกชื่อกิจการและที่อยู่");
    return res.redirect("/billing");
  }

  const existing = db
    .prepare("SELECT id FROM invoice_profiles WHERE user_id = ?")
    .get(req.session.user.id);

  if (existing) {
    db.prepare(
      `
        UPDATE invoice_profiles
        SET business_name = ?, tax_id = ?, branch = ?, address = ?, email = ?, phone = ?, updated_at = ?
        WHERE user_id = ?
      `
    ).run(
      business_name.trim(),
      tax_id ? tax_id.trim() : null,
      branch ? branch.trim() : null,
      address.trim(),
      email ? email.trim() : null,
      phone ? phone.trim() : null,
      new Date().toISOString(),
      req.session.user.id
    );
  } else {
    db.prepare(
      `
        INSERT INTO invoice_profiles
        (user_id, business_name, tax_id, branch, address, email, phone, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      req.session.user.id,
      business_name.trim(),
      tax_id ? tax_id.trim() : null,
      branch ? branch.trim() : null,
      address.trim(),
      email ? email.trim() : null,
      phone ? phone.trim() : null,
      new Date().toISOString()
    );
  }

  setFlash(req, "success", "บันทึกข้อมูลใบกำกับภาษีเรียบร้อย");
  return res.redirect("/billing");
});

app.post("/billing/pay", requireLogin, slipUpload.single("slip"), (req, res) => {
  const { reference } = req.body;
  if (!reference && !req.file) {
    setFlash(req, "error", "กรุณากรอกเลขอ้างอิงหรืออัปโหลดสลิป");
    return res.redirect("/billing");
  }

  db.prepare(
    `
      INSERT INTO payments (user_id, amount, method, reference, slip_path, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    req.session.user.id,
    PLAN.price,
    "promptpay",
    reference ? reference.trim() : null,
    req.file ? req.file.path : null,
    "pending",
    new Date().toISOString()
  );

  db.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ?").run(
    "pending",
    new Date().toISOString(),
    req.session.user.id
  );

  setFlash(req, "success", "ส่งข้อมูลการชำระเงินเรียบร้อย รอการตรวจสอบ");
  return res.redirect("/billing");
});

app.get("/admin/payments", requireLogin, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const payments = db
    .prepare(
      `
        SELECT p.*, u.username
        FROM payments p
        JOIN users u ON u.id = p.user_id
        WHERE u.tenant_id = ?
        ORDER BY p.created_at DESC
        LIMIT 50
      `
    )
    .all(tenantId);

  res.render("admin/payments", {
    title: "อนุมัติการชำระเงิน",
    payments
  });
});

app.get("/admin/payments/:id/slip", requireLogin, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const payment = db
    .prepare(
      "SELECT p.* FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.tenant_id = ?"
    )
    .get(req.params.id, tenantId);
  if (!payment || !payment.slip_path) {
    return res.status(404).render("error", {
      title: "ไม่พบข้อมูล",
      message: "ไม่พบสลิปการชำระเงิน"
    });
  }
  return res.sendFile(payment.slip_path);
});

app.post("/admin/payments/:id/approve", requireLogin, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const payment = db
    .prepare(
      "SELECT p.* FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.tenant_id = ?"
    )
    .get(req.params.id, tenantId);
  if (!payment) {
    setFlash(req, "error", "ไม่พบรายการชำระเงิน");
    return res.redirect("/admin/payments");
  }

  const paidUntil = new Date(Date.now() + PLAN.periodDays * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    "UPDATE payments SET status = ?, approved_at = ?, approved_by = ? WHERE id = ?"
  ).run("approved", new Date().toISOString(), req.session.user.id, req.params.id);

  db.prepare(
    "UPDATE subscriptions SET paid_until = ?, status = ?, updated_at = ? WHERE user_id = ?"
  ).run(paidUntil, "active", new Date().toISOString(), payment.user_id);

  setFlash(req, "success", "อนุมัติการชำระเงินเรียบร้อย");
  return res.redirect("/admin/payments");
});

app.post("/admin/payments/:id/reject", requireLogin, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const payment = db
    .prepare(
      "SELECT p.* FROM payments p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND u.tenant_id = ?"
    )
    .get(req.params.id, tenantId);
  if (!payment) {
    setFlash(req, "error", "ไม่พบรายการชำระเงิน");
    return res.redirect("/admin/payments");
  }

  db.prepare("UPDATE payments SET status = ? WHERE id = ?").run("rejected", req.params.id);
  db.prepare("UPDATE subscriptions SET status = ?, updated_at = ? WHERE user_id = ?").run(
    "past_due",
    new Date().toISOString(),
    payment.user_id
  );

  setFlash(req, "success", "ปฏิเสธการชำระเงินเรียบร้อย");
  return res.redirect("/admin/payments");
});

app.get("/invoice/:paymentId", requireLogin, (req, res) => {
  const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(req.params.paymentId);
  if (!payment || payment.status !== "approved") {
    return res.status(404).render("error", {
      title: "ไม่พบข้อมูล",
      message: "ไม่พบใบกำกับภาษีที่อนุมัติแล้ว"
    });
  }

  if (req.session.user.role !== "admin" && payment.user_id !== req.session.user.id) {
    return res.status(403).render("error", {
      title: "ไม่มีสิทธิ์เข้าถึง",
      message: "คุณไม่มีสิทธิ์ดูใบกำกับภาษีนี้"
    });
  }

  const profile = db
    .prepare("SELECT * FROM invoice_profiles WHERE user_id = ?")
    .get(payment.user_id);

  if (!profile) {
    setFlash(req, "error", "กรุณากรอกข้อมูลใบกำกับภาษีก่อน");
    return res.redirect("/billing");
  }

  res.render("invoice", {
    title: "ใบกำกับภาษี",
    seller: SELLER,
    profile,
    payment,
    plan: PLAN
  });
});

app.post("/logout", requireLogin, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/products", requireLogin, requireSubscription, (req, res) => {
  const tenantId = getTenantId(req);
  const query = (req.query.q || "").trim().toLowerCase();
  const onlyLow = req.query.low === "1";
  let products = getProductsWithStock(tenantId);

  if (query) {
    products = products.filter(
      (item) => item.name.toLowerCase().includes(query)
    );
  }

  if (onlyLow) {
    products = products.filter((item) => item.stock <= item.min_qty);
  }

  res.render("products/index", {
    title: "สินค้า",
    products,
    query,
    onlyLow
  });
});

app.get("/products/new", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  res.render("products/form", {
    title: "เพิ่มสินค้า",
    product: null
  });
});

app.post("/products/new", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  const { name, unit, min_qty } = req.body;
  if (!name || !unit) {
    setFlash(req, "error", "กรุณากรอกชื่อ และหน่วย");
    return res.redirect("/products/new");
  }

  try {
    const sku = generateSku();
    db.prepare(
      "INSERT INTO products (tenant_id, sku, name, unit, min_qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      getTenantId(req),
      sku.trim(),
      name.trim(),
      unit.trim(),
      Number(min_qty || 0),
      new Date().toISOString(),
      new Date().toISOString()
    );
    setFlash(req, "success", "เพิ่มสินค้าเรียบร้อย");
    return res.redirect("/products");
  } catch (error) {
    setFlash(req, "error", "ข้อมูลไม่ถูกต้อง");
    return res.redirect("/products/new");
  }
});

app.get("/products/:id/edit", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const product = db
    .prepare("SELECT * FROM products WHERE id = ? AND tenant_id = ?")
    .get(req.params.id, tenantId);

  if (!product) {
    return res.status(404).render("error", {
      title: "ไม่พบข้อมูล",
      message: "ไม่พบสินค้า"
    });
  }

  return res.render("products/form", {
    title: "แก้ไขสินค้า",
    product
  });
});

app.post("/products/:id/edit", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const { name, unit, min_qty } = req.body;
  if (!name || !unit) {
    setFlash(req, "error", "กรุณากรอกชื่อ และหน่วย");
    return res.redirect(`/products/${req.params.id}/edit`);
  }

  try {
    const result = db
      .prepare(
        "UPDATE products SET name = ?, unit = ?, min_qty = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
      )
      .run(
        name.trim(),
        unit.trim(),
        Number(min_qty || 0),
        new Date().toISOString(),
        req.params.id,
        tenantId
      );
    if (result.changes === 0) {
      setFlash(req, "error", "ไม่พบสินค้า");
      return res.redirect("/products");
    }
    setFlash(req, "success", "อัปเดตสินค้าเรียบร้อย");
    return res.redirect("/products");
  } catch (error) {
    setFlash(req, "error", "ข้อมูลไม่ถูกต้อง");
    return res.redirect(`/products/${req.params.id}/edit`);
  }
});

app.post("/products/:id/delete", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const movementCount = db
    .prepare("SELECT COUNT(*) AS count FROM stock_movements WHERE product_id = ? AND tenant_id = ?")
    .get(req.params.id, tenantId);

  if (movementCount.count > 0) {
    setFlash(req, "error", "ไม่สามารถลบสินค้าที่มีประวัติสต๊อกได้");
    return res.redirect("/products");
  }

  db.prepare("DELETE FROM products WHERE id = ? AND tenant_id = ?").run(req.params.id, tenantId);
  setFlash(req, "success", "ลบสินค้าเรียบร้อย");
  return res.redirect("/products");
});

app.get("/movements", requireLogin, requireSubscription, (req, res) => {
  const tenantId = getTenantId(req);
  const movements = db
    .prepare(
      `
        SELECT
          m.*, 
          p.name AS product_name,
          u.username AS created_by_name
        FROM stock_movements m
        JOIN products p ON p.id = m.product_id
        JOIN users u ON u.id = m.created_by
        WHERE m.tenant_id = ?
        ORDER BY m.created_at DESC
      `
    )
    .all(tenantId);

  res.render("movements/index", {
    title: "ประวัติสต๊อก",
    movements
  });
});

app.get("/movements/new", requireLogin, requireSubscription, (req, res) => {
  const tenantId = getTenantId(req);
  const products = db
    .prepare("SELECT id, name, unit FROM products WHERE tenant_id = ? ORDER BY name ASC")
    .all(tenantId);
  const selectedProductId = req.query.productId || "";

  res.render("movements/new", {
    title: "ทำรายการใหม่",
    products,
    selectedProductId
  });
});

app.post("/movements/new", requireLogin, requireSubscription, (req, res) => {
  const tenantId = getTenantId(req);
  const { product_id, type, qty, note } = req.body;
  const numericQty = Number(qty || 0);

  if (!product_id || !type || !qty) {
    setFlash(req, "error", "กรุณาเลือกสินค้า ประเภท และจำนวน");
    return res.redirect("/movements/new");
  }

  if (!Number.isFinite(numericQty) || numericQty <= 0) {
    setFlash(req, "error", "จำนวนต้องมากกว่า 0");
    return res.redirect("/movements/new");
  }

  const product = db
    .prepare("SELECT id, unit FROM products WHERE id = ? AND tenant_id = ?")
    .get(product_id, tenantId);
  if (!product) {
    setFlash(req, "error", "ไม่พบสินค้า");
    return res.redirect("/movements/new");
  }

  let finalQty = numericQty;

  if (type === "out") {
    const currentStock = getCurrentStock(product_id, tenantId);
    if (numericQty > currentStock) {
      setFlash(req, "error", "สต๊อกไม่พอสำหรับการจ่ายออก");
      return res.redirect(`/movements/new?productId=${product_id}`);
    }
  }

  if (type === "adjust") {
    const currentStock = getCurrentStock(product_id, tenantId);
    finalQty = numericQty - currentStock;
    if (finalQty === 0) {
      setFlash(req, "error", "ยอดคงเหลือไม่เปลี่ยนแปลง");
      return res.redirect(`/movements/new?productId=${product_id}`);
    }
  }

  db.prepare(
    "INSERT INTO stock_movements (tenant_id, product_id, type, qty, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    tenantId,
    product_id,
    type,
    finalQty,
    note ? note.trim() : null,
    req.session.user.id,
    new Date().toISOString()
  );

  setFlash(req, "success", "บันทึกรายการสต๊อกเรียบร้อย");
  return res.redirect("/movements");
});

app.get("/report", requireLogin, requireSubscription, (req, res) => {
  const products = getLowStockItems(getTenantId(req));
  res.render("report", {
    title: "รายงานสต๊อกต่ำ",
    products
  });
});

app.get("/export/products.csv", requireLogin, requireSubscription, (req, res) => {
  const products = getProductsWithStock(getTenantId(req));
  const rows = ["name,unit,min_qty,stock"];

  products.forEach((item) => {
    const values = [item.name, item.unit, item.min_qty, item.stock].map((value) => {
      const text = String(value ?? "");
      if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
        return `"${text.replace(/\"/g, '""')}"`;
      }
      return text;
    });
    rows.push(values.join(","));
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=products.csv");
  return res.send(rows.join("\n"));
});

app.get("/import", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  res.render("import", { title: "นำเข้าสินค้า" });
});

app.post("/import", requireLogin, requireSubscription, requireRole("admin"), upload.single("file"), (req, res) => {
  const tenantId = getTenantId(req);
  if (!req.file) {
    setFlash(req, "error", "กรุณาอัปโหลดไฟล์ CSV");
    return res.redirect("/import");
  }

  let records = [];
  try {
    records = parse(req.file.buffer.toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (error) {
    setFlash(req, "error", "รูปแบบ CSV ไม่ถูกต้อง");
    return res.redirect("/import");
  }

  let imported = 0;

  records.forEach((record) => {
    const skuRaw = String(record.sku || "").trim();
    const name = String(record.name || "").trim();
    const unit = String(record.unit || "").trim();
    const minQty = Number(record.min_qty || 0);

    if (!name || !unit) {
      return;
    }

    const sku = skuRaw || generateSku();
    const existing = skuRaw
      ? db.prepare("SELECT id FROM products WHERE sku = ? AND tenant_id = ?").get(skuRaw, tenantId)
      : null;

    if (existing) {
      db.prepare(
        "UPDATE products SET name = ?, unit = ?, min_qty = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
      ).run(
        name,
        unit,
        Number.isFinite(minQty) ? minQty : 0,
        new Date().toISOString(),
        existing.id,
        tenantId
      );
    } else {
      db.prepare(
        "INSERT INTO products (tenant_id, sku, name, unit, min_qty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(
        tenantId,
        sku,
        name,
        unit,
        Number.isFinite(minQty) ? minQty : 0,
        new Date().toISOString(),
        new Date().toISOString()
      );
    }

    imported += 1;
  });

  setFlash(req, "success", `นำเข้า ${imported} รายการเรียบร้อย`);
  return res.redirect("/products");
});

app.get("/users", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  const users = db
    .prepare("SELECT id, username, role, created_at FROM users WHERE tenant_id = ? ORDER BY username ASC")
    .all(getTenantId(req));
  res.render("users/index", {
    title: "ผู้ใช้",
    users
  });
});

app.get("/users/new", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  res.render("users/new", { title: "เพิ่มผู้ใช้" });
});

app.post("/users/new", requireLogin, requireSubscription, requireRole("admin"), (req, res) => {
  const tenantId = getTenantId(req);
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    setFlash(req, "error", "กรุณากรอกชื่อผู้ใช้ รหัสผ่าน และสิทธิ์");
    return res.redirect("/users/new");
  }

  try {
    const passwordHash = bcrypt.hashSync(password, 10);
    db.prepare(
      "INSERT INTO users (username, password_hash, role, tenant_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(username.trim(), passwordHash, role, tenantId, new Date().toISOString());
    setFlash(req, "success", "สร้างผู้ใช้เรียบร้อย");
    return res.redirect("/users");
  } catch (error) {
    setFlash(req, "error", "ชื่อผู้ใช้ซ้ำหรือข้อมูลไม่ถูกต้อง");
    return res.redirect("/users/new");
  }
});

app.use((req, res) => {
  res.status(404).render("error", {
    title: "ไม่พบหน้า",
    message: "ไม่พบหน้าที่คุณร้องขอ"
  });
});

// Start server (HTTP or HTTPS)
const startServer = () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  
  // Find local network IP
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }

  const useHTTPS = process.env.HTTPS === 'true';
  const protocol = useHTTPS ? 'https' : 'http';
  
  if (useHTTPS) {
    const https = require('https');
    const certPath = path.join(__dirname, 'cert.pfx');
    
    if (!fs.existsSync(certPath)) {
      console.error('\n❌ ไม่พบ certificate! รันคำสั่ง: npm run generate-cert\n');
      process.exit(1);
    }
    
    const options = {
      pfx: fs.readFileSync(certPath),
      passphrase: 'dev123'
    };
    
    https.createServer(options, app).listen(PORT, '0.0.0.0', () => {
      console.log('\n=== HTTPS Server running ===');
      console.log(`Local:   ${protocol}://localhost:${PORT}`);
      console.log(`Network: ${protocol}://${localIP}:${PORT}`);
      console.log('\nMobile: ' + protocol + '://' + localIP + ':' + PORT);
      console.log('Note: Click "Advanced" then "Proceed" when you see warning');
      console.log('(Must be on same Wi-Fi)\n');
    });
  } else {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('\n=== HTTP Server running ===');
      console.log(`Local:   ${protocol}://localhost:${PORT}`);
      console.log(`Network: ${protocol}://${localIP}:${PORT}`);
      console.log('\nMobile: ' + protocol + '://' + localIP + ':' + PORT);
      console.log('Note: Safari requires HTTPS for camera. Use Chrome/Edge or run: npm run start:https');
      console.log('(Must be on same Wi-Fi)\n');
    });
  }
};

startServer();
