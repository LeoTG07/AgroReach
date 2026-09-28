const express = require('express');
const db = require('../db/connection');
const upload = require('../middleware/upload');
const { requireRole } = require('../middleware/auth');
const { KADUNA_LGAS, CROP_CATALOG, OTHER_CROP, UNITS } = require('../db/referenceData');
const { notifyAllAdmins, notify } = require('../services/notify');
const { startTransitSimulation, catchUpMany, catchUpIfNeeded } = require('../services/orderLifecycle');
const { computeStepper } = require('../services/orderStepper');
const { approveOrderAndCascade } = require('../services/stockManagement');

const router = express.Router();
router.use(requireRole('FARMER'));

// ---------------- Dashboard ----------------
router.get('/dashboard', (req, res) => {
  const listings = db.prepare(`
    SELECT * FROM produce_listings WHERE farmer_id = ? AND status != 'REMOVED' ORDER BY created_at DESC
  `).all(req.session.user.id);
  res.render('farmer/dashboard', { listings });
});

// ---------------- Add listing ----------------
router.get('/listings/new', (req, res) => {
  res.render('farmer/listing_form', {
    listing: null, lgas: KADUNA_LGAS, crops: CROP_CATALOG, otherCrop: OTHER_CROP, units: UNITS,
  });
});

router.post('/listings/new', upload.single('photo'), (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { cropType, otherCropType, quantity, unit, pricePerUnit, description, locationLGA } = req.body;
  const finalCrop = cropType === OTHER_CROP ? (otherCropType || '').trim() : cropType;

  if (!finalCrop || !quantity || !pricePerUnit || !req.file) {
    setFlash(req, 'error', 'Please fill in crop type, quantity, price, and choose a photo.');
    return res.redirect('/farmer/listings/new');
  }

  db.prepare(`
    INSERT INTO produce_listings (farmer_id, farmer_name, crop_type, quantity, unit, price_per_unit, photo_path, location_lga, description, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_REVIEW', ?)
  `).run(
    req.session.user.id, req.session.user.name, finalCrop,
    parseFloat(quantity), unit, parseFloat(pricePerUnit),
    req.file.filename, locationLGA, description || '', Date.now()
  );

  notifyAllAdmins('LISTING_SUBMITTED', `${req.session.user.name} submitted "${finalCrop}" for review.`, '/admin/pending');
  setFlash(req, 'success', 'Listing submitted for review!');
  res.redirect('/farmer/dashboard');
});

// ---------------- Edit listing ----------------
router.get('/listings/:id/edit', (req, res) => {
  const listing = db.prepare('SELECT * FROM produce_listings WHERE id = ? AND farmer_id = ?').get(req.params.id, req.session.user.id);
  if (!listing) return res.status(404).render('error', { title: 'Not found', message: 'Listing not found.' });
  res.render('farmer/listing_form', {
    listing, lgas: KADUNA_LGAS, crops: CROP_CATALOG, otherCrop: OTHER_CROP, units: UNITS,
  });
});

router.post('/listings/:id/edit', upload.single('photo'), (req, res) => {
  const setFlash = req.app.get('setFlash');
  const listing = db.prepare('SELECT * FROM produce_listings WHERE id = ? AND farmer_id = ?').get(req.params.id, req.session.user.id);
  if (!listing) return res.status(404).render('error', { title: 'Not found', message: 'Listing not found.' });

  const { cropType, otherCropType, quantity, unit, pricePerUnit, description, locationLGA } = req.body;
  const finalCrop = cropType === OTHER_CROP ? (otherCropType || '').trim() : cropType;
  const photoPath = req.file ? req.file.filename : listing.photo_path;

  db.prepare(`
    UPDATE produce_listings
    SET crop_type=?, quantity=?, unit=?, price_per_unit=?, photo_path=?, location_lga=?, description=?, status='PENDING_REVIEW'
    WHERE id=?
  `).run(finalCrop, parseFloat(quantity), unit, parseFloat(pricePerUnit), photoPath, locationLGA, description || '', listing.id);

  notifyAllAdmins('LISTING_SUBMITTED', `${req.session.user.name} resubmitted "${finalCrop}" for review.`, '/admin/pending');
  setFlash(req, 'success', 'Changes submitted for re-review!');
  res.redirect('/farmer/dashboard');
});

router.post('/listings/:id/remove', (req, res) => {
  const setFlash = req.app.get('setFlash');
  db.prepare("UPDATE produce_listings SET status='REMOVED' WHERE id=? AND farmer_id=?").run(req.params.id, req.session.user.id);
  setFlash(req, 'success', 'Listing removed.');
  res.redirect('/farmer/dashboard');
});

// ---------------- Orders ----------------
router.get('/orders', (req, res) => {
  let orders = db.prepare('SELECT * FROM orders WHERE farmer_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  orders = catchUpMany(orders);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const ordersWithExtras = orders.map((o) => ({
    ...o,
    items: itemsStmt.all(o.id),
    stepper: computeStepper(o, false), // farmer never sees the tracking ID
  }));
  res.render('farmer/orders', { orders: ordersWithExtras });
});

