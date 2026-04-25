require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN               = process.env.TELEGRAM_BOT_TOKEN || "8778259213:AAG8WzU7-SXj30wvXXPfRe2Db_017Yhl6_k";
const RAZORPAY_KEY_ID     = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

// ── Package Data ───────────────────────────────────────────────────────────
const PACKAGE_FEATURES = {
  Silver:   ["PPT Presentation", "2 Times Revision"],
  Gold:     ["Project Document", "2 Times Revision", "PPT Presentation", "No Revision on PPT"],
  Platinum: ["Project Document", "3 Times Revision", "PPT Presentation", "2 Times Revision on PPT"],
};
const PACKAGE_TOTAL     = { Silver: 299,  Gold: 499,  Platinum: 799  };
const PACKAGE_ADVANCE   = { Silver: 199,  Gold: 299,  Platinum: 399  };
const PACKAGE_REMAINING = { Silver: 100,  Gold: 200,  Platinum: 400  };

// ─── MongoDB ──────────────────────────────────────────────────────────────────
let db;
async function connectDB() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set");
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db("docupresent");
  console.log("✅ Bot: MongoDB connected");
  await db.collection("otps").createIndex({ createdAt: 1 }, { expireAfterSeconds: 600 });
}

// ─── Brevo Email ──────────────────────────────────────────────────────────────
async function sendMail({ to, subject, html, attachments = [] }) {
  const body = {
    sender: { name: "DocuPresent Solutions", email: process.env.BREVO_SENDER_EMAIL },
    to: [{ email: to }],
    subject,
    htmlContent: html,
  };
  if (attachments.length > 0) {
    body.attachment = attachments.map((a) => ({
      name: a.filename,
      content: Buffer.isBuffer(a.content)
        ? a.content.toString("base64")
        : Buffer.from(a.content).toString("base64"),
    }));
  }
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": process.env.BREVO_API_KEY },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Brevo: ${await response.text()}`);
  return await response.json();
}

// ─── Razorpay: Create Payment Link ────────────────────────────────────────────
async function createRazorpayLink({ orderId, name, email, mobile, amount, description }) {
  const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${credentials}` },
    body: JSON.stringify({
      amount: amount * 100,
      currency: "INR",
      description: description || `DocuPresent Payment`,
      customer: { name, email, contact: mobile },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { order_id: orderId },
      callback_url: "",
      callback_method: "get",
    }),
  });
  if (!response.ok) throw new Error(`Razorpay: ${await response.text()}`);
  const data = await response.json();
  return { shortUrl: data.short_url, linkId: data.id };
}

// ─── Razorpay: Fetch Payment Link Status ──────────────────────────────────────
async function getRazorpayLinkStatus(linkId) {
  const credentials = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetch(`https://api.razorpay.com/v1/payment_links/${linkId}`, {
    method: "GET",
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!response.ok) throw new Error(`Razorpay status check: ${await response.text()}`);
  return await response.json();
}

// ─── Orders File ──────────────────────────────────────────────────────────────
const ORDERS_FILE = path.join(__dirname, "orders.json");
function loadOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ORDERS_FILE, "utf8")); } catch { return []; }
}
function saveOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// ─── PDF Invoice ──────────────────────────────────────────────────────────────
async function generatePDF(order) {
  const pdfPath = path.join(__dirname, `invoice_${order.id}.pdf`);
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);

    doc.fontSize(24).fillColor("#6d28d9").text("DocuPresent Solutions", { align: "center" });
    doc.fontSize(12).fillColor("#444").text("Advance Payment Invoice", { align: "center" });
    doc.moveDown();
    doc.moveTo(50, doc.y).lineTo(550, doc.y).strokeColor("#6d28d9").stroke();
    doc.moveDown();

    [
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
      ["Source",        "Telegram Bot"],
    ].forEach(([label, val]) => {
      doc.fontSize(11).fillColor("#333").text(`${label}: `, { continued: true }).fillColor("#6d28d9").text(val);
    });

    doc.moveDown();
    doc.fontSize(13).fillColor("#333").text("Features Unlocked:");
    order.features.forEach((f) => doc.fontSize(11).fillColor("#555").text(`  - ${f}`));
    doc.moveDown(2);
    doc.fontSize(10).fillColor("#888").text("Thank you for choosing DocuPresent Solutions!", { align: "center" });
    doc.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  return pdfPath;
}

