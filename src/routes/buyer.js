const express = require('express');
const db = require('../db/connection');
const { requireRole } = require('../middleware/auth');
const { NIGERIAN_STATES, STATE_DISTANCES_KM } = require('../db/stateDistances');
const { verifyTransaction } = require('../services/paystack');
const { notify, notifyAllAdmins } = require('../services/notify');
const { catchUpMany, catchUpIfNeeded } = require('../services/orderLifecycle');
const { computeStepper } = require('../services/orderStepper');
const { getRecommendations, priceForCompany } = require('../services/logisticsPricing');

const router = express.Router();
router.use(requireRole('BUYER'));

function getCartCount(buyerId) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM cart_items WHERE buyer_id = ?').get(buyerId);
  return count;
}

// ---------------- Browse / Search ----------------
router.get('/dashboard', (req, res) => {
  const q = (req.query.q || '').trim();
  let listings;
  if (q) {
    listings = db.prepare(`
      SELECT * FROM produce_listings WHERE status = 'AVAILABLE' AND crop_type LIKE ? ORDER BY created_at DESC
    `).all(`%${q}%`);
  } else {
    listings = db.prepare(`
      SELECT * FROM produce_listings WHERE status = 'AVAILABLE' ORDER BY created_at DESC
    `).all();
  }
  res.render('buyer/dashboard', { listings, query: q, cartCount: getCartCount(req.session.user.id) });
});

