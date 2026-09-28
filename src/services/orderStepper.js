/**
 * Reduces the real order statuses down to the 3-circle stepper the user
 * asked for (Pending -> Approved/Rejected/SoldOut -> Delivered), while still
 * surfacing the finer-grained current state as a sublabel under circle 2/3.
 *
 * `showTrackingId`: the delivery tracking ID must never be shown to the
 * farmer (buyer/admin only) — pass true only from buyer/admin views.
 */
function computeStepper(order, showTrackingId = false) {
  const s = order.status;
  const state = {
    step1: 'grey', step2: 'grey', step3: 'grey',
    line1: 'grey', line2: 'grey',
    step2Label: 'Approved / Rejected',
    step2Sub: '', step3Sub: '',
  };

  if (s === 'PENDING_APPROVAL') {
    state.step1 = 'active';
    return state;
  }

  if (s === 'REJECTED') {
    state.step1 = 'done';
    state.step2 = 'rejected';
    state.step2Label = 'Rejected';
    state.line1 = 'done';
    return state;
  }

  if (s === 'SOLD_OUT') {
    state.step1 = 'done';
    state.step2 = 'rejected';
    state.step2Label = 'Sold Out';
    state.line1 = 'done';
    return state;
  }

  // Every status from here on means the farmer approved
  state.step1 = 'done';
  state.line1 = 'done';
  state.step2Label = 'Approved';

  if (s === 'APPROVED_AWAITING_PAYMENT') {
    state.step2 = 'active';
    state.step2Sub = 'Awaiting buyer payment';
    return state;
  }

  state.step2 = 'done';
  state.line2 = 'done';

  const trackingSuffix = (showTrackingId && order.delivery_tracking_id) ? ` — ${order.delivery_tracking_id}` : '';

  if (s === 'PAID') {
    state.step2Sub = 'Paid — arranging transport';
    state.step3 = 'active';
  } else if (s === 'IN_TRANSIT') {
    state.step2Sub = 'Paid';
    state.step3 = 'active';
    state.step3Sub = `In transit${trackingSuffix}` + (order.estimated_delivery_hours ? ` (ETA ~${order.estimated_delivery_hours}h)` : '');
  } else if (s === 'DELIVERED') {
    state.step2Sub = 'Paid';
    state.step3 = 'done';
    state.step3Sub = showTrackingId ? (order.delivery_tracking_id || '') : '';
  }

  return state;
}

module.exports = { computeStepper };
