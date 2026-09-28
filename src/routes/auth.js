const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db/connection');
const { KADUNA_LGAS } = require('../db/referenceData');
const { NIGERIAN_STATES } = require('../db/stateDistances');

const router = express.Router();

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/register', { lgas: KADUNA_LGAS, states: NIGERIAN_STATES });
});

router.post('/register', async (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { name, email, phone, password, role, businessName, plotCount, locationLGA, state } = req.body;

  const formData = { name, email, phone, role, businessName, plotCount, locationLGA, state };
  const rerender = () => res.render('auth/register', { lgas: KADUNA_LGAS, states: NIGERIAN_STATES, formData });

  if (!name || !email || !phone || !password || password.length < 6) {
    setFlash(req, 'error', 'Please fill all fields (password needs 6+ characters).');
    return rerender();
  }
  if (role !== 'FARMER' && role !== 'BUYER') {
    setFlash(req, 'error', 'Invalid role selected.');
    return rerender();
  }

  let plotCountValue = 0;
  let finalLGA = '';
  let finalState = '';

  if (role === 'FARMER') {
    if (!locationLGA || !KADUNA_LGAS.includes(locationLGA)) {
      setFlash(req, 'error', 'Please choose a valid Kaduna LGA.');
      return rerender();
    }
    plotCountValue = parseInt(plotCount, 10);
    if (!plotCountValue || plotCountValue < 1 || plotCountValue > 10) {
      setFlash(req, 'error', 'AgroReach is built for smallholder farmers with 1–10 plots of land. Please enter a number in that range.');
      return rerender();
    }
    finalLGA = locationLGA;
  } else {
    // BUYER — statewide, not restricted to Kaduna
    if (!state || !NIGERIAN_STATES.includes(state)) {
      setFlash(req, 'error', 'Please choose a valid Nigerian state.');
      return rerender();
    }
    finalState = state;
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    setFlash(req, 'error', 'An account with that email already exists.');
    return rerender();
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const info = db.prepare(`
    INSERT INTO users (name, email, password_hash, role, phone, location_lga, state, business_name, plot_count, delivery_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, email, passwordHash, role, phone, finalLGA, finalState, businessName || '', plotCountValue, '', Date.now());

  const user = { id: info.lastInsertRowid, name, email, role, locationLGA: finalLGA, state: finalState };
  req.session.user = user;
  setFlash(req, 'success', `Welcome, ${name}!`);
  res.redirect('/');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login');
});

router.post('/login', async (req, res) => {
  const setFlash = req.app.get('setFlash');
  const { email, password } = req.body;

  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row) {
    setFlash(req, 'error', 'No account found with that email.');
    return res.redirect('/login');
  }
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) {
    setFlash(req, 'error', 'Incorrect password.');
    return res.redirect('/login');
  }

  req.session.user = {
    id: row.id, name: row.name, email: row.email, role: row.role,
    locationLGA: row.location_lga, state: row.state,
  };
  setFlash(req, 'success', `Welcome back, ${row.name}!`);
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
