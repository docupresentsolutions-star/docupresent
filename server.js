require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const Razorpay = require("razorpay");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db("docupresent");
  console.log("✅ MongoDB connected");
  await db.collection("otps").createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 });
}

// ─── Brevo HTTP API ───────────────────────────────────────────────────────────
async function sendMail({ to, subject, html, attachments = [] }, attempt = 1) {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL)
    throw new Error("BREVO_API_KEY or BREVO_SENDER_EMAIL missing.");
  const body = {
    sender: { name: "DocuPresent Solutions", email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };
  if (attachments.length > 0) {
    body.attachment = attachments.map((a) => ({
      name: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
    }));
  }
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": process.env.BREVO_API_KEY },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Brevo API ${response.status}: ${await response.text()}`);
    return await response.json();
  } catch (err) {
    if (attempt < 2) {
      await new Promise(r => setTimeout(r, 3000));
      return sendMail({ to, subject, html, attachments }, attempt + 1);
    }
    throw err;
  }
}

async function verifyMailer() {
  try {
    const response = await fetch("https://api.brevo.com/v3/account", {
      headers: { "api-key": process.env.BREVO_API_KEY },
    });
    if (!response.ok) throw new Error(`Status ${response.status}`);
    const data = await response.json();
    console.log(`✅ Brevo API ready — account: ${data.email}`);
  } catch (err) {
    console.error("❌ Brevo API check FAILED:", err.message);
  }
}

// ─── Telegram Webhook ────────────────────────────────────────────────────────
// NOTE: All user interactions are handled entirely by bot.js (polling).
// This webhook endpoint is kept as a no-op fallback only.
app.post("/telegram-webhook", async (req, res) => {
  res.sendStatus(200);
});

// ─── Razorpay ─────────────────────────────────────────────────────────────────
function getRazorpay() {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET)
    throw new Error("Razorpay keys not set");
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

