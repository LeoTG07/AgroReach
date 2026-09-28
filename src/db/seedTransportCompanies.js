const db = require('./connection');

/**
 * Real interstate transport operators (GIG Mobility, ABC Transport, and Peace
 * Mass Transit are genuine major Nigerian interstate carriers; Ifesinachi
 * Transport is a genuine South-East-focused carrier that also runs northern
 * routes). Kano Line Motors and Kaduna Line are used as before for the
 * shorter, more regional routes. Each company has ONE Kaduna origin park
 * (where farmers drop off produce) and a set of destination-state parks
 * (where buyers collect / receive delivery). Exact park addresses are
 * reasonable approximations built around well-known terminal districts in
 * each city, not verified physical addresses — the same documented
 * assumption used for the original Kaduna-only transport data.
 */
const COMPANIES = [
  {
    key: "gig_mobility",
    name: "GIG Mobility (formerly God is Good Motors)",
    rating: 4.3,
    base_fee: 4500,
    kaduna_park: "GIG Terminal, No. 3 Kachia Road, Kaduna",
    // National reach — every state covered
    states: "ALL",
  },
  {
    key: "abc_transport",
    name: "ABC Transport",
    rating: 4.4,
    base_fee: 5000,
    kaduna_park: "ABC Terminal, 5 Ali Akilu Road, Kaduna",
    states: [
      "FCT (Abuja)", "Lagos", "Ogun", "Oyo", "Osun", "Ondo", "Ekiti",
      "Rivers", "Delta", "Edo", "Enugu", "Anambra", "Abia", "Imo",
      "Kano", "Kwara", "Benue", "Kogi", "Plateau", "Bauchi",
    ],
  },
  {
    key: "peace_mass_transit",
    name: "Peace Mass Transit",
    rating: 4.2,
    base_fee: 3500,
    kaduna_park: "Peace Mass Terminal, No. 6 Kachia Road, Kaduna",
    states: [
      "FCT (Abuja)", "Lagos", "Rivers", "Delta", "Edo", "Enugu",
      "Anambra", "Abia", "Imo", "Ebonyi", "Cross River", "Akwa Ibom",
      "Bayelsa", "Benue", "Kogi", "Nasarawa",
    ],
  },
  {
    key: "ifesinachi_transport",
    name: "Ifesinachi Transport",
    rating: 4.1,
    base_fee: 3200,
    kaduna_park: "Ifesinachi Park, Command Road, Kaduna",
    states: [
      "Enugu", "Anambra", "Abia", "Imo", "Ebonyi", "Rivers",
      "Delta", "Akwa Ibom", "FCT (Abuja)", "Benue",
    ],
  },
  {
    key: "kano_line_motors",
    name: "Kano Line Motors",
    rating: 4.0,
    base_fee: 3800,
    kaduna_park: "Kano Line Depot, 8 Park Road, Zaria, Kaduna State",
    states: [
      "Kano", "Katsina", "Jigawa", "Bauchi", "Yobe", "Borno",
      "Gombe", "Adamawa", "Zamfara",
    ],
  },
  {
    key: "kaduna_line",
    name: "Kaduna Line (State-Owned)",
    rating: 3.9,
    base_fee: 4000,
    kaduna_park: "Kaduna Line Motor Park, 16 Ahmadu Bello Way, Kaduna",
    states: [
      "FCT (Abuja)", "Niger", "Plateau", "Nasarawa", "Kogi",
      "Kwara", "Sokoto", "Kebbi", "Zamfara",
    ],
  },
];

// Plausible destination-park names per state — well-known interstate
// terminal districts, used consistently across every company that serves
// that state (a simplification; real companies use different named parks
// within the same city).
const STATE_PARK_LABELS = {
  "Abia": "Aba Park, Aba",
  "Adamawa": "Jimeta Park, Yola",
  "Akwa Ibom": "Itu Road Park, Uyo",
  "Anambra": "Upper Iweka Park, Onitsha",
  "Bauchi": "Wunti Park, Bauchi",
  "Bayelsa": "Tombia Junction Park, Yenagoa",
  "Benue": "Wurukum Park, Makurdi",
  "Borno": "Bama Road Park, Maiduguri",
  "Cross River": "Watt Market Park, Calabar",
  "Delta": "Effurun Park, Warri",
  "Ebonyi": "Waterworks Park, Abakaliki",
  "Edo": "Uselu Park, Benin City",
  "Ekiti": "Fajuyi Park, Ado-Ekiti",
  "Enugu": "Holy Ghost Park, Enugu",
  "FCT (Abuja)": "Utako Motor Park, Abuja",
  "Gombe": "Bolari Park, Gombe",
  "Imo": "Douglas Road Park, Owerri",
  "Jigawa": "Dutse Central Park, Dutse",
  "Kano": "Naibawa Park, Kano",
  "Katsina": "Kofar Kaura Park, Katsina",
  "Kebbi": "Birnin Kebbi Park, Birnin Kebbi",
  "Kogi": "Lokongoma Park, Lokoja",
  "Kwara": "Challenge Park, Ilorin",
  "Lagos": "Jibowu Park, Yaba, Lagos",
  "Nasarawa": "Shendam Road Park, Lafia",
  "Niger": "Bosso Road Park, Minna",
  "Ogun": "Panseke Park, Abeokuta",
  "Ondo": "Oja Oba Park, Akure",
  "Osun": "Old Garage Park, Osogbo",
  "Oyo": "Iwo Road Park, Ibadan",
  "Plateau": "Terminus Park, Jos",
  "Rivers": "Waterlines Park, Port Harcourt",
  "Sokoto": "Kasuwar Daji Park, Sokoto",
  "Taraba": "Jalingo Central Park, Jalingo",
  "Yobe": "Damaturu Park, Damaturu",
  "Zamfara": "Gusau Central Park, Gusau",
};

function seedTransportCompaniesIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM transport_companies').get();
  if (count > 0) return;

  const { NIGERIAN_STATES } = require('./stateDistances');

  const insertCompany = db.prepare(`
    INSERT INTO transport_companies (company_key, name, rating, base_fee, kaduna_park_address)
    VALUES (@key, @name, @rating, @base_fee, @kaduna_park)
  `);
  const insertPark = db.prepare(`
    INSERT INTO transport_parks (company_id, state, park_name, address, is_origin)
    VALUES (?, ?, ?, ?, ?)
  `);

  const seedAll = db.transaction(() => {
    for (const c of COMPANIES) {
      const info = insertCompany.run(c);
      const companyId = info.lastInsertRowid;

      // Kaduna origin park (every company has exactly one)
      insertPark.run(companyId, "Kaduna", "Kaduna Origin Park", c.kaduna_park, 1);

      // Destination parks
      const servedStates = c.states === "ALL" ? NIGERIAN_STATES : c.states;
      for (const state of servedStates) {
        const label = STATE_PARK_LABELS[state] || `${state} Central Park`;
        insertPark.run(companyId, state, label, label, 0);
      }
    }
  });

  seedAll();
  console.log(`Seeded ${COMPANIES.length} transport companies with Kaduna + multi-state parks.`);
}

module.exports = { seedTransportCompaniesIfEmpty, COMPANIES, STATE_PARK_LABELS };
