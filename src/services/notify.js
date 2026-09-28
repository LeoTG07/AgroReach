const db = require('../db/connection');

function notify(userId, type, message, link = '') {
  db.prepare(`
    INSERT INTO notifications (user_id, type, message, link, is_read, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(userId, type, message, link, Date.now());
}

function notifyAllAdmins(type, message, link = '') {
  const admins = db.prepare("SELECT id FROM users WHERE role = 'ADMIN'").all();
  admins.forEach((a) => notify(a.id, type, message, link));
}

function unreadCount(userId) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0').get(userId);
  return count;
}

module.exports = { notify, notifyAllAdmins, unreadCount };