async function createRazorpayPaymentLink({ orderId, name, email, mobile, amount, description }) {
  const razorpay = getRazorpay();
  const link = await razorpay.paymentLink.create({
    amount: amount * 100,
    currency: "INR",
    description,
    customer: { name, email, contact: mobile },
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { order_id: orderId },
    callback_url: `${process.env.APP_URL || "https://docupresent.onrender.com"}/payment-success?orderId=${orderId}&type=remaining`,
    callback_method: "get",
  });
  return link.short_url;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ORDERS_FILE = path.join(__dirname, "orders.json");

const PACKAGE_FEATURES = {
  Silver:   ["PPT Presentation", "2 Times Revision"],
  Gold:     ["Project Document", "2 Times Revision", "PPT Presentation", "No Revision on PPT"],
  Platinum: ["Project Document", "3 Times Revision", "PPT Presentation", "2 Times Revision on PPT"],
};
const PACKAGE_TOTAL     = { Silver: 299, Gold: 499, Platinum: 799 };
const PACKAGE_ADVANCE   = { Silver: 199, Gold: 299, Platinum: 399 };
const PACKAGE_REMAINING = { Silver: 100, Gold: 200, Platinum: 400 };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── PDF Generator ────────────────────────────────────────────────────────────
async function generatePDF(order, type = "advance") {
  const pdfPath = path.join(__dirname, `invoice_${order.id}_${type}.pdf`);
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    doc.fontSize(24).fillColor("#6d28d9").text("DocuPresent Solutions", { align: "center" });
    doc.fontSize(12).fillColor("#444").text(
      type === "remaining" ? "Full Payment Receipt" : "Advance Payment Invoice",
      { align: "center" }
    );
    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor("#6d28d9").stroke();
    doc.moveDown();
    const fields = type === "remaining"
      ? [
          ["Order ID",       order.id],
          ["Date",           new Date().toLocaleString("en-IN")],
          ["Name",           order.name],
          ["Email",          order.email],
          ["Package",        order.package],
          ["Total Price",    `Rs.${order.totalPrice}`],
          ["Advance Paid",   `Rs.${order.advancePaid}`],
          ["Remaining Paid", `Rs.${order.remainingAmount}`],
          ["Payment ID",     order.remainingPaymentId || "N/A"],
          ["Status",         "FULLY PAID"],
        ]
      : [
          ["Order ID",      order.id],
          ["Date",          new Date(order.createdAt).toLocaleString("en-IN")],
          ["Name",          order.name],
          ["Mobile",        order.mobile],
          ["Email",         order.email],
          ["Project Title", order.projectTitle],
          ["College",       order.collegeName],
          ["Package",       order.package],
          ["Total Price",   `Rs.${order.totalPrice}`],
          ["Advance Paid",  `Rs.${order.advancePaid}`],
          ["Remaining Due", `Rs.${order.remainingAmount}`],
          ["Payment ID",    order.paymentId],
        ];
    fields.forEach(([label, val]) => {
      doc.fontSize(11).fillColor("#333").text(`${label}: `, { continued: true }).fillColor("#6d28d9").text(val);
    });
    doc.moveDown();
    doc.fontSize(13).fillColor("#333").text("Features Unlocked:");
    order.features.forEach(f => doc.fontSize(11).fillColor("#555").text(`  - ${f}`));
    doc.moveDown(2);
    doc.fontSize(10).fillColor("#888").text("Thank you for choosing DocuPresent Solutions!", { align: "center" });
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return pdfPath;
}

// ─── 2-Hour Reminder Scheduler ────────────────────────────────────────────────
async function sendRemainingReminder(order) {
  try {
    const payLink = await createRazorpayPaymentLink({
      orderId: order.id,
      name: order.name,
      email: order.email,
      mobile: order.mobile,
      amount: order.remainingAmount,
      description: `DocuPresent - ${order.package} Remaining Payment`,
    });
    // Update stored link
    const orders = loadOrders();
    const idx = orders.findIndex(o => o.id === order.id);
    if (idx !== -1) {
      orders[idx].remainingPaymentLink = payLink;
      orders[idx].lastReminderSent = new Date().toISOString();
      saveOrders(orders);
    }
    try {
      await db.collection("orders").updateOne(
        { id: order.id },
        { $set: { remainingPaymentLink: payLink, lastReminderSent: new Date().toISOString() } }
      );
    } catch {}

    await sendMail({
      to: order.email,
      subject: `⏰ Payment Reminder – Complete Your Order ${order.id}`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#a78bfa;">Payment Reminder 🔔</h2>
          <p style="color:#94a3b8;">Hi <strong>${order.name}</strong>, you have a pending payment for your DocuPresent order.</p>
          <div style="background:#1e1b4b;border-radius:12px;padding:20px;margin:20px 0;">
            <table style="width:100%;border-collapse:collapse;">
              ${[
                ["Order ID",      order.id],
                ["Package",       order.package],
                ["Advance Paid",  `Rs.${order.advancePaid}`],
                ["Remaining Due", `Rs.${order.remainingAmount}`],
                ["Project",       order.projectTitle],
              ].map(([k, v]) => `<tr><td style="padding:8px 0;color:#64748b;width:45%">${k}</td><td style="color:#e2e8f0;font-weight:600">${v}</td></tr>`).join("")}
            </table>
          </div>
          <a href="${payLink}" style="display:block;background:#7c3aed;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700;margin:20px 0;">
            💳 Pay Remaining ₹${order.remainingAmount} Now
          </a>
          <p style="color:#64748b;font-size:12px;text-align:center;">Secure payment via Razorpay. This reminder is sent every 2 hours until payment is complete.</p>
          <p style="color:#475569;font-size:11px;text-align:center;margin-top:16px;">DocuPresent Solutions — docupresentsolutions@gmail.com</p>
        </div>
      `,
    });
    console.log(`✅ Reminder sent to ${order.email} for ${order.id}`);
  } catch (err) {
    console.error(`❌ Reminder failed for ${order.id}:`, err.message);
  }
}

function startReminderScheduler() {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  setInterval(async () => {
    console.log("🔔 Running 2-hour reminder check...");
    const pending = loadOrders().filter(o => !o.remainingPaid && o.remainingAmount > 0);
    for (const order of pending) {
      await sendRemainingReminder(order);
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`✅ Reminders done — ${pending.length} sent`);
  }, TWO_HOURS);
  console.log("✅ 2-hour reminder scheduler started");
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /send-otp
app.post("/send-otp", async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes("@")) return res.status(400).json({ error: "Invalid email" });
  const otp = generateOTP();
  try {
    await db.collection("otps").replaceOne({ email }, { email, otp, createdAt: new Date() }, { upsert: true });
    await sendMail({
      to: email,
      subject: "Your DocuPresent OTP Code",
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:480px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#a78bfa;">DocuPresent Solutions</h2>
          <p style="color:#94a3b8;font-size:14px;margin-bottom:32px;">Your one-time login code</p>
          <div style="background:#1e1b4b;border:1px solid #4c1d95;border-radius:12px;padding:32px;text-align:center;">
            <p style="color:#94a3b8;font-size:13px;margin-bottom:12px;letter-spacing:2px;">ONE-TIME PASSWORD</p>
            <div style="font-size:42px;font-weight:700;letter-spacing:10px;color:#a78bfa;">${otp}</div>
          </div>
          <p style="color:#64748b;font-size:12px;margin-top:24px;text-align:center;">Valid for 10 minutes. Do not share this code.</p>
        </div>
      `,
    });
    res.json({ success: true, message: "OTP sent to " + email });
  } catch (err) {
    res.status(500).json({ error: "Failed to send OTP", details: err.message });
  }
});

