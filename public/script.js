// ─── State ────────────────────────────────────────────────────────────────────
let state = {
  email: null,
  packages: null,      // loaded from /package-prices
  selectedPkg: null,
};

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", async () => {
  const savedEmail = sessionStorage.getItem("dp_email");
  if (savedEmail) {
    state.email = savedEmail;
    showDashboard();
  } else {
    showLoginPage();
  }
  await loadPackagePrices();
});

// ─── Page Transitions ─────────────────────────────────────────────────────────
function showLoginPage() {
  document.getElementById("login-page").classList.add("active");
  document.getElementById("dashboard-page").classList.remove("active");
}

function showDashboard() {
  document.getElementById("login-page").classList.remove("active");
  document.getElementById("dashboard-page").classList.add("active");
  document.getElementById("user-email-display").textContent = state.email;
  showHome();
}

function showHome() {
  hideAllSections();
  document.getElementById("home-menu").style.display = "block";
}

function hideAllSections() {
  document.getElementById("home-menu").style.display = "none";
  document.querySelectorAll(".section").forEach((s) => (s.style.display = "none"));
}

function showSection(name) {
  hideAllSections();
  const el = document.getElementById("section-" + name);
  if (el) el.style.display = "block";

  if (name === "recent-orders")   loadRecentOrders();
  if (name === "pending-payments") loadPendingPayments();
  if (name === "new-order")        initNewOrderForm();
}

// ─── Package Prices ───────────────────────────────────────────────────────────
async function loadPackagePrices() {
  try {
    const res = await fetch("/package-prices");
    const data = await res.json();
    state.packages = data;
  } catch {
    state.packages = {
      PACKAGE_TOTAL:     { Silver: 299,  Gold: 499,  Platinum: 799  },
      PACKAGE_ADVANCE:   { Silver: 199,  Gold: 299,  Platinum: 399  },
      PACKAGE_REMAINING: { Silver: 100,  Gold: 200,  Platinum: 400  },
      PACKAGE_FEATURES: {
        Silver:   ["PPT Presentation", "2 Times Revision"],
        Gold:     ["Project Document", "2 Times Revision", "PPT Presentation", "No Revision on PPT"],
        Platinum: ["Project Document", "3 Times Revision", "PPT Presentation", "2 Times Revision on PPT"],
      },
    };
  }
}

// ─── LOGIN FLOW ───────────────────────────────────────────────────────────────
function setLoading(btnId, loading, text) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.textContent = loading ? "Please wait…" : text;
}

async function sendOTP() {
  const email = document.getElementById("login-email").value.trim();
  const errEl = document.getElementById("email-error");
  errEl.textContent = "";

  if (!email || !email.includes("@")) {
    errEl.textContent = "Please enter a valid email address.";
    return;
  }

  setLoading("send-otp-btn", true, "Send OTP →");
  try {
    const res = await fetch("/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to send OTP");

    // Show OTP step
    document.getElementById("email-step").style.display = "none";
    document.getElementById("otp-step").style.display = "block";
    document.getElementById("otp-email-display").textContent = email;
    document.getElementById("login-otp").focus();
    state._pendingEmail = email;
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    setLoading("send-otp-btn", false, "Send OTP →");
  }
}

function backToEmail() {
  document.getElementById("otp-step").style.display = "none";
  document.getElementById("email-step").style.display = "block";
  document.getElementById("otp-error").textContent = "";
  document.getElementById("login-otp").value = "";
}

