# 🍽️ Restaurant WhatsApp QR Order Management & Kitchen Display System (KDS)

A production-ready, full-stack Restaurant Order Management System that allows dine-in customers to order directly from their table using WhatsApp by scanning a Table QR code, eliminating the need for waiters to take orders manually.

---

## 🌟 Key Features

### 1. 📱 WhatsApp Customer Ordering Bot
- **Table Detection via QR Code**: Scanning a table's QR opens WhatsApp with a prefilled greeting (e.g. `Hi Table 3`).
- **Interactive Digital Menu**: Browses Starters, Main Course, Breads & Rice, Beverages, Desserts with prices, Veg/Non-Veg badges (🟢/🔴), and spice levels (🌶️).
- **Cart & Instant Confirmation**: Summarizes ordered dishes, quantities, and calculates GST before placing.
- **Real-Time Order Tracking**: Customers can type `Status` or tap **📋 Check Order** to see current kitchen progress:
  - ⏳ Received (Pending)
  - 🔥 Cooking in Progress
  - 🔔 Ready to Serve
  - 🍽️ Served
- **Instant Cancellation**: Customers can cancel their order (or call a waiter) directly from WhatsApp.
- **Waiter & Assistance Call**: Allows requesting water, napkins, or the bill with immediate alerts on the admin screen.

### 2. 👨‍🍳 Kitchen Display System (KDS) & Admin Panel
- **Real-Time Live Queue**: Cards appear the second a customer confirms on WhatsApp (powered by Socket.IO).
- **Live Running Timers**: Dynamically counts elapsed preparation time (`⏱️ 4m 12s`), color-coded:
  - 🟢 Green (< 8 mins)
  - 🟡 Amber (8–15 mins)
  - 🔴 Red blinking (> 15 mins delayed)
- **Dish Checklist**: Chefs can check off individual items as they cook them.
- **Emergency Cancellation Alerts**: If a customer cancels via WhatsApp, the order card immediately flashes RED with an audible warning so the kitchen does not waste food.
- **Order Progression Stages**:
  - `🔥 Start Cooking` ➡️ `🔔 Mark Ready` ➡️ `🍽️ Mark Served` ➡️ `💵 Complete & Free Table`
- **Customer Bill & Receipt Printing**: One-click printable customer invoice.

### 3. 🏷️ Table & QR Code Studio
- Generates unique QR codes for every table linking directly to WhatsApp (`wa.me/<number>?text=Hi%20Table%20<no>`).
- **Printable Table Tent Cards**: Professional restaurant stands with Wi-Fi info, table number, and instructions ready to print.

### 4. 📖 Live Menu & Stock Control
- Toggle **In Stock / Out of Stock** with one click.
- Sold-out dishes are immediately hidden from the WhatsApp Bot so customers cannot order them.
- Add new food items with custom categories, prices, veg/non-veg tags, and descriptions.

### 5. 📱 Built-in WhatsApp Smartphone Simulator
- Test the complete customer ordering experience right inside your browser without needing a verified Meta WhatsApp Business Account on day one!

---

## 🚀 How to Run Locally

### 1. Requirements
- Node.js (v18+)

### 2. Start the Server
Open terminal in the project directory:
```bash
npm start
```

Open your browser at:
- **Kitchen & Admin Display**: [http://localhost:3000](http://localhost:3000)
- **WhatsApp Simulator**: [http://localhost:3000/#simulator](http://localhost:3000/#simulator)
- **Table QR Code Studio**: [http://localhost:3000/#tables](http://localhost:3000/#tables)

---

## ⚙️ Connecting to Official Meta WhatsApp Cloud API

When ready to use a real phone number for customer orders:
1. Go to [developers.facebook.com](https://developers.facebook.com) and create a **Business App**.
2. Add the **WhatsApp** product.
3. In WhatsApp > Configuration, set your Webhook URL:
   - **Callback URL**: `https://<your-domain>/webhook`
   - **Verify Token**: `RESTAURANT_ORDER_BOT_SECRET_2026`
4. Under Webhook fields, click **Subscribe** for `messages`.
5. Add your credentials in `.env`:
   ```env
   WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
   WHATSAPP_ACCESS_TOKEN=your_permanent_access_token
   WHATSAPP_VERIFY_TOKEN=RESTAURANT_ORDER_BOT_SECRET_2026
   ```

---

## 📂 Project Architecture

```
├── data/
│   ├── menu.json        # Restaurant dishes & stock status
│   ├── orders.json      # Live & historical orders
│   ├── tables.json      # Table occupancy and capacities
│   └── settings.json    # Restaurant settings & tax configuration
├── public/
│   ├── index.html       # Single-Page Dashboard & KDS UI
│   ├── css/style.css    # Modern Dark/Light theme & print styles
│   └── js/
│       ├── app.js       # KDS controller & Socket.IO client
│       ├── audio.js     # Web Audio API alert synthesizer
│       ├── qr-studio.js # QR generation & printable tent cards
│       └── simulator.js # WhatsApp phone simulator
├── routes/
│   ├── api.js           # REST endpoints for orders, tables, menu, stats
│   └── webhook.js       # Meta WhatsApp Cloud API webhook handler
├── services/
│   ├── botEngine.js     # Conversational state machine for ordering
│   ├── storage.js       # Database storage layer
│   └── whatsappApi.js   # WhatsApp message dispatcher
├── server.js            # Express & Socket.IO server
└── package.json
```
