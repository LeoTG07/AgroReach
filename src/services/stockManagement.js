const db = require('../db/connection');
const { notify } = require('./notify');

/**
 * Called when a farmer approves an order. Deducts the approved quantities
 * from each listing's stock (this is the moment stock is actually
 * committed — not at request-submission time), marks any listing that hits
 * zero as SOLD_OUT, and then checks every OTHER still-pending request
 * against the same listing(s): if there's no longer enough left to cover
 * what that buyer originally asked for, their request auto-resolves to
 * SOLD_OUT (a farmer never has to act on it) and they're notified.
 */
function approveOrderAndCascade(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'PENDING_APPROVAL') return { ok: false };

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
  const listingIds = [...new Set(items.map((i) => i.listing_id))];

  const soldOutBuyers = [];

  const run = db.transaction(() => {
    // 1. Deduct stock for the approved order's items.
    for (const item of items) {
      db.prepare('UPDATE produce_listings SET quantity = MAX(0, quantity - ?) WHERE id = ?')
        .run(item.quantity, item.listing_id);

      const listing = db.prepare('SELECT * FROM produce_listings WHERE id = ?').get(item.listing_id);
      if (listing && listing.quantity <= 0 && listing.status === 'AVAILABLE') {
        db.prepare("UPDATE produce_listings SET status = 'SOLD_OUT' WHERE id = ?").run(listing.id);
      }
    }

    db.prepare("UPDATE orders SET status = 'APPROVED_AWAITING_PAYMENT' WHERE id = ?").run(orderId);

    // 2. Re-check every other still-pending order that touches the same listing(s).
    if (listingIds.length > 0) {
      const placeholders = listingIds.map(() => '?').join(',');
      const siblingOrderIds = db.prepare(`
        SELECT DISTINCT o.id FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.status = 'PENDING_APPROVAL' AND o.id != ? AND oi.listing_id IN (${placeholders})
      `).all(orderId, ...listingIds).map((r) => r.id);

      for (const siblingId of siblingOrderIds) {
        const siblingItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(siblingId);
        let insufficient = false;
        for (const si of siblingItems) {
          const listing = db.prepare('SELECT quantity FROM produce_listings WHERE id = ?').get(si.listing_id);
          if (!listing || listing.quantity < si.quantity) {
            insufficient = true;
            break;
          }
        }
        if (insufficient) {
          const siblingOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(siblingId);
          db.prepare("UPDATE orders SET status = 'SOLD_OUT' WHERE id = ?").run(siblingId);
          soldOutBuyers.push(siblingOrder);
        }
      }
    }
  });

  run();

  for (const so of soldOutBuyers) {
    notify(so.buyer_id, 'ORDER_SOLD_OUT',
      `Sorry — the produce in order #${so.id} sold out before your request could be approved.`,
      '/buyer/orders');
  }

  return { ok: true, soldOutOrderIds: soldOutBuyers.map((o) => o.id) };
}

module.exports = { approveOrderAndCascade };