// POST /verify-otp
app.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  try {
    const record = await db.collection("otps").findOne({ email });
    if (!record) return res.status(400).json({ error: "No OTP requested for this email." });
    if (record.otp !== otp) return res.status(400).json({ error: "Incorrect OTP." });
    await db.collection("otps").deleteOne({ email });
    res.json({ success: true, message: "Login successful" });
  } catch (err) {
    res.status(500).json({ error: "Verification failed", details: err.message });
  }
});

// POST /create-order (Razorpay advance)
app.post("/create-order", async (req, res) => {
  const { amount, currency = "INR", receipt } = req.body;
  if (!amount) return res.status(400).json({ error: "Amount required" });
  try {
    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: amount * 100, currency,
      receipt: receipt || "rcpt_" + Date.now(),
    });
    res.json({ success: true, order, key: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    res.status(500).json({ error: "Payment gateway error.", details: err.message });
  }
});

// POST /order — save order + send emails + schedule reminders
app.post("/order", async (req, res) => {
  const { name, mobile, projectTitle, collegeName, package: pkg, email, paymentId } = req.body;
  if (!name || !mobile || !projectTitle || !collegeName || !pkg || !email)
    return res.status(400).json({ error: "All fields are required." });

  const order = {
    id: "DP-" + Date.now(),
    name, mobile, projectTitle, collegeName,
    package: pkg, email,
    paymentId: paymentId || "N/A",
    totalPrice:       PACKAGE_TOTAL[pkg],
    advancePaid:      PACKAGE_ADVANCE[pkg],
    remainingAmount:  PACKAGE_REMAINING[pkg],
    remainingPaid:    false,
    remainingPaymentId:   null,
    remainingPaymentLink: null,
    lastReminderSent: null,
    features:    PACKAGE_FEATURES[pkg],
    createdAt:   new Date().toISOString(),
  };

  const orders = loadOrders();
  orders.push(order);
  saveOrders(orders);

  try { await db.collection("orders").insertOne({ ...order }); }
  catch (err) { console.warn("⚠️  MongoDB save failed:", err.message); }

  // Generate remaining payment link
  try {
    const payLink = await createRazorpayPaymentLink({
      orderId: order.id, name: order.name, email: order.email,
      mobile: order.mobile, amount: order.remainingAmount,
      description: `DocuPresent - ${order.package} Remaining Payment`,
    });
    order.remainingPaymentLink = payLink;
    const idx = orders.findIndex(o => o.id === order.id);
    if (idx !== -1) { orders[idx].remainingPaymentLink = payLink; saveOrders(orders); }
    await db.collection("orders").updateOne({ id: order.id }, { $set: { remainingPaymentLink: payLink } }).catch(() => {});
  } catch (err) {
    console.warn("⚠️  Remaining payment link failed:", err.message);
  }

  // Generate PDF
  const pdfPath = await generatePDF(order, "advance");

  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const adminEmail = process.env.ADMIN_EMAIL || "docupresentsolutions@gmail.com";

    // Customer email
    await sendMail({
      to: email,
      subject: `Order Confirmed - ${order.id} | ${pkg} Package`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#a78bfa;">Order Confirmed! 🎉</h2>
          <p style="color:#94a3b8;">Hi <strong>${name}</strong>, your order has been received.</p>
          <div style="background:#1e1b4b;border-radius:12px;padding:20px;margin:20px 0;">
            <table style="width:100%;border-collapse:collapse;">
              ${[
                ["Order ID",      order.id],
                ["Package",       pkg],
                ["Total Price",   `Rs.${order.totalPrice}`],
                ["Advance Paid",  `Rs.${order.advancePaid}`],
                ["Remaining Due", `Rs.${order.remainingAmount}`],
                ["Project",       projectTitle],
              ].map(([k, v]) => `<tr><td style="padding:8px 0;color:#64748b;width:45%">${k}</td><td style="color:#e2e8f0;font-weight:600">${v}</td></tr>`).join("")}
            </table>
          </div>
          ${order.remainingPaymentLink ? `
          <a href="${order.remainingPaymentLink}" style="display:block;background:#7c3aed;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700;margin:20px 0;">
            💳 Pay Remaining ₹${order.remainingAmount}
          </a>` : ""}
          <p style="color:#94a3b8;font-size:13px;">Advance invoice attached. Complete your remaining payment to proceed with your order.</p>
        </div>
      `,
      attachments: [{ filename: `Invoice_${order.id}.pdf`, content: pdfBuffer }],
    });

    // Admin email
    await sendMail({
      to: adminEmail,
      subject: `New Order - ${order.id} | ${pkg} | ${name}`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#a78bfa;">📦 New Order Received</h2>
          <p style="color:#64748b;font-size:13px;margin-bottom:28px;">${new Date(order.createdAt).toLocaleString("en-IN")}</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            ${[
              ["Order ID", order.id], ["Customer", name], ["Email", email],
              ["Mobile", order.mobile], ["Project", projectTitle], ["College", collegeName],
              ["Package", pkg], ["Total Price", `Rs.${order.totalPrice}`],
              ["Advance Paid", `Rs.${order.advancePaid}`],
              ["Remaining Due", `Rs.${order.remainingAmount}`],
              ["Payment ID", order.paymentId],
            ].map(([k, v]) => `<tr><td style="padding:9px 0;color:#64748b;width:38%;font-size:13px;border-bottom:1px solid #1e1b4b">${k}</td><td style="padding:9px 0;color:#e2e8f0;font-weight:600;font-size:13px;border-bottom:1px solid #1e1b4b">${v}</td></tr>`).join("")}
          </table>
          <div style="background:#1e1b4b;border-radius:12px;padding:16px 20px;">
            <p style="color:#a78bfa;font-size:12px;margin-bottom:10px;">Features Included</p>
            ${order.features.map(f => `<p style="color:#94a3b8;font-size:13px;margin:4px 0;">- ${f}</p>`).join("")}
          </div>
        </div>
      `,
      attachments: [{ filename: `Invoice_${order.id}.pdf`, content: pdfBuffer }],
    });

    fs.unlinkSync(pdfPath);
  } catch (err) {
    console.error("❌ Order email error:", err.message);
  }

  res.json({ success: true, order });
});

