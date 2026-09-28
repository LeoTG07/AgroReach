/**
 * Driving distances FROM Kaduna (city) TO the capital/major commercial city of
 * every other Nigerian state, plus the FCT. Compiled from available road-distance
 * sources (Google-indexed travel calculators, bus-route blogs) in September 2026.
 *
 * Methodology: for states where a direct driving-distance source was found
 * (marked "measured" below), that figure is used directly. For the remaining
 * states, distance is estimated from straight-line ("as the crow flies")
 * distance data multiplied by a road-network factor of 1.25x (1.4x for far
 * South-West routes, which run indirectly around the Niger/Benue confluence) —
 * calibrated against the measured points, where the actual factor ranged
 * 1.08x-1.43x. This mirrors the same "best-available estimation, clearly
 * documented" approach used for the transport-company coverage data.
 *
 * PRICING FORMULA: price = BASE_FEE + (distance_km * RATE_PER_KM), rounded to
 * the nearest 50 Naira. This directly implements "distances further from
 * Kaduna cost more" as a transparent, explainable rule (no black-box model).
 */

const BASE_FEE = 1000; // flat pickup/handling fee, Naira
const RATE_PER_KM = 15; // Naira per km

const STATE_DISTANCES_KM = {
  // North-West (Kaduna's own zone — closest)
  "Kano": 200,            // measured
  "Katsina": 265,
  "Zamfara": 330,
  "Sokoto": 468,          // measured
  "Kebbi": 430,
  "Jigawa": 300,

  // North-Central
  "FCT (Abuja)": 188,     // measured
  "Niger": 230,
  "Nasarawa": 280,
  "Benue": 420,
  "Plateau": 230,
  "Kogi": 380,
  "Kwara": 400,

  // North-East
  "Bauchi": 280,
  "Gombe": 440,
  "Borno": 781,           // measured
  "Yobe": 480,            // measured
  "Adamawa": 640,
  "Taraba": 560,

  // South-West
  "Lagos": 910,           // measured
  "Ogun": 830,
  "Oyo": 780,
  "Osun": 720,
  "Ondo": 750,
  "Ekiti": 700,

  // South-South
  "Rivers": 700,          // measured
  "Bayelsa": 760,
  "Delta": 705,
  "Edo": 600,
  "Cross River": 770,
  "Akwa Ibom": 750,

  // South-East
  "Enugu": 560,
  "Anambra": 600,
  "Abia": 740,
  "Imo": 720,
  "Ebonyi": 600,
};

function priceForState(state) {
  const km = STATE_DISTANCES_KM[state];
  if (km == null) return null;
  const raw = BASE_FEE + km * RATE_PER_KM;
  return Math.round(raw / 50) * 50;
}

const NIGERIAN_STATES = Object.keys(STATE_DISTANCES_KM).sort();

module.exports = { STATE_DISTANCES_KM, NIGERIAN_STATES, priceForState, BASE_FEE, RATE_PER_KM };
