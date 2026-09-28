// Fixed list of Kaduna LGAs — used everywhere an LGA is selected
// (registration, listings, delivery address, logistics matching).
// This is what keeps the platform structurally limited to Kaduna State.
const KADUNA_LGAS = [
  "Chikun", "Igabi", "Ikara", "Jaba", "Jema'a", "Kachia",
  "Kaduna North", "Kaduna South", "Kagarko", "Kajuru",
  "Kaura", "Kauru", "Kubau", "Kudan", "Lere", "Makarfi",
  "Sabon Gari", "Sanga", "Soba", "Zangon Kataf", "Zaria"
];

// Fixed crop picklist — stops a listing being labelled as something
// obviously non-agricultural. "Other" still requires a description,
// and every listing (whatever the label) goes through Admin review,
// which is the real safeguard against a mismatched photo.
const OTHER_CROP = "Other (describe below)";
const CROP_CATALOG = [
  "Maize", "Rice", "Millet", "Sorghum", "Cowpea (Beans)", "Soybean",
  "Groundnut", "Sesame", "Yam", "Cassava", "Sweet Potato",
  "Tomatoes", "Pepper", "Onion", "Okra", "Ginger", "Garlic",
  "Sugarcane", "Cotton", "Cabbage", "Carrot", "Watermelon",
  OTHER_CROP
];

const UNITS = ["kg", "bag", "basket", "tuber(s)", "crate"];

module.exports = { KADUNA_LGAS, CROP_CATALOG, OTHER_CROP, UNITS };
