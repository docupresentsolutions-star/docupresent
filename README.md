# DocuPresent Solutions

A full-stack web application for managing project presentation orders with OTP login, Razorpay payments, PDF invoice generation, email delivery, and **Telegram Bot notifications**.

---

## 🗂 Project Structure

```
docupresent/
├── server.js           ← Express backend (all routes + Telegram bot webhook)
├── package.json
├── .env.example        ← Copy to .env and fill in keys
├── orders.json         ← Auto-created on first order (backup; MongoDB is primary)
└── public/
    ├── index.html      ← Full SPA
    ├── style.css       ← Dark glassmorphism UI
    ├── script.js       ← All frontend logic
    └── images/
        ├── silver.png
        ├── gold.png
        └── platinum.png
```

---

## ⚙️ Environment Variables

Copy `.env.example` → `.env` and fill in:

```env
# Brevo (email)
BREVO_API_KEY=xkeysib-...
BREVO_SENDER_EMAIL=DocuPresent <no-reply@yourdomain.com>

# MongoDB
MONGODB_URI=mongodb+srv://...

# Razorpay
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...

# Admin
ADMIN_EMAIL=your_admin@gmail.com

# Telegram Bot
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789
TELEGRAM_WEBHOOK_SECRET=your_random_secret   ← optional

PORT=10000
```

---

## 🤖 Telegram Bot Setup

The Telegram integration works in **two ways**:

### 1. Order Notifications (automatic, no setup beyond env vars)
Every time a new order is placed on the website, your bot sends you a full order summary instantly. Just set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in your env vars and it works automatically.

### 2. Bot Commands (optional, requires webhook registration)
You can send commands to your bot and get live stats:

| Command | Description |
|---------|-------------|
| `/start` | Show available commands |
| `/orders` | View last 5 orders |
| `/total` | Total order count & revenue breakdown |
| `/help` | Show help menu |

**To enable bot commands**, register your webhook after deploying to Render by opening this URL in your browser (replace `your-app` with your actual Render app name):

```
https://api.telegram.org/bot7567616012:AAHIXzN0a-GbMiC5SNpDBojTWvnWFrKMzJ8/setWebhook?url=https://your-app.onrender.com/telegram-webhook
```

### How to get your Telegram Chat ID

**Option A — @userinfobot:**
1. Open Telegram → search `@userinfobot`
2. Start it → it replies with your numeric ID

**Option B — getUpdates API:**
1. Send any message to your bot
2. Open in browser: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
3. Find `"chat":{"id": 123456789}` — that number is your chat ID

---

## 🔗 API Routes

| Method | Route | Description |
|--------|-------|-------------|
| POST | `/send-otp` | Send 6-digit OTP via Brevo email |
| POST | `/verify-otp` | Verify OTP, grant login |
| POST | `/create-order` | Create Razorpay payment order |
| POST | `/order` | Save order + generate PDF + send invoice + notify Telegram |
| GET | `/recent?email=` | Fetch orders for specific user |
| GET | `/dashboard` | All orders (admin) |
| POST | `/telegram-webhook` | Receive Telegram bot commands |

---

## 📦 Packages

| Package | Price | Features |
|---------|-------|---------|
| Silver | ₹199 Advance | PPT + 2 Revisions |
| Gold | ₹199 Advance | Project Doc + PPT (no PPT revision) |
| Platinum | ₹499 Advance | Project Doc + PPT + full revisions |

---

## 🚀 Deploy on Render

1. Push this project to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your GitHub repo
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Add all environment variables from `.env.example` in Render's **Environment** tab
6. Click **Deploy**
7. (Optional) Register your Telegram webhook URL after deploy (see Telegram Bot Setup above)

> Render automatically uses `process.env.PORT`. No changes needed.

---

## 🔧 Getting API Keys

### Brevo (Email)
1. Sign up at [app.brevo.com](https://app.brevo.com)
2. Go to **SMTP & API → API Keys → Create API Key**
3. Verify your sender domain or email
4. Paste key into `BREVO_API_KEY` and your sender email into `BREVO_SENDER_EMAIL`

### Razorpay
1. Sign up at [razorpay.com](https://razorpay.com)
2. **Dashboard → Settings → API Keys → Generate Test Key**
3. Copy Key ID → `RAZORPAY_KEY_ID`, Key Secret → `RAZORPAY_KEY_SECRET`

### MongoDB
1. Sign up at [mongodb.com/atlas](https://www.mongodb.com/atlas)
2. Create a free cluster → **Connect → Drivers** → copy the connection string
3. Replace `<password>` with your DB user password → paste into `MONGODB_URI`

### Telegram Bot
1. Open Telegram → search `@BotFather`
2. Send `/newbot` → follow prompts → copy the token → paste into `TELEGRAM_BOT_TOKEN`
3. Get your chat ID (see above) → paste into `TELEGRAM_CHAT_ID`

---

## 🔒 Security Notes

- Never commit `.env` to git — it is in `.gitignore`
- OTPs expire automatically after 10 minutes (MongoDB TTL index)
- The Telegram webhook route checks `TELEGRAM_CHAT_ID` — only your chat can run commands
- Set `TELEGRAM_WEBHOOK_SECRET` for extra security on the webhook endpoint
- Razorpay payment signature verification is recommended for production