// ---------------- Cart ----------------
router.post('/cart/add', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { listingId, quantity } = req.body;
  const listing = db.prepare("SELECT * FROM produce_listings WHERE id = ? AND status = 'AVAILABLE'").get(listingId);
  if (!listing) {
    setFlash(req, 'error', 'That listing is no longer available.');
    return res.redirect('/buyer/dashboard');
  }
  const qty = Math.max(1, parseFloat(quantity) || 1);
  const buyerId = req.session.user.id;

  const existing = db.prepare('SELECT * FROM cart_items WHERE buyer_id = ? AND listing_id = ?').get(buyerId, listing.id);
  const alreadyInCart = existing ? existing.quantity : 0;

  if (alreadyInCart + qty > listing.quantity) {
    const room = Math.max(0, listing.quantity - alreadyInCart);
    setFlash(req, 'error', room > 0
      ? `Only ${room} ${listing.unit} of ${listing.crop_type} left available (you already have ${alreadyInCart} in your cart).`
      : `You already have all ${listing.quantity} ${listing.unit} of ${listing.crop_type} that's available in your cart.`);
    return res.redirect('/buyer/dashboard');
  }

  if (existing) {
    db.prepare('UPDATE cart_items SET quantity = quantity + ? WHERE id = ?').run(qty, existing.id);
  } else {
    db.prepare(`
      INSERT INTO cart_items (buyer_id, listing_id, farmer_id, farmer_lga, crop_type, price_per_unit, quantity, unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(buyerId, listing.id, listing.farmer_id, listing.location_lga, listing.crop_type, listing.price_per_unit, qty, listing.unit);
  }
  setFlash(req, 'success', `Added ${qty} ${listing.unit} of ${listing.crop_type} to cart`);
  res.redirect('/buyer/dashboard');
});

router.get('/cart', (req, res) => {
  const items = db.prepare('SELECT * FROM cart_items WHERE buyer_id = ?').all(req.session.user.id);
  const total = items.reduce((sum, i) => sum + i.price_per_unit * i.quantity, 0);
  const farmerCount = new Set(items.map((i) => i.farmer_id)).size;
  res.render('buyer/cart', { items, total, farmerCount });
});

router.post('/cart/:id/update', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const newQty = parseFloat(req.body.quantity);
  const item = db.prepare('SELECT * FROM cart_items WHERE id = ? AND buyer_id = ?').get(req.params.id, req.session.user.id);
  if (!item) return res.redirect('/buyer/cart');

  if (newQty > 0) {
    const listing = db.prepare('SELECT quantity, unit, crop_type FROM produce_listings WHERE id = ?').get(item.listing_id);
    if (listing && newQty > listing.quantity) {
      setFlash(req, 'error', `Only ${listing.quantity} ${listing.unit} of ${listing.crop_type} available — quantity capped.`);
      db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ?').run(listing.quantity, item.id);
    } else {
      db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ?').run(newQty, item.id);
    }
  } else {
    db.prepare('DELETE FROM cart_items WHERE id = ? AND buyer_id = ?').run(req.params.id, req.session.user.id);
  }
  res.redirect('/buyer/cart');
});

router.post('/cart/:id/remove', (req, res) => {
  db.prepare('DELETE FROM cart_items WHERE id = ? AND buyer_id = ?').run(req.params.id, req.session.user.id);
  res.redirect('/buyer/cart');
});

// ---------------- Checkout (submit order REQUEST — no payment yet) ----------------
// ---------------- Checkout Step 1: cart review + delivery address ----------------
router.get('/checkout', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const items = db.prepare('SELECT * FROM cart_items WHERE buyer_id = ?').all(req.session.user.id);
  if (items.length === 0) {
    setFlash(req, 'error', 'Your cart is empty.');
    return res.redirect('/buyer/cart');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user.state) {
    setFlash(req, 'error', 'Your account has no state on file — please update your profile.');
    return res.redirect('/buyer/profile');
  }

  const byFarmer = {};
  for (const i of items) {
    if (!byFarmer[i.farmer_id]) byFarmer[i.farmer_id] = { farmer_id: i.farmer_id, items: [], subtotal: 0, totalQuantity: 0 };
    byFarmer[i.farmer_id].items.push(i);
    byFarmer[i.farmer_id].subtotal += i.price_per_unit * i.quantity;
    byFarmer[i.farmer_id].totalQuantity += i.quantity;
  }
  const farmerNameStmt = db.prepare('SELECT name FROM users WHERE id = ?');
  const groups = Object.values(byFarmer).map((g) => ({
    ...g, farmer_name: (farmerNameStmt.get(g.farmer_id) || {}).name || 'Farmer',
  }));

  res.render('buyer/checkout', { groups, user });
});

// ---------------- Checkout Step 2: Logistics Recommendation Engine results ----------------
router.post('/checkout/logistics', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { deliveryAddress } = req.body;
  const items = db.prepare('SELECT * FROM cart_items WHERE buyer_id = ?').all(req.session.user.id);
  if (items.length === 0) {
    setFlash(req, 'error', 'Your cart is empty.');
    return res.redirect('/buyer/cart');
  }
  if (!deliveryAddress || !deliveryAddress.trim()) {
    setFlash(req, 'error', 'Please enter a delivery address.');
    return res.redirect('/buyer/checkout');
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);

  const byFarmer = {};
  for (const i of items) {
    if (!byFarmer[i.farmer_id]) byFarmer[i.farmer_id] = { farmer_id: i.farmer_id, items: [], subtotal: 0, totalQuantity: 0 };
    byFarmer[i.farmer_id].items.push(i);
    byFarmer[i.farmer_id].subtotal += i.price_per_unit * i.quantity;
    byFarmer[i.farmer_id].totalQuantity += i.quantity;
  }
  const farmerNameStmt = db.prepare('SELECT name FROM users WHERE id = ?');
  const groups = Object.values(byFarmer).map((g) => {
    const { distanceKm, options } = getRecommendations(user.state, g.totalQuantity);
    return {
      ...g,
      farmer_name: (farmerNameStmt.get(g.farmer_id) || {}).name || 'Farmer',
      distanceKm, options,
    };
  });

  const noOptionsFor = groups.filter((g) => g.options.length === 0);
  if (noOptionsFor.length > 0) {
    setFlash(req, 'error', `No transport company currently serves ${user.state} for ${noOptionsFor[0].farmer_name}'s produce. Please contact support.`);
    return res.redirect('/buyer/checkout');
  }

  res.render('buyer/checkout_logistics', { groups, user, deliveryAddress: deliveryAddress.trim() });
});