async function resendOTP() {
  const email = state._pendingEmail || document.getElementById("login-email").value.trim();
  if (!email) return;
  try {
    await fetch("/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    document.getElementById("otp-error").textContent = "OTP resent! Check your email.";
    document.getElementById("otp-error").style.color = "#22c55e";
    setTimeout(() => {
      document.getElementById("otp-error").textContent = "";
      document.getElementById("otp-error").style.color = "";
    }, 3000);
  } catch {}
}

async function verifyOTP() {
  const otp    = document.getElementById("login-otp").value.trim();
  const email  = state._pendingEmail;
  const errEl  = document.getElementById("otp-error");
  errEl.textContent = "";

  if (!otp || otp.length !== 6) {
    errEl.textContent = "Please enter the 6-digit OTP.";
    return;
  }

  setLoading("verify-otp-btn", true, "Verify & Login →");
  try {
    const res = await fetch("/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, otp }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Verification failed");

    state.email = email;
    sessionStorage.setItem("dp_email", email);
    showDashboard();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    setLoading("verify-otp-btn", false, "Verify & Login →");
  }
}

// Enter key support for login inputs
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const step = document.getElementById("otp-step");
    if (step && step.style.display !== "none") verifyOTP();
    else sendOTP();
  }
});

function logout() {
  state.email = null;
  sessionStorage.removeItem("dp_email");
  // Reset login form
  document.getElementById("login-email").value = "";
  document.getElementById("login-otp").value = "";
  document.getElementById("email-step").style.display = "block";
  document.getElementById("otp-step").style.display = "none";
  document.getElementById("email-error").textContent = "";
  document.getElementById("otp-error").textContent = "";
  showLoginPage();
}

// ─── NEW ORDER ────────────────────────────────────────────────────────────────
function initNewOrderForm() {
  // Clear form
  ["order-name", "order-phone", "order-project", "order-college"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  state.selectedPkg = null;
  document.getElementById("order-error").textContent = "";
  document.getElementById("order-submit-btn").style.display = "none";
  renderPackageCards();
}

function renderPackageCards() {
  const container = document.getElementById("pkg-cards");
  if (!container) return;
  const pkgs = ["Silver", "Gold", "Platinum"];
  const icons = { Silver: "🥈", Gold: "🥇", Platinum: "💎" };
  const p = state.packages || {};
  const total     = p.PACKAGE_TOTAL     || { Silver: 299,  Gold: 499,  Platinum: 799  };
  const advance   = p.PACKAGE_ADVANCE   || { Silver: 199,  Gold: 299,  Platinum: 399  };
  const remaining = p.PACKAGE_REMAINING || { Silver: 100,  Gold: 200,  Platinum: 400  };
  const features  = p.PACKAGE_FEATURES  || {};

  container.innerHTML = pkgs.map((pkg) => `
    <div class="pkg-card" id="pkg-${pkg}" onclick="selectPackage('${pkg}')">
      <div class="pkg-card-info">
        <div class="pkg-name">${icons[pkg]} ${pkg}</div>
        <div class="pkg-price-row">
          <span class="pkg-total">Total: ₹${total[pkg]}</span>
          <span class="pkg-advance">Advance: ₹${advance[pkg]}</span>
        </div>
        <div class="pkg-remaining">Remaining after delivery: ₹${remaining[pkg]}</div>
        <div class="pkg-features">
          ${(features[pkg] || []).map((f) => `<span class="pkg-feature">${f}</span>`).join("")}
        </div>
      </div>
      <div class="pkg-radio" id="radio-${pkg}"></div>
    </div>
  `).join("");
}

function selectPackage(pkg) {
  state.selectedPkg = pkg;
  document.querySelectorAll(".pkg-card").forEach((c) => c.classList.remove("selected"));
  const card = document.getElementById("pkg-" + pkg);
  if (card) card.classList.add("selected");
  document.getElementById("order-submit-btn").style.display = "block";
  const p = state.packages || {};
  const advance = (p.PACKAGE_ADVANCE || {})[pkg] || 0;
  document.getElementById("order-submit-btn").textContent =
    `Pay Advance ₹${advance} & Confirm Order →`;
}

async function submitOrder() {
  const name     = document.getElementById("order-name").value.trim();
  const phone    = document.getElementById("order-phone").value.trim();
  const project  = document.getElementById("order-project").value.trim();
  const college  = document.getElementById("order-college").value.trim();
  const pkg      = state.selectedPkg;
  const errEl    = document.getElementById("order-error");
  errEl.textContent = "";

  if (!name)    { errEl.textContent = "Please enter your full name."; return; }
  if (!/^\d{10}$/.test(phone)) { errEl.textContent = "Please enter a valid 10-digit phone number."; return; }
  if (!project) { errEl.textContent = "Please enter your project title."; return; }
  if (!college) { errEl.textContent = "Please enter your college name."; return; }
  if (!pkg)     { errEl.textContent = "Please select a package."; return; }

  const p = state.packages || {};
  const advanceAmount = (p.PACKAGE_ADVANCE || {})[pkg] || 199;

  setLoading("order-submit-btn", true, "Processing…");

  try {
    // Step 1: Create Razorpay order for advance payment
    const orderRes = await fetch("/create-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: advanceAmount, currency: "INR", receipt: "rcpt_" + Date.now() }),
    });
    const orderData = await orderRes.json();
    if (!orderRes.ok) throw new Error(orderData.error || "Could not create payment order");

    // Step 2: Launch Razorpay checkout
    await launchRazorpay({
      key:    orderData.key,
      order:  orderData.order,
      name,
      phone,
      project,
      college,
      pkg,
      email: state.email,
      advanceAmount,
    });
  } catch (err) {
    errEl.textContent = err.message || "Payment failed. Please try again.";
    setLoading("order-submit-btn", false, `Pay Advance ₹${advanceAmount} & Confirm Order →`);
  }
}