// GET /pending-payments?email= — for website Pending Payments dropdown
app.get("/pending-payments", (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email required" });
  const orders = loadOrders().filter(o => o.email === email && !o.remainingPaid && o.remainingAmount > 0);
  res.json({ orders });
});

// GET /create-remaining-link?orderId= — generate fresh Razorpay link
app.get("/create-remaining-link", async (req, res) => {
  const { orderId } = req.query;
  if (!orderId) return res.status(400).json({ error: "orderId required" });
  const order = loadOrders().find(o => o.id === orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.remainingPaid) return res.status(400).json({ error: "Already paid" });
  try {
    const paymentLink = await createRazorpayPaymentLink({
      orderId: order.id, name: order.name, email: order.email,
      mobile: order.mobile, amount: order.remainingAmount,
      description: `DocuPresent - ${order.package} Remaining Payment`,
    });
    res.json({ success: true, paymentLink, order });
  } catch (err) {
    res.status(500).json({ error: "Could not create payment link", details: err.message });
  }
});

// POST /complete-remaining — after remaining payment success on website
app.post("/complete-remaining", async (req, res) => {
  const { orderId, paymentId } = req.body;
  if (!orderId || !paymentId) return res.status(400).json({ error: "orderId and paymentId required" });
  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === orderId);
  if (idx === -1) return res.status(404).json({ error: "Order not found" });
  if (orders[idx].remainingPaid) return res.status(400).json({ error: "Already paid" });

  orders[idx].remainingPaid = true;
  orders[idx].remainingPaymentId = paymentId;
  orders[idx].remainingPaidAt = new Date().toISOString();
  saveOrders(orders);
  const order = orders[idx];

  try {
    await db.collection("orders").updateOne(
      { id: orderId },
      { $set: { remainingPaid: true, remainingPaymentId: paymentId, remainingPaidAt: order.remainingPaidAt } }
    );
  } catch {}

  const pdfPath = await generatePDF(order, "remaining");
  try {
    const pdfBuffer = fs.readFileSync(pdfPath);
    const adminEmail = process.env.ADMIN_EMAIL || "docupresentsolutions@gmail.com";

    // Customer full payment confirmation
    await sendMail({
      to: order.email,
      subject: `✅ Payment Complete - ${order.id} | Fully Paid`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#22c55e;">Payment Complete! ✅</h2>
          <p style="color:#94a3b8;">Hi <strong>${order.name}</strong>, your full payment has been received. Your order is now fully confirmed!</p>
          <div style="background:#1e1b4b;border-radius:12px;padding:20px;margin:20px 0;">
            <table style="width:100%;border-collapse:collapse;">
              ${[
                ["Order ID",        order.id],
                ["Package",         order.package],
                ["Total Paid",      `Rs.${order.totalPrice}`],
                ["Advance",         `Rs.${order.advancePaid}`],
                ["Remaining Paid",  `Rs.${order.remainingAmount}`],
                ["Final Payment ID", paymentId],
                ["Status",          "FULLY PAID ✅"],
              ].map(([k, v]) => `<tr><td style="padding:8px 0;color:#64748b;width:45%">${k}</td><td style="color:#e2e8f0;font-weight:600">${v}</td></tr>`).join("")}
            </table>
          </div>
          <p style="color:#94a3b8;font-size:13px;">Final receipt attached. Thank you for choosing DocuPresent Solutions!</p>
        </div>
      `,
      attachments: [{ filename: `Receipt_${order.id}_FullPayment.pdf`, content: pdfBuffer }],
    });

    // Admin notification
    await sendMail({
      to: adminEmail,
      subject: `✅ Remaining Payment Received - ${order.id} | ${order.name}`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#22c55e;">💰 Remaining Payment Received!</h2>
          <p style="color:#64748b;font-size:13px;margin-bottom:24px;">${new Date().toLocaleString("en-IN")}</p>
          <table style="width:100%;border-collapse:collapse;">
            ${[
              ["Order ID",       order.id],    ["Customer",       order.name],
              ["Email",          order.email], ["Package",        order.package],
              ["Total Price",    `Rs.${order.totalPrice}`],
              ["Advance Paid",   `Rs.${order.advancePaid}`],
              ["Remaining Paid", `Rs.${order.remainingAmount}`],
              ["Payment ID",     paymentId],   ["Status", "FULLY PAID ✅"],
            ].map(([k, v]) => `<tr><td style="padding:9px 0;color:#64748b;width:38%;font-size:13px;border-bottom:1px solid #1e1b4b">${k}</td><td style="padding:9px 0;color:#e2e8f0;font-weight:600;font-size:13px;border-bottom:1px solid #1e1b4b">${v}</td></tr>`).join("")}
          </table>
        </div>
      `,
      attachments: [{ filename: `Receipt_${order.id}_FullPayment.pdf`, content: pdfBuffer }],
    });

    fs.unlinkSync(pdfPath);
  } catch (err) {
    console.error("❌ Remaining payment email error:", err.message);
  }

  res.json({ success: true, order });
});

