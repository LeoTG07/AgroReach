const express = require('express');
const db = require('../db/connection');
const { requireRole } = require('../middleware/auth');
const { notify } = require('../services/notify');
const { catchUpMany } = require('../services/orderLifecycle');

const router = express.Router();
router.use(requireRole('ADMIN'));

router.get('/pending', (req, res) => {
  const listings = db.prepare(`
    SELECT * FROM produce_listings WHERE status = 'PENDING_REVIEW' ORDER BY created_at ASC
  `).all();
  res.render('admin/pending', { listings });
});

router.post('/listings/:id/approve', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const listing = db.prepare('SELECT * FROM produce_listings WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).render('error', { title: 'Not found', message: 'Listing not found.' });

  db.prepare("UPDATE produce_listings SET status = 'AVAILABLE' WHERE id = ?").run(listing.id);
  notify(listing.farmer_id, 'LISTING_APPROVED', `Your listing "${listing.crop_type}" was approved and is now visible to buyers.`, '/farmer/dashboard');
  setFlash(req, 'success', 'Listing approved.');
  res.redirect('/admin/pending');
});

router.post('/listings/:id/reject', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const listing = db.prepare('SELECT * FROM produce_listings WHERE id = ?').get(req.params.id);
  if (!listing) return res.status(404).render('error', { title: 'Not found', message: 'Listing not found.' });

  db.prepare("UPDATE produce_listings SET status = 'REJECTED' WHERE id = ?").run(listing.id);
  notify(listing.farmer_id, 'LISTING_REJECTED', `Your listing "${listing.crop_type}" was rejected. You can edit and resubmit it.`, '/farmer/dashboard');
  setFlash(req, 'success', 'Listing rejected.');
  res.redirect('/admin/pending');
});

// ---------------- Logistics dashboard ----------------
router.get('/logistics', (req, res) => {
  let orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  orders = catchUpMany(orders);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const ordersWithItems = orders.map((o) => ({ ...o, items: itemsStmt.all(o.id) }));

  const summary = {
    total: orders.length,
    awaitingApproval: orders.filter((o) => o.status === 'PENDING_APPROVAL').length,
    awaitingPayment: orders.filter((o) => o.status === 'APPROVED_AWAITING_PAYMENT').length,
    active: orders.filter((o) => ['PAID', 'IN_TRANSIT'].includes(o.status)).length,
    delivered: orders.filter((o) => o.status === 'DELIVERED').length,
    soldOut: orders.filter((o) => o.status === 'SOLD_OUT').length,
    revenueCollected: orders.filter((o) => o.payment_verified).reduce((s, o) => s + o.total_amount, 0),
    pendingPayouts: orders.filter((o) => o.status === 'DELIVERED' && o.farmer_bank_account && !o.farmer_paid_out).length,
  };

  res.render('admin/logistics', { orders: ordersWithItems, summary });
});

router.post('/orders/:id/pay-transport', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order || !order.fulfilling_company_id || order.transport_company_paid) {
    setFlash(req, 'error', 'This order is not ready for a transport payment.');
    return res.redirect('/admin/logistics');
  }
  db.prepare('UPDATE orders SET transport_company_paid = 1, transport_company_paid_at = ? WHERE id = ?').run(Date.now(), order.id);
  notify(order.farmer_id, 'TRANSPORT_PAID', `Admin has paid ${order.fulfilling_company_name} for order #${order.id}. You may now drop off your produce at ${order.fulfilling_kaduna_park}.`, '/farmer/orders');
  setFlash(req, 'success', `Marked ${order.fulfilling_company_name} as paid for order #${order.id}.`);
  res.redirect('/admin/logistics');
});

router.post('/orders/:id/pay-farmer', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'DELIVERED'").get(req.params.id);
  if (!order || !order.farmer_bank_account || order.farmer_paid_out) {
    setFlash(req, 'error', 'This order is not ready for farmer payout.');
    return res.redirect('/admin/logistics');
  }
  db.prepare('UPDATE orders SET farmer_paid_out = 1, farmer_paid_out_at = ? WHERE id = ?').run(Date.now(), order.id);
  notify(order.farmer_id, 'PAYOUT_SENT', `₦${order.produce_total.toFixed(2)} for order #${order.id} has been sent to your account ending ${order.farmer_bank_account.slice(-4)}.`, '/farmer/orders');
  setFlash(req, 'success', `Payout marked as sent for order #${order.id}.`);
  res.redirect('/admin/logistics');
});

module.exports = router;