router.post('/checkout/submit', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { deliveryAddress } = req.body;
  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  const items = db.prepare('SELECT * FROM cart_items WHERE buyer_id = ?').all(buyer.id);

  if (items.length === 0) return res.redirect('/buyer/cart');
  if (!deliveryAddress || !deliveryAddress.trim()) {
    setFlash(req, 'error', 'Please enter a delivery address.');
    return res.redirect('/buyer/checkout');
  }

  // Re-validate current stock right before creating orders (stock may have
  // moved since items were added to cart).
  for (const i of items) {
    const listing = db.prepare('SELECT quantity, crop_type, unit, status FROM produce_listings WHERE id = ?').get(i.listing_id);
    if (!listing || listing.status !== 'AVAILABLE' || listing.quantity < i.quantity) {
      setFlash(req, 'error', `${i.crop_type} no longer has enough stock available (${listing ? listing.quantity : 0} ${i.unit} left) — please update your cart.`);
      return res.redirect('/buyer/cart');
    }
  }

  // Group cart items by farmer
  const byFarmer = {};
  for (const i of items) {
    if (!byFarmer[i.farmer_id]) byFarmer[i.farmer_id] = [];
    byFarmer[i.farmer_id].push(i);
  }

  // Validate a chosen transport company was submitted for every farmer group
  for (const farmerId of Object.keys(byFarmer)) {
    if (!req.body[`company_${farmerId}`]) {
      setFlash(req, 'error', 'Please choose a transport option for every farmer in your cart.');
      return res.redirect('/buyer/checkout');
    }
  }

  const farmerNameStmt = db.prepare('SELECT name FROM users WHERE id = ?');
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      buyer_id, buyer_name, buyer_state, delivery_address, farmer_id, farmer_name,
      status, preferred_company_id, preferred_company_name,
      fulfilling_company_id, fulfilling_company_name, fulfilling_kaduna_park, fulfilling_dest_park,
      distance_km, total_quantity, produce_total, transport_fee, total_amount, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING_APPROVAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, listing_id, crop_type, price_per_unit, quantity, unit)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const clearCart = db.prepare('DELETE FROM cart_items WHERE buyer_id = ?');

  const createdOrderIds = [];
  const errors = [];

  const run = db.transaction(() => {
    for (const [farmerId, farmerItems] of Object.entries(byFarmer)) {
      const totalQuantity = farmerItems.reduce((s, i) => s + i.quantity, 0);
      const companyId = req.body[`company_${farmerId}`];
      const priced = priceForCompany(companyId, buyer.state, totalQuantity);
      if (!priced) {
        errors.push(`Selected transport option for one of your farmers is no longer valid.`);
        return;
      }
      const farmerName = (farmerNameStmt.get(farmerId) || {}).name || 'Farmer';
      const produceTotal = farmerItems.reduce((s, i) => s + i.price_per_unit * i.quantity, 0);
      const totalAmount = produceTotal + priced.price;

      // The buyer's choice is final — it is locked in immediately as the
      // fulfilling company too, since the farmer no longer gets to change it.
      const info = insertOrder.run(
        buyer.id, buyer.name, buyer.state, deliveryAddress.trim(), farmerId, farmerName,
        priced.companyId, priced.name,
        priced.companyId, priced.name, priced.kadunaParkAddress, priced.destAddress,
        STATE_DISTANCES_KM[buyer.state], totalQuantity, produceTotal, priced.price, totalAmount, Date.now()
      );
      const orderId = info.lastInsertRowid;
      for (const item of farmerItems) {
        insertItem.run(orderId, item.listing_id, item.crop_type, item.price_per_unit, item.quantity, item.unit);
      }
      createdOrderIds.push(orderId);
    }
    clearCart.run(buyer.id);
  });

  run();

  if (errors.length > 0) {
    setFlash(req, 'error', errors[0]);
    return res.redirect('/buyer/checkout');
  }

  createdOrderIds.forEach((orderId) => {
    const order = db.prepare('SELECT farmer_id FROM orders WHERE id = ?').get(orderId);
    notify(order.farmer_id, 'NEW_ORDER_REQUEST', `New order request #${orderId} from ${buyer.name} — awaiting your approval.`, '/farmer/orders');
  });

  setFlash(req, 'success', createdOrderIds.length > 1
    ? `${createdOrderIds.length} order requests sent to their respective farmers for approval.`
    : 'Order request sent to the farmer for approval.');
  res.redirect('/buyer/orders');
});