// ─── Session Store ────────────────────────────────────────────────────────────
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = { step: "start", data: {} };
  return sessions[chatId];
}

function resetSession(chatId) {
  const prev = sessions[chatId];
  const email = prev?.data?.email || null;
  sessions[chatId] = { step: "start", data: { email } };
}

// ─── OTP Helpers ──────────────────────────────────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendOTP(email) {
  const otp = generateOTP();
  await db.collection("otps").replaceOne(
    { email },
    { email, otp, createdAt: new Date() },
    { upsert: true }
  );
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
  return otp;
}

async function verifyOTP(email, otp) {
  const record = await db.collection("otps").findOne({ email });
  if (!record) return { ok: false, error: "No OTP found. Please request again." };
  if (record.otp !== otp) return { ok: false, error: "Incorrect OTP. Please try again." };
  await db.collection("otps").deleteOne({ email });
  return { ok: true };
}

// ─── Main Menu Keyboard ───────────────────────────────────────────────────────
const MAIN_MENU = {
  reply_markup: {
    keyboard: [
      [{ text: "📦 New Order" }],
      [{ text: "📋 Recent Orders" }],
      [{ text: "⏳ Pending Payments" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  },
};

// ─── Helper: show recent orders for an email ──────────────────────────────────
async function showRecentOrders(bot, chatId, email) {
  const orders = loadOrders().filter((o) => o.email === email);
  if (orders.length === 0) {
    await bot.sendMessage(chatId, "📭 No orders found for your account.", MAIN_MENU);
    return;
  }
  const last5 = orders.slice(-5).reverse();
  const msgs = last5.map((o, i) => {
    const advancePaid = o.advancePaid || o.amount || 0;
    const remaining   = o.remainingAmount || 0;
    const status      = o.remainingPaid ? "✅ Fully Paid" : `⏳ Remaining: ₹${remaining}`;
    return (
      `*${i + 1}. ${o.id}*\n` +
      `📦 ${o.package} | 💰 Advance: ₹${advancePaid}\n` +
      `📂 ${o.projectTitle}\n` +
      `🎓 ${o.collegeName}\n` +
      `📊 ${status}\n` +
      `📅 ${new Date(o.createdAt).toLocaleString("en-IN")}`
    );
  });
  await bot.sendMessage(
    chatId,
    `📋 *Your Recent Orders:*\n\n${msgs.join("\n\n")}`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
}

// ─── Helper: show pending payments for an email ───────────────────────────────
async function showPendingPayments(bot, chatId, email) {
  const pending = loadOrders().filter(
    (o) => o.email === email && !o.remainingPaid && (o.remainingAmount || 0) > 0
  );
  if (pending.length === 0) {
    await bot.sendMessage(chatId, "✅ No pending payments! All your orders are fully paid.", MAIN_MENU);
    return;
  }
  const msgs = pending.map((o, i) =>
    `*${i + 1}. ${o.id}*\n` +
    `📦 ${o.package}\n` +
    `📂 ${o.projectTitle}\n` +
    `💳 *Remaining Due: ₹${o.remainingAmount}*\n` +
    (o.remainingPaymentLink
      ? `🔗 Pay Now: ${o.remainingPaymentLink}`
      : `_(Payment link will be emailed to you)_`)
  );
  await bot.sendMessage(
    chatId,
    `⏳ *Your Pending Payments:*\n\n${msgs.join("\n\n")}\n\n` +
    `_Payment links are sent to your registered email automatically._`,
    { parse_mode: "Markdown", ...MAIN_MENU }
  );
}

// ─── Helper: Process confirmed order (after payment verified) ─────────────────
async function processConfirmedOrder(bot, chatId, session, paymentId) {
  session.step = "processing";
  await bot.sendMessage(chatId, "⏳ Processing your order...", { reply_markup: { remove_keyboard: true } });

  try {
    const order = {
      id:              session.data.tempOrderId || ("DP-" + Date.now()),
      name:            session.data.name,
      mobile:          session.data.mobile,
      projectTitle:    session.data.projectTitle,
      collegeName:     session.data.collegeName,
      package:         session.data.package,
      email:           session.data.email,
      paymentId:       paymentId,
      totalPrice:      session.data.totalPrice,
      advancePaid:     session.data.advancePaid,
      remainingAmount: session.data.remainingAmount,
      remainingPaid:   false,
      remainingPaymentId:   null,
      remainingPaymentLink: null,
      lastReminderSent: null,
      features:        PACKAGE_FEATURES[session.data.package],
      source:          "Telegram",
      createdAt:       new Date().toISOString(),
    };

    // Save to JSON
    const orders = loadOrders();
    orders.push(order);
    saveOrders(orders);

    // Save to MongoDB
    try {
      await db.collection("orders").insertOne({ ...order });
    } catch (err) {
      console.warn("MongoDB save warning:", err.message);
    }

    // ── Auto-generate remaining payment link ─────────────────────────────────
    let remainingPayLink = null;
    let remainingLinkId  = null;
    try {
      const result = await createRazorpayLink({
        orderId:     order.id,
        name:        order.name,
        email:       order.email,
        mobile:      order.mobile,
        amount:      order.remainingAmount,
        description: `DocuPresent - ${order.package} Remaining Payment`,
      });
      remainingPayLink = result.shortUrl;
      remainingLinkId  = result.linkId;

      const updatedOrders = loadOrders();
      const idx = updatedOrders.findIndex((o) => o.id === order.id);
      if (idx !== -1) {
        updatedOrders[idx].remainingPaymentLink = remainingPayLink;
        updatedOrders[idx].remainingPaymentLinkId = remainingLinkId;
        saveOrders(updatedOrders);
      }
      await db.collection("orders").updateOne(
        { id: order.id },
        { $set: { remainingPaymentLink: remainingPayLink, remainingPaymentLinkId: remainingLinkId } }
      ).catch(() => {});
      order.remainingPaymentLink   = remainingPayLink;
      order.remainingPaymentLinkId = remainingLinkId;
    } catch (err) {
      console.warn("⚠️ Remaining payment link failed:", err.message);
    }

    // ── Generate PDF Invoice ─────────────────────────────────────────────────
    const pdfPath   = await generatePDF(order);
    const pdfBuffer = fs.readFileSync(pdfPath);

    // ── Send invoice + remaining payment link to customer email ──────────────
    await sendMail({
      to: order.email,
      subject: `Order Confirmed - ${order.id} | ${order.package} Package`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#a78bfa;">Order Confirmed! 🎉</h2>
          <p style="color:#94a3b8;">Hi <strong>${order.name}</strong>, your order has been received via Telegram.</p>
          <div style="background:#1e1b4b;border-radius:12px;padding:20px;margin:20px 0;">
            <table style="width:100%;border-collapse:collapse;">
              ${[
                ["Order ID",      order.id],
                ["Package",       order.package],
                ["Total Price",   `Rs.${order.totalPrice}`],
                ["Advance Paid",  `Rs.${order.advancePaid}`],
                ["Remaining Due", `Rs.${order.remainingAmount}`],
                ["Project",       order.projectTitle],
                ["Payment ID",    order.paymentId],
              ].map(([k, v]) => `<tr><td style="padding:8px 0;color:#64748b;width:45%">${k}</td><td style="color:#e2e8f0;font-weight:600">${v}</td></tr>`).join("")}
            </table>
          </div>
          ${remainingPayLink ? `
          <a href="${remainingPayLink}" style="display:block;background:#7c3aed;color:#fff;text-align:center;padding:16px;border-radius:12px;text-decoration:none;font-size:16px;font-weight:700;margin:20px 0;">
            💳 Pay Remaining ₹${order.remainingAmount} Now
          </a>
          <p style="color:#64748b;font-size:12px;text-align:center;">Complete your remaining payment at your convenience to finalize the order.</p>
          ` : ""}
          <p style="color:#94a3b8;font-size:13px;">Advance invoice attached. Thank you for choosing DocuPresent Solutions.</p>
        </div>
      `,
      attachments: [{ filename: `Invoice_${order.id}.pdf`, content: pdfBuffer }],
    });

    // ── Admin email ──────────────────────────────────────────────────────────
    const adminEmail = process.env.ADMIN_EMAIL || "docupresentsolutions@gmail.com";
    await sendMail({
      to: adminEmail,
      subject: `New Telegram Order - ${order.id} | ${order.package} | ${order.name}`,
      html: `
        <div style="font-family:'Segoe UI',sans-serif;max-width:560px;margin:0 auto;background:#0f0f1a;color:#fff;border-radius:16px;padding:40px;">
          <h2 style="color:#a78bfa;">📦 New Telegram Order</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
            ${[
              ["Order ID", order.id], ["Customer", order.name], ["Email", order.email],
              ["Mobile", order.mobile], ["Project", order.projectTitle], ["College", order.collegeName],
              ["Package", order.package], ["Total", `Rs.${order.totalPrice}`],
              ["Advance Paid", `Rs.${order.advancePaid}`], ["Remaining Due", `Rs.${order.remainingAmount}`],
              ["Payment ID", order.paymentId], ["Source", "Telegram Bot"],
            ].map(([k, v]) => `<tr><td style="padding:9px 0;color:#64748b;width:38%;font-size:13px;border-bottom:1px solid #1e1b4b">${k}</td><td style="padding:9px 0;color:#e2e8f0;font-weight:600;font-size:13px;border-bottom:1px solid #1e1b4b">${v}</td></tr>`).join("")}
          </table>
        </div>
      `,
      attachments: [{ filename: `Invoice_${order.id}.pdf`, content: pdfBuffer }],
    }).catch(() => {});

    // ── Cleanup PDF ──────────────────────────────────────────────────────────
    fs.unlinkSync(pdfPath);

    // ── Confirmation message to user in bot ──────────────────────────────────
    const confirmMsg =
      `✅ *Order Confirmed!*\n\n` +
      `🆔 *Order ID:* \`${order.id}\`\n` +
      `👤 *Name:* ${order.name}\n` +
      `📦 *Package:* ${order.package}\n` +
      `💰 *Total:* ₹${order.totalPrice}\n` +
      `✅ *Advance Paid:* ₹${order.advancePaid}\n` +
      `⏳ *Remaining Due:* ₹${order.remainingAmount}\n` +
      `📂 *Project:* ${order.projectTitle}\n` +
      `🧾 *Payment ID:* \`${order.paymentId}\`\n\n` +
      `*Features Unlocked:*\n${PACKAGE_FEATURES[order.package].map((f) => `  ✅ ${f}`).join("\n")}\n\n` +
      `📧 *Invoice + Remaining Payment Link sent to ${order.email}*\n\n` +
      `Thank you for choosing DocuPresent Solutions! 🎉`;

    // Show remaining payment link as inline button if available
    if (remainingPayLink) {
      await bot.sendMessage(chatId, confirmMsg, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: `💳 Pay Remaining ₹${order.remainingAmount}`, url: remainingPayLink }
          ]],
        },
      });
    } else {
      await bot.sendMessage(chatId, confirmMsg, { parse_mode: "Markdown" });
    }

    // Show main menu
    await bot.sendMessage(chatId, "What would you like to do next?", MAIN_MENU);

    // Reset order fields but keep email
    sessions[chatId] = { step: "start", data: { email: order.email } };

  } catch (err) {
    console.error("Order processing error:", err.message);
    await bot.sendMessage(
      chatId,
      `❌ Something went wrong while processing your order.\n\nPlease contact support with your Payment ID: *${paymentId}*`,
      { parse_mode: "Markdown", ...MAIN_MENU }
    );
    sessions[chatId] = { step: "start", data: { email: session.data.email } };
  }
}

// ─── Bot Initialization ───────────────────────────────────────────────────────
async function startBot() {
  await connectDB();

  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("✅ Telegram Bot started (polling)");

  // ─── Callback Query Handler (inline buttons) ────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data || "";
    const session = getSession(chatId);

    // ── CHECK ADVANCE PAYMENT STATUS ─────────────────────────────────────────
    if (data.startsWith("check_advance:")) {
      const linkId = data.replace("check_advance:", "");
      await bot.answerCallbackQuery(query.id, { text: "Checking payment status..." });

      try {
        const linkData = await getRazorpayLinkStatus(linkId);
        const status   = linkData.status; // created | partially_paid | paid | cancelled | expired

        if (status === "paid") {
          // Payment confirmed — extract payment ID
          const payments   = linkData.payments || [];
          const lastPayment = payments[payments.length - 1];
          const paymentId  = lastPayment?.payment_id || `rzp_link_${linkId}`;

          // Edit original message to show confirmed
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id }
          ).catch(() => {});

          await bot.sendMessage(
            chatId,
            `✅ *Payment Confirmed!*\n\n🧾 *Payment ID:* \`${paymentId}\`\n\n⏳ Processing your order now...`,
            { parse_mode: "Markdown" }
          );

          // Process the order automatically
          await processConfirmedOrder(bot, chatId, session, paymentId);

        } else if (status === "partially_paid") {
          await bot.sendMessage(
            chatId,
            `⚠️ *Partial Payment Detected*\n\nYour payment is partially received. Please complete the full advance payment using the link.\n\n🔗 ${session.data.advancePaymentLink || "Check your payment link above."}`,
            { parse_mode: "Markdown" }
          );

        } else if (status === "cancelled" || status === "expired") {
          // Generate a fresh link
          await bot.sendMessage(chatId, "⏳ Your link expired. Generating a fresh payment link...");
          try {
            const result = await createRazorpayLink({
              orderId:     session.data.tempOrderId || ("DP-TMP-" + Date.now()),
              name:        session.data.name,
              email:       session.data.email,
              mobile:      session.data.mobile,
              amount:      session.data.advancePaid,
              description: `DocuPresent - ${session.data.package} Advance Payment`,
            });
            session.data.advancePaymentLink = result.shortUrl;
            session.data.advanceLinkId      = result.linkId;

            await bot.sendMessage(
              chatId,
              `🔗 *Fresh Payment Link:*\n\n${result.shortUrl}\n\n_After payment, click the button below to confirm._`,
              {
                parse_mode: "Markdown",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "🔍 Check Payment Status", callback_data: `check_advance:${result.linkId}` }],
                    [{ text: "✍️ Enter Payment ID Manually", callback_data: "enter_payment_id" }],
                  ],
                },
              }
            );
          } catch (err) {
            await bot.sendMessage(
              chatId,
              `❌ Could not generate a new link. Please paste your Payment ID manually or contact support.`,
              { parse_mode: "Markdown" }
            );
            session.step = "await_payment";
          }

        } else {
          // still pending (created)
          await bot.sendMessage(
            chatId,
            `⏳ *Payment Not Received Yet*\n\nPlease complete your payment using the link:\n\n🔗 ${session.data.advancePaymentLink || "See link above."}\n\n_Click "Check Payment Status" again after paying._`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔍 Check Payment Status", callback_data: `check_advance:${linkId}` }],
                  [{ text: "✍️ Enter Payment ID Manually", callback_data: "enter_payment_id" }],
                ],
              },
            }
          );
        }
      } catch (err) {
        console.error("Payment status check error:", err.message);
        await bot.sendMessage(
          chatId,
          `⚠️ *Could not check payment status.*\n\nIf you've already paid, please enter your Payment ID manually (e.g. \`pay_XXXXXXXXXXXXXXXXXX\`).\n\nOr try again:`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔍 Retry Check", callback_data: `check_advance:${linkId}` }],
                [{ text: "✍️ Enter Payment ID Manually", callback_data: "enter_payment_id" }],
              ],
            },
          }
        );
      }
      return;
    }

    // ── ENTER PAYMENT ID MANUALLY ─────────────────────────────────────────────
    if (data === "enter_payment_id") {
      await bot.answerCallbackQuery(query.id, { text: "Please type your Payment ID" });
      session.step = "await_payment";
      await bot.sendMessage(
        chatId,
        `✍️ *Enter your Payment ID*\n\n_(You can find it in the payment success screen or your email)_\n\nExample: \`pay_XXXXXXXXXXXXXXXXXX\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    await bot.answerCallbackQuery(query.id);
  });

  // ─── Message Handler ─────────────────────────────────────────────────────────
  bot.on("message", async (msg) => {
    const chatId  = msg.chat.id;
    const text    = (msg.text || "").trim();
    const session = getSession(chatId);

    // ─── /start or /cancel ───────────────────────────────────────────────────
    if (text === "/start" || text === "/cancel") {
      resetSession(chatId);
      const email = sessions[chatId]?.data?.email;
      await bot.sendMessage(
        chatId,
        `👋 Welcome to *DocuPresent Solutions!*\n\n` +
        (email ? `📧 Logged in as: *${email}*\n\n` : "") +
        `We help you with:\n📄 Project Documentation\n📊 PPT Presentations\n\n` +
        `Choose an option below:`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ─── /help ───────────────────────────────────────────────────────────────
    if (text === "/help") {
      await bot.sendMessage(
        chatId,
        `📖 *DocuPresent Bot Help*\n\n` +
        `• /start — Main menu\n` +
        `• /cancel — Cancel current action\n` +
        `• /help — This help message\n\n` +
        `*Menu Options:*\n` +
        `📦 *New Order* — Place a new project order\n` +
        `📋 *Recent Orders* — View your past orders\n` +
        `⏳ *Pending Payments* — See remaining payments due\n\n` +
        `For support: docupresentsolutions@gmail.com`,
        { parse_mode: "Markdown", ...MAIN_MENU }
      );
      return;
    }

    // ─── Main menu button: New Order ─────────────────────────────────────────
    if (text === "📦 New Order") {
      if (session.data.email) {
        session.step = "ask_name";
        session.data.pendingAction = null;
        await bot.sendMessage(
          chatId,
          `📦 *New Order*\n\n` +
          `📧 Using email: *${session.data.email}*\n\n` +
          `👤 Please enter your *Full Name:*`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else {
        session.step = "login_email";
        session.data.pendingAction = "order";
        await bot.sendMessage(
          chatId,
          `📦 *New Order*\n\nFirst, let's verify your identity.\n\n📧 Please enter your *Email Address:*`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      }
      return;
    }

    // ─── Main menu button: Recent Orders ─────────────────────────────────────
    if (text === "📋 Recent Orders") {
      if (session.data.email) {
        await showRecentOrders(bot, chatId, session.data.email);
      } else {
        session.step = "login_email";
        session.data.pendingAction = "orders";
        await bot.sendMessage(
          chatId,
          `📋 *Recent Orders*\n\nPlease login to view your orders.\n\n📧 Enter your *Email Address:*`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      }
      return;
    }

    // ─── Main menu button: Pending Payments ──────────────────────────────────
    if (text === "⏳ Pending Payments") {
      if (session.data.email) {
        await showPendingPayments(bot, chatId, session.data.email);
      } else {
        session.step = "login_email";
        session.data.pendingAction = "pending";
        await bot.sendMessage(
          chatId,
          `⏳ *Pending Payments*\n\nPlease login to view your pending payments.\n\n📧 Enter your *Email Address:*`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      }
      return;
    }

    // ─── LOGIN FLOW: Collect Email ────────────────────────────────────────────
    if (session.step === "login_email") {
      if (!text.includes("@") || !text.includes(".")) {
        await bot.sendMessage(chatId, "❌ Invalid email. Please enter a valid email address.");
        return;
      }
      session.data.loginEmail = text.toLowerCase().trim();
      session.step = "login_otp";
      await bot.sendMessage(chatId, `⏳ Sending OTP to *${session.data.loginEmail}*...`, { parse_mode: "Markdown" });
      try {
        await sendOTP(session.data.loginEmail);
        await bot.sendMessage(
          chatId,
          `✅ OTP sent to *${session.data.loginEmail}*\n\n🔢 Please enter the *6-digit OTP* from your email:`,
          { parse_mode: "Markdown" }
        );
      } catch (err) {
        console.error("OTP send error:", err.message);
        await bot.sendMessage(chatId, "❌ Failed to send OTP. Please try again with /start.");
        resetSession(chatId);
      }
      return;
    }

    // ─── LOGIN FLOW: Verify OTP ───────────────────────────────────────────────
    if (session.step === "login_otp") {
      if (!/^\d{6}$/.test(text)) {
        await bot.sendMessage(chatId, "❌ Please enter a valid 6-digit OTP.");
        return;
      }
      const result = await verifyOTP(session.data.loginEmail, text);
      if (!result.ok) {
        await bot.sendMessage(chatId, `❌ ${result.error}`);
        return;
      }

      session.data.email = session.data.loginEmail;
      delete session.data.loginEmail;

      const action = session.data.pendingAction;
      session.data.pendingAction = null;

      await bot.sendMessage(
        chatId,
        `✅ *Login Successful!*\n📧 Verified as: *${session.data.email}*`,
        { parse_mode: "Markdown" }
      );

      if (action === "order") {
        session.step = "ask_name";
        await bot.sendMessage(
          chatId,
          `📦 *New Order*\n\n👤 Please enter your *Full Name:*`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
      } else if (action === "orders") {
        session.step = "start";
        await showRecentOrders(bot, chatId, session.data.email);
      } else if (action === "pending") {
        session.step = "start";
        await showPendingPayments(bot, chatId, session.data.email);
      } else {
        session.step = "start";
        await bot.sendMessage(chatId, `What would you like to do?`, MAIN_MENU);
      }
      return;
    }

    // ─── ORDER FLOW: Step 1 — Name ────────────────────────────────────────────
    if (session.step === "ask_name") {
      if (text.length < 2) {
        await bot.sendMessage(chatId, "❌ Please enter a valid full name (at least 2 characters).");
        return;
      }
      session.data.name = text;
      session.step = "ask_mobile";
      await bot.sendMessage(chatId, `📱 Enter your *10-digit Mobile Number:*`, { parse_mode: "Markdown" });
      return;
    }

    // ─── ORDER FLOW: Step 2 — Mobile ──────────────────────────────────────────
    if (session.step === "ask_mobile") {
      if (!/^\d{10}$/.test(text)) {
        await bot.sendMessage(chatId, "❌ Invalid number. Please enter exactly 10 digits.");
        return;
      }
      session.data.mobile = text;
      session.step = "ask_project";
      await bot.sendMessage(chatId, `📂 Enter your *Project Title:*`, { parse_mode: "Markdown" });
      return;
    }

    // ─── ORDER FLOW: Step 3 — Project Title ───────────────────────────────────
    if (session.step === "ask_project") {
      if (text.length < 3) {
        await bot.sendMessage(chatId, "❌ Project title is too short. Please enter a valid title.");
        return;
      }
      session.data.projectTitle = text;
      session.step = "ask_college";
      await bot.sendMessage(chatId, `🎓 Enter your *College Name:*`, { parse_mode: "Markdown" });
      return;
    }

    // ─── ORDER FLOW: Step 4 — College Name ───────────────────────────────────
    if (session.step === "ask_college") {
      if (text.length < 3) {
        await bot.sendMessage(chatId, "❌ College name too short. Please enter a valid college name.");
        return;
      }
      session.data.collegeName = text;
      session.step = "ask_package";

      await bot.sendMessage(
        chatId,
        `📦 *Choose Your Package:*\n\n` +
        `🥈 *Silver — ₹${PACKAGE_TOTAL.Silver}* (Advance: ₹${PACKAGE_ADVANCE.Silver})\n` +
        `${PACKAGE_FEATURES.Silver.map((f) => `  ✅ ${f}`).join("\n")}\n\n` +
        `🥇 *Gold — ₹${PACKAGE_TOTAL.Gold}* (Advance: ₹${PACKAGE_ADVANCE.Gold})\n` +
        `${PACKAGE_FEATURES.Gold.map((f) => `  ✅ ${f}`).join("\n")}\n\n` +
        `💎 *Platinum — ₹${PACKAGE_TOTAL.Platinum}* (Advance: ₹${PACKAGE_ADVANCE.Platinum})\n` +
        `${PACKAGE_FEATURES.Platinum.map((f) => `  ✅ ${f}`).join("\n")}`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            keyboard: [
              [{ text: `🥈 Silver — Advance ₹${PACKAGE_ADVANCE.Silver}` }],
              [{ text: `🥇 Gold — Advance ₹${PACKAGE_ADVANCE.Gold}` }],
              [{ text: `💎 Platinum — Advance ₹${PACKAGE_ADVANCE.Platinum}` }],
            ],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      );
      return;
    }

    // ─── ORDER FLOW: Step 5 — Package Selection ───────────────────────────────
    if (session.step === "ask_package") {
      let pkg = null;
      if (text.includes("Silver"))        pkg = "Silver";
      else if (text.includes("Gold"))     pkg = "Gold";
      else if (text.includes("Platinum")) pkg = "Platinum";

      if (!pkg) {
        await bot.sendMessage(chatId, "❌ Please select a valid package using the buttons below.");
        return;
      }

      session.data.package         = pkg;
      session.data.advancePaid     = PACKAGE_ADVANCE[pkg];
      session.data.remainingAmount = PACKAGE_REMAINING[pkg];
      session.data.totalPrice      = PACKAGE_TOTAL[pkg];
      session.step = "await_payment";

      // Show order summary
      const summary =
        `📋 *Order Summary*\n\n` +
        `👤 *Name:* ${session.data.name}\n` +
        `📧 *Email:* ${session.data.email}\n` +
        `📱 *Mobile:* ${session.data.mobile}\n` +
        `🎓 *College:* ${session.data.collegeName}\n` +
        `📂 *Project:* ${session.data.projectTitle}\n` +
        `📦 *Package:* ${pkg}\n` +
        `💰 *Total:* ₹${PACKAGE_TOTAL[pkg]}\n` +
        `✅ *Advance to Pay:* ₹${PACKAGE_ADVANCE[pkg]}\n` +
        `⏳ *Remaining (later):* ₹${PACKAGE_REMAINING[pkg]}\n\n` +
        `*Features Included:*\n${PACKAGE_FEATURES[pkg].map((f) => `  ✅ ${f}`).join("\n")}`;

      await bot.sendMessage(chatId, summary, {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      });

      // Generate Razorpay advance payment link
      try {
        await bot.sendMessage(chatId, "⏳ Generating your advance payment link...");
        const tempOrderId = "DP-" + Date.now();
        session.data.tempOrderId = tempOrderId;

        const result = await createRazorpayLink({
          orderId:     tempOrderId,
          name:        session.data.name,
          email:       session.data.email,
          mobile:      session.data.mobile,
          amount:      PACKAGE_ADVANCE[pkg],
          description: `DocuPresent - ${pkg} Advance Payment`,
        });

        session.data.advancePaymentLink = result.shortUrl;
        session.data.advanceLinkId      = result.linkId;

        // ── KEY CHANGE: Show payment link + Check Payment Status button ──────
        await bot.sendMessage(
          chatId,
          `💳 *Pay Advance ₹${PACKAGE_ADVANCE[pkg]} using the link below:*\n\n` +
          `🔗 ${result.shortUrl}\n\n` +
          `_After paying, click the button below to confirm your payment automatically._\n` +
          `_Or enter your Payment ID manually if preferred._`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [{ text: "🔍 Check Payment Status", callback_data: `check_advance:${result.linkId}` }],
                [{ text: "✍️ Enter Payment ID Manually", callback_data: "enter_payment_id" }],
              ],
            },
          }
        );

      } catch (err) {
        console.error("Razorpay advance link error:", err.message);
        await bot.sendMessage(
          chatId,
          `⚠️ Could not auto-generate payment link.\n\n` +
          `Please pay ₹${PACKAGE_ADVANCE[pkg]} manually and paste your *Payment ID* here to confirm the order.`,
          { parse_mode: "Markdown" }
        );
      }
      return;
    }

    // ─── ORDER FLOW: Step 6 — Await Payment ID (manual fallback) ─────────────
    if (session.step === "await_payment") {
      if (text.length < 5) {
        await bot.sendMessage(
          chatId,
          `❌ Please enter a valid Payment ID.\n_(Example: pay_XXXXXXXXXXXXXXXXXX)_`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      const paymentId = text;
      await processConfirmedOrder(bot, chatId, session, paymentId);
      return;
    }

    // ─── Default: show main menu ──────────────────────────────────────────────
    await bot.sendMessage(
      chatId,
      `Please choose an option from the menu below, or type /start to begin.`,
      MAIN_MENU
    );
  });

  bot.on("polling_error", (err) => {
    console.error("❌ Bot polling error:", err.message);
  });
}

startBot().catch((err) => {
  console.error("❌ Bot failed to start:", err.message);
});