router.post('/orders/:id/approve', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND farmer_id = ?").get(req.params.id, req.session.user.id);
  if (!order || order.status !== 'PENDING_APPROVAL') {
    setFlash(req, 'error', 'This order can no longer be approved.');
    return res.redirect('/farmer/orders');
  }
  const result = approveOrderAndCascade(order.id);
  if (!result.ok) {
    setFlash(req, 'error', 'This order could not be approved.');
    return res.redirect('/farmer/orders');
  }
  notify(order.buyer_id, 'ORDER_APPROVED', `${order.farmer_name} approved your order #${order.id}. You can now pay.`, '/buyer/orders');
  const soldOutNote = result.soldOutOrderIds.length > 0
    ? ` ${result.soldOutOrderIds.length} other pending request(s) for the same produce were automatically marked Sold Out.`
    : '';
  setFlash(req, 'success', `Order approved — the buyer has been asked to pay.${soldOutNote}`);
  res.redirect('/farmer/orders');
});

router.post('/orders/:id/reject', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { reason } = req.body;
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND farmer_id = ?").get(req.params.id, req.session.user.id);
  if (!order || order.status !== 'PENDING_APPROVAL') {
    setFlash(req, 'error', 'This order can no longer be rejected.');
    return res.redirect('/farmer/orders');
  }
  db.prepare("UPDATE orders SET status = 'REJECTED', rejection_reason = ? WHERE id = ?").run(reason || '', order.id);
  notify(order.buyer_id, 'ORDER_REJECTED', `${order.farmer_name} was unable to fulfil order #${order.id}.${reason ? ' Reason: ' + reason : ''}`, '/buyer/orders');
  setFlash(req, 'success', 'Order rejected. The buyer was not charged.');
  res.redirect('/farmer/orders');
});

router.post('/orders/:id/drop-off', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND farmer_id = ? AND status = 'PAID'").get(req.params.id, req.session.user.id);
  if (!order || !order.fulfilling_company_id || !order.transport_company_paid || order.dropped_off_at) {
    setFlash(req, 'error', 'This order is not ready for drop-off yet.');
    return res.redirect('/farmer/orders');
  }
  db.prepare('UPDATE orders SET dropped_off_at = ? WHERE id = ?').run(Date.now(), order.id);
  startTransitSimulation(order.id);
  notify(order.buyer_id, 'ORDER_DROPPED_OFF', `Your order #${order.id} has been dropped off at ${order.fulfilling_company_name}. Tracking details will follow shortly.`, '/buyer/orders');
  setFlash(req, 'success', 'Marked as dropped off. Tracking details will be generated shortly.');
  res.redirect('/farmer/orders');
});

router.get('/orders/:id/payout', (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND farmer_id = ? AND status = 'DELIVERED'").get(req.params.id, req.session.user.id);
  if (!order || order.farmer_paid_out) return res.redirect('/farmer/orders');
  const profile = db.prepare('SELECT bank_account_number, bank_name FROM users WHERE id = ?').get(req.session.user.id);
  res.render('farmer/payout', { order, savedBank: profile });
});

router.post('/orders/:id/payout', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { bankAccount, bankName } = req.body;
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND farmer_id = ? AND status = 'DELIVERED'").get(req.params.id, req.session.user.id);
  if (!order || order.farmer_paid_out) return res.redirect('/farmer/orders');

  if (!bankAccount || bankAccount.trim().length < 10 || !bankName) {
    setFlash(req, 'error', 'Please enter a valid 10-digit account number and bank name.');
    return res.redirect(`/farmer/orders/${order.id}/payout`);
  }

  db.prepare('UPDATE orders SET farmer_bank_account = ?, farmer_bank_name = ? WHERE id = ?')
    .run(bankAccount.trim(), bankName.trim(), order.id);
  // Also keep it on the profile for convenience next time
  db.prepare('UPDATE users SET bank_account_number = ?, bank_name = ? WHERE id = ?')
    .run(bankAccount.trim(), bankName.trim(), req.session.user.id);

  notifyAllAdmins('PAYOUT_REQUESTED', `Order #${order.id}: farmer submitted bank details, ₦${order.produce_total.toFixed(2)} payout is ready to be sent.`, '/admin/logistics');
  setFlash(req, 'success', 'Bank details submitted. The admin will process your payout shortly.');
  res.redirect('/farmer/orders');
});

// ---------------- Profile ----------------
router.get('/profile', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('farmer/profile', { user, lgas: KADUNA_LGAS });
});

router.post('/profile', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { name, phone, businessName, locationLGA, bankAccount, bankName } = req.body;

  if (!name || !phone || !locationLGA || !KADUNA_LGAS.includes(locationLGA)) {
    setFlash(req, 'error', 'Please fill all fields with a valid Kaduna LGA.');
    return res.redirect('/farmer/profile');
  }

  db.prepare(`
    UPDATE users SET name = ?, phone = ?, business_name = ?, location_lga = ?, bank_account_number = ?, bank_name = ?
    WHERE id = ?
  `).run(name.trim(), phone.trim(), (businessName || '').trim(), locationLGA, (bankAccount || '').trim(), (bankName || '').trim(), req.session.user.id);

  req.session.user.name = name.trim();
  req.session.user.locationLGA = locationLGA;
  setFlash(req, 'success', 'Profile updated.');
  res.redirect('/farmer/profile');
});

module.exports = router;
