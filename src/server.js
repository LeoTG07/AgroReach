require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db/connection');
const { seedTransportCompaniesIfEmpty } = require('./db/seedTransportCompanies');
const { attachUser } = require('./middleware/auth');

seedTransportCompaniesIfEmpty();

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8 hours
}));

app.use(attachUser);

app.use((req, res, next) => {
  if (req.session.user) {
    const { unreadCount } = require('./services/notify');
    res.locals.unreadCount = unreadCount(req.session.user.id);
  }
  next();
});

// Flash-style one-time message via session (simple, no extra dependency)
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});
function setFlash(req, type, message) {
  req.session.flash = { type, message };
}
app.set('setFlash', setFlash);

// ---------------- Routes ----------------
app.use('/', require('./routes/auth'));
app.use('/farmer', require('./routes/farmer'));
app.use('/buyer', require('./routes/buyer'));
app.use('/admin', require('./routes/admin'));
app.use('/messages', require('./routes/messages'));
app.use('/notifications', require('./routes/notifications'));

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const role = req.session.user.role;
  if (role === 'FARMER') return res.redirect('/farmer/dashboard');
  if (role === 'BUYER') return res.redirect('/buyer/dashboard');
  if (role === 'ADMIN') return res.redirect('/admin/pending');
  res.redirect('/login');
});

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.', user: req.session.user });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: err.message || 'Unexpected server error.', user: req.session.user });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AgroReach running at http://localhost:${PORT}`);
});
