function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (req.session.user.role !== role) {
      return res.status(403).render('error', {
        title: 'Access denied',
        message: `This page is only available to ${role.toLowerCase()} accounts.`,
        user: req.session.user,
      });
    }
    next();
  };
}

// Makes the logged-in user (or null) available to every EJS view as
// `currentUser`, so the shared header/nav can render correctly everywhere.
function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  next();
}

module.exports = { requireLogin, requireRole, attachUser };
