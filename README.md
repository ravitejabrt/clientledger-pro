# ClientLedger Pro 🚀
### Browser-Based Recurring Monthly Billing & Balance Manager

**ClientLedger Pro** is a modern, responsive web application designed for businesses, freelancers, agencies, tutors, landlords, and service providers who charge clients on a fixed monthly basis, need to adjust fees for specific months, record payments, and track exactly how much balance is pending from each particular month.

---

## 🌟 Key Highlights & How It Addresses Your Requirements

1. **Manage $N$ Number of Clients**:
   - Add, edit, search, and manage unlimited clients.
   - Filter clients by pending dues, fully settled accounts, or advance payments.
   - Search instantly by name, phone, email, or notes.

2. **Fixed Monthly Payments**:
   - Each client has their own default fixed monthly rate (e.g. ₹5,000 / month, $500 / month, etc.).
   - The ledger automatically computes dues for every month from the client's start date up to the current date.

3. **Change Payment for a Particular Month**:
   - Click **"Change Fee"** on any specific month to override the amount (e.g. charge ₹6,500 instead of ₹5,000 for extra work, or discount it for holidays).
   - Add a custom reason or note for that specific month.
   - 1-click option to revert back to the default fixed fee anytime.

4. **Monthly Cumulative Dues (Added to Total Amount)**:
   - Each month is automatically added to the client's cumulative total billed amount.
   - Live summary shows total billed all-time and active monthly run-rate.

5. **Subtract Money Given (Record Payment & Final Balance)**:
   - Click **"Record Client Payment"** when a client gives money.
   - Enter amount, date, payment method (Cash, UPI/GPay, Bank Transfer, Cheque, Card), reference number, and notes.
   - Money received is immediately subtracted from the cumulative balance.
   - The dashboard and client page instantly update to show the **Final Balance** (Pending Due, Fully Settled, or Advance Credit).

6. **Month-by-Month Balance Breakdown (Pending Balance per Month)**:
   - Dedicated table displays every single month chronologically:
     - **Billing Month** (e.g., October 2024)
     - **Billed Fee** (with custom fee indicator)
     - **Paid Towards This Month**
     - **Remaining Balance for This Particular Month** (e.g. "₹1,500 due")
     - **Month Status Badge** (Fully Paid, Partially Paid, Unpaid)
     - **Direct Action Button**: "Pay ₹X" to quickly settle that specific month's balance.

7. **Bonus Features**:
   - **Printable Statements & Invoices**: Generate a clean, printable account statement or invoice with monthly breakdown and payment history.
   - **Bird's Eye Monthly Matrix**: View all clients side-by-side across the last 6, 12, or 24 months.
   - **100% Offline & Local Storage**: Data is saved directly in your browser.
   - **Backup & Restore**: Export all data to JSON or CSV for Excel, or restore anytime.
   - **Preloaded Demo Data**: Includes realistic sample clients to test and explore immediately.

---

## 🚀 How to Run the Project in Your Browser

You have **two simple options** to run this project:

### Option 1: Direct in Browser (Zero Installation)
1. Simply navigate to this folder: `d:\BRT Application\Rahul 2.0`
2. **Double-click `index.html`** (or right-click and choose "Open with Google Chrome" / "Microsoft Edge").
3. The app will launch instantly in your browser!

### Option 2: Run with Local Node Server (Recommended)
1. Double-click **`start.bat`** (or open terminal and run `node server.js` or `npm start`).
2. Your browser will automatically open to `http://localhost:3000`.

---

## 📂 Project Structure

```text
Rahul 2.0/
├── index.html        # Main HTML application interface & modal dialogues
├── styles.css        # Clean styles, responsive design, badge colors & print rules
├── app.js            # Ledger engine, FIFO payment allocation & data management
├── server.js         # Lightweight zero-dependency Node HTTP server
├── start.bat         # 1-click Windows launcher
├── package.json      # NPM scripts (npm start)
└── README.md         # Comprehensive documentation
```

---

## 💡 Quick Tips for Daily Use

- **Switch Currencies**: Use the top-right currency dropdown to select `₹ (INR)`, `$ (USD)`, `€ (EUR)`, `£ (GBP)`, etc.
- **Auto FIFO vs Targeted Payment**: When recording a payment, you can leave allocation as **"Automatic (FIFO)"** to automatically clear the oldest unpaid months first, or select a specific month from the dropdown.
- **Print / PDF**: In any client ledger view, click **"Print Statement / Invoice"** to open a print-ready statement. Press `Ctrl + P` to print or save as PDF.
- **Export Data**: Click the gear/settings icon at the top right to download a JSON backup or export a spreadsheet CSV summary anytime.
