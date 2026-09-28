const db = require('../db/connection');
const { STATE_DISTANCES_KM } = require('../db/stateDistances');

/**
 * The restored Logistics Recommendation Engine. Unlike the brief flat-fee
 * version, this brings back genuine per-company price competition (each
 * company has its own base_fee) while keeping two rule-based, explainable
 * factors on top:
 *
 *   price = company.base_fee
 *         + (distance_km * RATE_PER_KM)          — real Kaduna-to-state road distance
 *         + (total_quantity * PER_UNIT_SURCHARGE) — scales with cart weight/size
 *
 * All three factors are simple, auditable, and rule-based — no black box.
 * Rounded to the nearest 50 Naira, same as the rest of the app's pricing.
 */
const RATE_PER_KM = 8;
const PER_UNIT_SURCHARGE = 100;

function round50(n) {
  return Math.round(n / 50) * 50;
}

/**
 * Returns every transport company that serves `state`, ranked cheapest
 * first, with the full price breakdown for the given `totalQuantity`.
 */
function getRecommendations(state, totalQuantity) {
  const distanceKm = STATE_DISTANCES_KM[state];
  if (distanceKm == null) return { distanceKm: null, options: [] };

  const companies = db.prepare(`
    SELECT tc.id, tc.name, tc.rating, tc.base_fee, tc.kaduna_park_address,
           tp.park_name AS dest_park_name, tp.address AS dest_address
    FROM transport_companies tc
    JOIN transport_parks tp ON tp.company_id = tc.id AND tp.state = ? AND tp.is_origin = 0
    ORDER BY tc.name
  `).all(state);

  const options = companies.map((c) => {
    const distanceCost = distanceKm * RATE_PER_KM;
    const weightCost = totalQuantity * PER_UNIT_SURCHARGE;
    const price = round50(c.base_fee + distanceCost + weightCost);
    return {
      companyId: c.id,
      name: c.name,
      rating: c.rating,
      kadunaParkAddress: c.kaduna_park_address,
      destParkName: c.dest_park_name,
      destAddress: c.dest_address,
      baseFee: c.base_fee,
      distanceCost: round50(distanceCost),
      weightCost: round50(weightCost),
      price,
    };
  }).sort((a, b) => a.price - b.price);

  return { distanceKm, options };
}

/** Re-price a single already-chosen company (used to validate/recompute at submission time). */
function priceForCompany(companyId, state, totalQuantity) {
  const { options } = getRecommendations(state, totalQuantity);
  return options.find((o) => o.companyId === Number(companyId)) || null;
}

module.exports = { getRecommendations, priceForCompany, RATE_PER_KM, PER_UNIT_SURCHARGE };