// ---------------- My Orders ----------------
router.get('/orders', (req, res) => {
  let orders = db.prepare('SELECT * FROM orders WHERE buyer_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  orders = catchUpMany(orders);
  const itemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  const reviewStmt = db.prepare('SELECT farmer_id FROM reviews WHERE order_id = ? AND buyer_id = ?');
  const ordersWithExtras = orders.map((o) => ({
    ...o,
    items: itemsStmt.all(o.id),
    reviewed: !!reviewStmt.get(o.id, req.session.user.id),
    stepper: computeStepper(o, true), // buyer sees tracking ID
  }));
  res.render('buyer/orders', { orders: ordersWithExtras });
});

router.get('/orders/:id/pay', (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND buyer_id = ?").get(req.params.id, req.session.user.id);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'Order not found.' });
  if (order.status !== 'APPROVED_AWAITING_PAYMENT') {
    return res.status(400).render('error', { title: 'Not payable', message: 'This order is not currently awaiting payment.' });
  }
  res.render('buyer/payment', { order, paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY, userEmail: req.session.user.email });
});

router.post('/orders/:id/pay/verify', async (req, res) => {
  try {
    const { reference } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND buyer_id = ?').get(req.params.id, req.session.user.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    if (order.status !== 'APPROVED_AWAITING_PAYMENT') {
      return res.status(400).json({ success: false, message: 'This order is not awaiting payment.' });
    }

    const result = await verifyTransaction(reference);
    if (!result.verified) {
      return res.status(400).json({ success: false, message: 'Payment could not be verified. Please try again.' });
    }

    db.prepare(`
      UPDATE orders SET status = 'PAID', payment_reference = ?, payment_verified = 1, paid_at = ? WHERE id = ?
    `).run(reference, Date.now(), order.id);

    notify(order.farmer_id, 'ORDER_PAID', `Payment received for order #${order.id}. Waiting for admin to confirm payment to ${order.fulfilling_company_name}.`, '/farmer/orders');
    notifyAllAdmins('ORDER_PAID', `Order #${order.id} paid — please confirm payment to ${order.fulfilling_company_name}.`, '/admin/logistics');

    res.json({ success: true, orderId: order.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: err.message || 'Payment verification failed.' });
  }
});

router.post('/orders/:id/review', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { rating, comment } = req.body;
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND buyer_id = ? AND status = 'DELIVERED'").get(req.params.id, req.session.user.id);
  if (!order) {
    setFlash(req, 'error', 'You can only review delivered orders.');
    return res.redirect('/buyer/orders');
  }
  try {
    db.prepare(`
      INSERT INTO reviews (order_id, buyer_id, farmer_id, rating, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(order.id, req.session.user.id, order.farmer_id, parseInt(rating, 10), comment || '', Date.now());
    notify(order.farmer_id, 'NEW_REVIEW', `${req.session.user.name} left you a ${rating}-star review.`, '/farmer/dashboard');
    setFlash(req, 'success', 'Thanks for your review!');
  } catch (e) {
    setFlash(req, 'error', 'You already reviewed this order.');
  }
  res.redirect('/buyer/orders');
});

// ---------------- Profile ----------------
router.get('/profile', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  res.render('buyer/profile', { user, states: NIGERIAN_STATES });
});

router.post('/profile', (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { name, phone, state, deliveryAddress } = req.body;

  if (!name || !phone || !state || !NIGERIAN_STATES.includes(state)) {
    setFlash(req, 'error', 'Please fill all fields with a valid state.');
    return res.redirect('/buyer/profile');
  }

  db.prepare('UPDATE users SET name = ?, phone = ?, state = ?, delivery_address = ? WHERE id = ?')
    .run(name.trim(), phone.trim(), state, (deliveryAddress || '').trim(), req.session.user.id);

  req.session.user.name = name.trim();
  req.session.user.state = state;
  setFlash(req, 'success', 'Profile updated.');
  res.redirect('/buyer/profile');
});

module.exports = router;
