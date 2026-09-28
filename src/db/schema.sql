-- AgroReach database schema (SQLite)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('FARMER','BUYER','ADMIN')),
  phone TEXT NOT NULL,
  location_lga TEXT DEFAULT '',      -- Farmers: Kaduna LGA
  state TEXT DEFAULT '',             -- Buyers: one of the 36 states + FCT
  business_name TEXT DEFAULT '',
  plot_count INTEGER DEFAULT 0,
  delivery_address TEXT DEFAULT '',  -- Buyers: street-level detail within their state
  bank_account_number TEXT DEFAULT '',
  bank_name TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

-- PENDING_REVIEW -> AVAILABLE / REJECTED (by Admin) ; farmer can also -> REMOVED
CREATE TABLE IF NOT EXISTS produce_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farmer_id INTEGER NOT NULL REFERENCES users(id),
  farmer_name TEXT NOT NULL,
  crop_type TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  price_per_unit REAL NOT NULL,
  photo_path TEXT DEFAULT '',
  location_lga TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW','AVAILABLE','REJECTED','SOLD_OUT','REMOVED')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  listing_id INTEGER NOT NULL REFERENCES produce_listings(id),
  farmer_id INTEGER NOT NULL,
  farmer_lga TEXT NOT NULL,
  crop_type TEXT NOT NULL,
  price_per_unit REAL NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  UNIQUE(buyer_id, listing_id)
);

-- Transport companies: each has its own base price (bringing back genuine
-- price competition), plus a Kaduna origin park and destination parks in
-- whichever states it services (see transport_parks). The final price shown
-- to a buyer combines this base with real distance and cart weight — see
-- logisticsPricing.js.
CREATE TABLE IF NOT EXISTS transport_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  rating REAL NOT NULL,
  base_fee REAL NOT NULL,
  kaduna_park_address TEXT NOT NULL
);

-- One row per (company, state) the company can deliver to, plus one
-- is_origin=1 row per company for its Kaduna pickup point.
CREATE TABLE IF NOT EXISTS transport_parks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES transport_companies(id),
  state TEXT NOT NULL,           -- 'Kaduna' for the origin row, else a destination state
  park_name TEXT NOT NULL,
  address TEXT NOT NULL,
  is_origin INTEGER NOT NULL DEFAULT 0
);

-- One order = one farmer's portion of a checkout (a multi-farmer cart splits
-- into multiple orders at submission time, so each farmer can independently
-- approve/reject, choose transport, and get paid).
--
-- Lifecycle: PENDING_APPROVAL -> REJECTED (terminal, never charged)
--                             -> SOLD_OUT (terminal, never charged — another
--                                buyer's request for the same listing was
--                                approved first and used up the stock)
--                             -> APPROVED_AWAITING_PAYMENT -> PAID -> IN_TRANSIT -> DELIVERED
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  buyer_id INTEGER NOT NULL REFERENCES users(id),
  buyer_name TEXT NOT NULL,
  buyer_state TEXT NOT NULL,
  delivery_address TEXT NOT NULL,

  farmer_id INTEGER NOT NULL REFERENCES users(id),
  farmer_name TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN (
    'PENDING_APPROVAL','REJECTED','SOLD_OUT','APPROVED_AWAITING_PAYMENT','PAID','IN_TRANSIT','DELIVERED'
  )),
  rejection_reason TEXT DEFAULT '',

  -- Buyer's chosen logistics option from the Recommendation Engine at checkout
  preferred_company_id INTEGER REFERENCES transport_companies(id),
  preferred_company_name TEXT NOT NULL,

  -- Pricing: company base fee + real Kaduna-to-state distance + cart weight
  -- (see logisticsPricing.js). total_quantity is kept for transparency/audit.
  distance_km REAL NOT NULL,
  total_quantity REAL NOT NULL DEFAULT 0,
  produce_total REAL NOT NULL,
  transport_fee REAL NOT NULL,
  total_amount REAL NOT NULL,

  -- Payment
  payment_reference TEXT DEFAULT '',
  payment_verified INTEGER NOT NULL DEFAULT 0,
  paid_at INTEGER,

  -- Farmer's actual fulfilling company (chosen after payment; defaults to
  -- the buyer's preferred company but the farmer may pick a different one
  -- that also serves the buyer's state, if more convenient from Kaduna)
  fulfilling_company_id INTEGER REFERENCES transport_companies(id),
  fulfilling_company_name TEXT DEFAULT '',
  fulfilling_kaduna_park TEXT DEFAULT '',
  fulfilling_dest_park TEXT DEFAULT '',

  -- Admin manually confirms payment to the transport company (button click)
  transport_company_paid INTEGER NOT NULL DEFAULT 0,
  transport_company_paid_at INTEGER,

  -- Farmer marks produce dropped off at the Kaduna park -> triggers the
  -- automated (simulated) transport-company response.
  -- estimated_delivery_at: internal real timestamp used to drive the ~2min
  --   simulation (never shown to users directly).
  -- estimated_delivery_hours: the user-facing ETA (a distance-scaled random
  --   figure, e.g. "3 hours") shown to buyer, farmer, and admin alike.
  -- delivery_tracking_id: shown to buyer and admin ONLY, never the farmer.
  dropped_off_at INTEGER,
  delivery_tracking_id TEXT DEFAULT '',
  estimated_delivery_at INTEGER,
  estimated_delivery_hours INTEGER,

  delivered_at INTEGER,

  -- Farmer payout, released only after delivery
  farmer_bank_account TEXT DEFAULT '',
  farmer_bank_name TEXT DEFAULT '',
  farmer_paid_out INTEGER NOT NULL DEFAULT 0,
  farmer_paid_out_at INTEGER,

  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  listing_id INTEGER NOT NULL,
  crop_type TEXT NOT NULL,
  price_per_unit REAL NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER REFERENCES orders(id),
  sender_id INTEGER NOT NULL REFERENCES users(id),
  receiver_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  buyer_id INTEGER NOT NULL REFERENCES users(id),
  farmer_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(order_id, farmer_id)
);
