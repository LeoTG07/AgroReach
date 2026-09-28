// Run with: npm run create-admin
// Reads ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD from your .env file.
// This is the ONLY way to create an Admin account — there is deliberately
// no "Admin" option on the public registration form, the same reasoning
// as before: real admin accounts should never be self-service.

require('dotenv').config();
const bcrypt = require('bcrypt');
const db = require('../db/connection');

async function main() {
  const name = process.env.ADMIN_NAME;
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!name || !email || !password) {
    console.error('Missing ADMIN_NAME / ADMIN_EMAIL / ADMIN_PASSWORD in your .env file.');
    process.exit(1);
  }

  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(email);
  if (existing) {
    if (existing.role === 'ADMIN') {
      console.log(`An admin account already exists for ${email}. Nothing to do.`);
    } else {
      console.error(`A non-admin account already exists for ${email}. Choose a different ADMIN_EMAIL in .env.`);
    }
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  db.prepare(`
    INSERT INTO users (name, email, password_hash, role, phone, location_lga, created_at)
    VALUES (?, ?, ?, 'ADMIN', ?, ?, ?)
  `).run(name, email, passwordHash, 'N/A', 'Kaduna North', Date.now());

  console.log(`Admin account created for ${email}. You can now log in at /login with this email and the password from your .env file.`);
}

main().catch((err) => {
  console.error('Failed to create admin account:', err);
  process.exit(1);
});