function launchRazorpay({ key, order, name, phone, project, college, pkg, email, advanceAmount }) {
  return new Promise((resolve, reject) => {
    if (!window.Razorpay) {
      // Load Razorpay script if not loaded
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => openRazorpay({ key, order, name, phone, project, college, pkg, email, advanceAmount }, resolve, reject);
      script.onerror = () => reject(new Error("Failed to load payment gateway. Please try again."));
      document.head.appendChild(script);
    } else {
      openRazorpay({ key, order, name, phone, project, college, pkg, email, advanceAmount }, resolve, reject);
    }
  });
}

function openRazorpay({ key, order, name, phone, project, college, pkg, email, advanceAmount }, resolve, reject) {
  const rzp = new window.Razorpay({
    key,
    amount: order.amount,
    currency: order.currency,
    name: "DocuPresent Solutions",
    description: `${pkg} Package - Advance Payment`,
    order_id: order.id,
    prefill: { name, email, contact: phone },
    theme: { color: "#7c3aed" },
    handler: async (response) => {
      try {
        const res = await fetch("/order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            mobile: phone,
            projectTitle: project,
            collegeName: college,
            package: pkg,
            email,
            paymentId: response.razorpay_payment_id,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Order confirmation failed");

        // Show success
        const remaining = data.order.remainingAmount;
        document.getElementById("success-message").innerHTML =
          `Your <strong>${pkg}</strong> order has been placed!<br><br>` +
          `Order ID: <code>${data.order.id}</code><br><br>` +
          `Invoice and your <strong>remaining payment link (₹${remaining})</strong> have been sent to <strong>${email}</strong>.<br><br>` +
          `Complete the remaining payment at your convenience.`;
        document.getElementById("payment-success-overlay").style.display = "flex";

        document.getElementById("order-submit-btn").disabled = false;
        document.getElementById("order-submit-btn").textContent = `Pay Advance ₹${advanceAmount} & Confirm Order →`;
        resolve();
      } catch (err) {
        reject(err);
      }
    },
    modal: {
      ondismiss: () => {
        document.getElementById("order-submit-btn").disabled = false;
        document.getElementById("order-submit-btn").textContent = `Pay Advance ₹${advanceAmount} & Confirm Order →`;
        resolve(); // don't reject — user just closed
      },
    },
  });
  rzp.open();
}

function closeSuccessOverlay() {
  document.getElementById("payment-success-overlay").style.display = "none";
  showHome();
}

// ─── RECENT ORDERS ────────────────────────────────────────────────────────────
async function loadRecentOrders() {
  const container = document.getElementById("recent-orders-list");
  container.innerHTML = '<div class="loader">Loading your orders…</div>';

  try {
    const res  = await fetch(`/recent?email=${encodeURIComponent(state.email)}`);
    const data = await res.json();
    const orders = (data.orders || []).slice().reverse(); // newest first

    if (!orders.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <p>No orders found for your account.<br>Place your first order today!</p>
        </div>`;
      return;
    }

    container.innerHTML = orders.map((o) => {
      const advance   = o.advancePaid || o.amount || 0;
      const remaining = o.remainingAmount || 0;
      const isPaid    = o.remainingPaid;
      return `
        <div class="order-card">
          <div class="order-id">${o.id}</div>
          <div class="order-pkg">📦 ${o.package}</div>
          <div class="order-info">📂 ${o.projectTitle}</div>
          <div class="order-info">🎓 ${o.collegeName}</div>
          <div class="order-info">💰 Total: ₹${o.totalPrice || (advance + remaining)} &nbsp;|&nbsp; ✅ Advance: ₹${advance}</div>
          ${remaining > 0 ? `<div class="order-info">⏳ Remaining: ₹${remaining}</div>` : ""}
          <div class="order-info">📅 ${new Date(o.createdAt).toLocaleString("en-IN")}</div>
          <span class="${isPaid ? "order-status-paid" : "order-status-pending"}">
            ${isPaid ? "✅ Fully Paid" : "⏳ Remaining Payment Pending"}
          </span>
        </div>`;
    }).join("");
  } catch {
    container.innerHTML = '<div class="loader">Failed to load orders. Please try again.</div>';
  }
}

// ─── PENDING PAYMENTS ────────────────────────────────────────────────────────
async function loadPendingPayments() {
  const container = document.getElementById("pending-payments-list");
  container.innerHTML = '<div class="loader">Loading pending payments…</div>';

  try {
    const res  = await fetch(`/pending-payments?email=${encodeURIComponent(state.email)}`);
    const data = await res.json();
    const orders = data.orders || [];

    if (!orders.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🎉</div>
          <p>No pending payments!<br>All your orders are fully paid.</p>
        </div>`;
      return;
    }

    container.innerHTML = orders.map((o) => `
      <div class="pending-card">
        <div class="order-id">${o.id}</div>
        <div class="order-pkg">📦 ${o.package}</div>
        <div class="order-info">📂 ${o.projectTitle}</div>
        <div class="order-info">🎓 ${o.collegeName}</div>
        <div class="pending-amount">₹${o.remainingAmount} Remaining</div>
        <div class="order-info" style="font-size:12px;color:var(--dim);">
          💳 Payment link has been sent to your registered email.
        </div>
        ${o.remainingPaymentLink
          ? `<a href="${o.remainingPaymentLink}" target="_blank" class="btn-pay">💳 Pay ₹${o.remainingAmount} Now →</a>`
          : `<button class="btn-pay" onclick="generatePayLink('${o.id}', this)">Get Payment Link →</button>`
        }
      </div>`).join("");
  } catch {
    container.innerHTML = '<div class="loader">Failed to load. Please try again.</div>';
  }
}

async function generatePayLink(orderId, btn) {
  btn.disabled = true;
  btn.textContent = "Generating…";
  try {
    const res  = await fetch(`/create-remaining-link?orderId=${encodeURIComponent(orderId)}`);
    const data = await res.json();
    if (!res.ok || !data.paymentLink) throw new Error("Could not generate link");
    // Replace button with link
    const a = document.createElement("a");
    a.href = data.paymentLink;
    a.target = "_blank";
    a.className = "btn-pay";
    a.textContent = `💳 Pay ₹${data.order.remainingAmount} Now →`;
    btn.replaceWith(a);
  } catch {
    btn.disabled = false;
    btn.textContent = "Try Again →";
  }
}
