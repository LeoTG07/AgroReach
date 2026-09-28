const express = require('express');
const db = require('../db/connection');
const { requireLogin } = require('../middleware/auth');
const { notify } = require('../services/notify');

const router = express.Router();
router.use(requireLogin);

// List of conversations (grouped by the other person)
router.get('/', (req, res) => {
  const myId = req.session.user.id;
  const rows = db.prepare(`
    SELECT
      CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS otherId,
      MAX(created_at) AS lastAt
    FROM messages
    WHERE sender_id = ? OR receiver_id = ?
    GROUP BY otherId
    ORDER BY lastAt DESC
  `).all(myId, myId, myId);

  const userStmt = db.prepare('SELECT id, name, role FROM users WHERE id = ?');
  const lastMsgStmt = db.prepare(`
    SELECT content FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at DESC LIMIT 1
  `);
  const conversations = rows.map((r) => ({
    other: userStmt.get(r.otherId),
    lastMessage: lastMsgStmt.get(myId, r.otherId, r.otherId, myId).content,
  })).filter((c) => c.other);

  res.render('messages/list', { conversations });
});

// Thread with one specific person
router.get('/:userId', (req, res) => {
  const myId = req.session.user.id;
  const otherId = parseInt(req.params.userId, 10);
  const other = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(otherId);
  if (!other) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });

  db.prepare(`
    UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?
  `).run(otherId, myId);

  const thread = db.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
    ORDER BY created_at ASC
  `).all(myId, otherId, otherId, myId);

  res.render('messages/thread', { other, thread, orderId: req.query.order || '' });
});

router.post('/:userId', (req, res) => {
  const myId = req.session.user.id;
  const otherId = parseInt(req.params.userId, 10);
  const { content, orderId } = req.body;
  if (!content || !content.trim()) return res.redirect('/messages/' + otherId);

  db.prepare(`
    INSERT INTO messages (order_id, sender_id, receiver_id, content, is_read, created_at)
    VALUES (?, ?, ?, ?, 0, ?)
  `).run(orderId || null, myId, otherId, content.trim(), Date.now());

  notify(otherId, 'NEW_MESSAGE', `${req.session.user.name} sent you a message.`, '/messages/' + myId);
  res.redirect('/messages/' + otherId + (orderId ? '?order=' + orderId : ''));
});

module.exports = router;
