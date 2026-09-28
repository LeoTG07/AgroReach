const db = require('../db/connection');
const { notify } = require('./notify');

/**
 * Simulated transport-company automation.
 *
 * We are not building a real transport-company portal, so their two
 * responses are automated on a short delay, as agreed:
 *   - 10 seconds after drop-off: a delivery tracking ID + estimated
 *     delivery time is generated and the order moves to IN_TRANSIT.
 *   - 2 minutes after THAT (so ~2m10s after drop-off): the order is
 *     auto-marked DELIVERED.
 *
 * Timers are in-memory (setTimeout), so they don't survive a server
 * restart mid-wait. To stay correct even then, `catchUpIfNeeded` is called
 * opportunistically whenever an order is loaded for display — if enough
 * real time has already passed since drop-off, it applies the transition
 * immediately instead of waiting on a timer that no longer exists.
 *
 * VISIBILITY RULE: the delivery tracking ID is shown to the Buyer and Admin
 * only — never the Farmer. The estimated delivery time (in hours) is shown
 * to all three. Notification text below respects this split.
 */
const TRACKING_DELAY_MS = 10 * 1000;
const DELIVERY_DELAY_MS = 2 * 60 * 1000;

function generateTrackingId() {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `AGR-${Date.now().toString().slice(-6)}-${rand}`;
}

/**
 * A distance-scaled random ETA, e.g. "3 hours" for a nearby state or
 * "14 hours" for a far one — real road distance / an assumed average
 * road speed (~70km/h, accounting for stops), with light randomness so it
 * doesn't feel like a rigid formula, clamped to a sensible 2–24 hour range.
 */
function estimateDeliveryHours(distanceKm) {
  const AVG_SPEED_KMH = 70;
  const jitter = 0.85 + Math.random() * 0.45; // 0.85x - 1.30x
  const hours = Math.round((distanceKm / AVG_SPEED_KMH) * jitter);
  return Math.min(24, Math.max(2, hours));
}

function applyTrackingAssigned(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.dropped_off_at == null || order.delivery_tracking_id) return;

  const trackingId = generateTrackingId();
  const etaHours = estimateDeliveryHours(order.distance_km);
  const eta = Date.now() + DELIVERY_DELAY_MS;
  db.prepare(`
    UPDATE orders
    SET delivery_tracking_id = ?, estimated_delivery_at = ?, estimated_delivery_hours = ?, status = 'IN_TRANSIT'
    WHERE id = ? AND status = 'PAID'
  `).run(trackingId, eta, etaHours, orderId);

  notify(order.buyer_id, 'DELIVERY_ID_ASSIGNED',
    `Your order #${orderId} is in transit. Tracking ID: ${trackingId}. Estimated delivery: ~${etaHours} hour(s).`,
    `/buyer/orders`);
  // Farmer sees the ETA, never the tracking ID.
  notify(order.farmer_id, 'DELIVERY_ID_ASSIGNED',
    `Order #${orderId} is in transit. Estimated delivery: ~${etaHours} hour(s).`,
    `/farmer/orders`);

  scheduleDeliveryIfNeeded(orderId);
}

function applyDelivered(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'IN_TRANSIT') return;

  db.prepare(`UPDATE orders SET status = 'DELIVERED', delivered_at = ? WHERE id = ?`).run(Date.now(), orderId);

  const pickupLabel = order.fulfilling_company_name
    ? `${order.fulfilling_company_name}${order.fulfilling_dest_park ? ' (' + order.fulfilling_dest_park + ')' : ''}`
    : 'your selected transport company';
  notify(order.buyer_id, 'ORDER_DELIVERED',
    `${order.buyer_name}, your order #${orderId} is delivered — you can go to ${pickupLabel} to pick it up.`,
    `/buyer/orders`);
  notify(order.farmer_id, 'ORDER_DELIVERED', `Order #${orderId} was delivered. You can now request payout.`, `/farmer/orders`);
}

function scheduleTrackingIfNeeded(orderId) {
  setTimeout(() => {
    try { applyTrackingAssigned(orderId); } catch (e) { console.error('tracking timer error', e); }
  }, TRACKING_DELAY_MS);
}

function scheduleDeliveryIfNeeded(orderId) {
  setTimeout(() => {
    try { applyDelivered(orderId); } catch (e) { console.error('delivery timer error', e); }
  }, DELIVERY_DELAY_MS);
}

/** Called when a farmer marks produce as dropped off at the Kaduna park. */
function startTransitSimulation(orderId) {
  scheduleTrackingIfNeeded(orderId);
}

/**
 * Call before displaying any order: if a timer "should have" fired by now
 * (e.g. the server restarted mid-wait), apply the transition immediately.
 */
function catchUpIfNeeded(order) {
  if (!order || !order.dropped_off_at) return order;
  const now = Date.now();

  if (order.status === 'PAID' && now - order.dropped_off_at >= TRACKING_DELAY_MS) {
    applyTrackingAssigned(order.id);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  }
  if (order.status === 'IN_TRANSIT' && order.estimated_delivery_at && now >= order.estimated_delivery_at) {
    applyDelivered(order.id);
    order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  }
  return order;
}

function catchUpMany(orders) {
  return orders.map((o) => catchUpIfNeeded(o));
}

/** Strips fields the farmer must never see (delivery tracking ID). */
function forFarmerView(order) {
  const { delivery_tracking_id, ...safe } = order;
  return safe;
}

module.exports = {
  startTransitSimulation,
  catchUpIfNeeded,
  catchUpMany,
  forFarmerView,
  estimateDeliveryHours,
  TRACKING_DELAY_MS,
  DELIVERY_DELAY_MS,
};