// GET /payment-success — Razorpay callback after remaining payment via payment link
// Razorpay redirects here with ?orderId=DP-xxx&type=remaining&razorpay_payment_id=pay_xxx
app.get("/payment-success", async (req, res) => {
  const { orderId, type, razorpay_payment_id, razorpay_payment_link_status } = req.query;

  if (type !== "remaining" || !orderId) {
    return res.redirect("/?payment=unknown");
  }

  const paymentId = razorpay_payment_id || req.query.payment_id || null;
  const status    = razorpay_payment_link_status || "paid";

  if (status === "cancelled" || status === "failed") {
    return res.redirect(`/?payment=failed&orderId=${orderId}`);
  }

  const orders = loadOrders();
  const idx = orders.findIndex(o => o.id === orderId);

  if (idx === -1) {
    return res.redirect("/?payment=notfound");
  }

  if (orders[idx].remainingPaid) {
    return res.redirect(`/?payment=already_paid&orderId=${orderId}`);
  }

  orders[idx].remainingPaid      = true;
  orders[idx].remainingPaymentId = paymentId || "razorpay_link_paid";
  orders[idx].remainingPaidAt    = new Date().toISOString();
  saveOrders(orders);
  const order = orders[idx];

  try {
    await db.collection("orders").updateOne(
      { id: orderId },
      { $set: {
          remainingPaid:      true,
          remainingPaymentId: order.remainingPaymentId,
          remainingPaidAt:    order.remainingPaidAt,
      }}
    );
  } catch {}

  // Send emails in background (don't block redirect)
  (async () => {
    try {
      const pdfPath = await generatePDF(order, "remaining");
      const pdfBuffer = fs.readFileSync(pdfPath);
      const adminEmail = process.env.ADMIN_EMAIL || "docupresentsolutions@gmail.com";

      await sendMail({
        to: order.email,
        subject: `✅ Payment Complete - ${order.id} | Fully Paid`,
        html: `
          <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
            <h2 style="color:#22c55e;">Payment Complete! ✅</h2>
            <p style="color:#94a3b8;">Hi <strong>${order.name}</strong>, your full payment has been received. Your order is now fully confirmed!</p>
            <div style="background:#1e1b4b;border-radius:12px;padding:20px;margin:20px 0;">
              <table style="width:100%;border-collapse:collapse;">
                ${[
                  ["Order ID",        order.id],
                  ["Package",         order.package],
                  ["Total Paid",      `Rs.${order.totalPrice}`],
                  ["Advance",         `Rs.${order.advancePaid}`],
                  ["Remaining Paid",  `Rs.${order.remainingAmount}`],
                  ["Payment ID",      order.remainingPaymentId],
                  ["Status",          "FULLY PAID ✅"],
                ].map(([k, v]) => `<tr><td style="padding:8px 0;color:#64748b;width:45%">${k}</td><td style="color:#e2e8f0;font-weight:600">${v}</td></tr>`).join("")}
              </table>
            </div>
            <p style="color:#94a3b8;font-size:13px;">Final receipt attached. Thank you for choosing DocuPresent Solutions!</p>
          </div>
        `,
        attachments: [{ filename: `Receipt_${order.id}_FullPayment.pdf`, content: pdfBuffer }],
      });

      await sendMail({
        to: adminEmail,
        subject: `✅ Remaining Payment Received - ${order.id} | ${order.name}`,
        html: `
          <div style="font-family:'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
            <h2 style="color:#22c55e;">💰 Remaining Payment Received!</h2>
            <table style="width:100%;border-collapse:collapse;">
              ${[
                ["Order ID", order.id], ["Customer", order.name],
                ["Email", order.email], ["Package", order.package],
                ["Total Price", `Rs.${order.totalPrice}`],
                ["Advance Paid", `Rs.${order.advancePaid}`],
                ["Remaining Paid", `Rs.${order.remainingAmount}`],
                ["Payment ID", order.remainingPaymentId], ["Status", "FULLY PAID ✅"],
              ].map(([k, v]) => `<tr><td style="padding:9px 0;color:#64748b;width:38%;font-size:13px;border-bottom:1px solid #1e1b4b">${k}</td><td style="padding:9px 0;color:#e2e8f0;font-weight:600;font-size:13px;border-bottom:1px solid #1e1b4b">${v}</td></tr>`).join("")}
            </table>
          </div>
        `,
        attachments: [{ filename: `Receipt_${order.id}_FullPayment.pdf`, content: pdfBuffer }],
      });

      fs.unlinkSync(pdfPath);
    } catch (err) {
      console.error("❌ payment-success background email error:", err.message);
    }
  })();

  // Redirect back to website — same tab, pending payments section
  return res.redirect(`/?payment=success&orderId=${orderId}#pending`);
});

// GET /recent?email=
app.get("/recent", (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email required" });
  res.json({ orders: loadOrders().filter(o => o.email === email) });
});

// GET /dashboard
app.get("/dashboard", (req, res) => res.json({ orders: loadOrders() }));

// GET /package-prices — frontend uses this
app.get("/package-prices", (req, res) => {
  res.json({ PACKAGE_TOTAL, PACKAGE_ADVANCE, PACKAGE_REMAINING, PACKAGE_FEATURES });
});

// Fallback SPA
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
connectDB()
  .then(async () => {
    await verifyMailer();
    startReminderScheduler();
    app.listen(PORT, () => console.log(`✅ DocuPresent running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("❌ Failed to connect to MongoDB:", err.message);
    process.exit(1);
  });
