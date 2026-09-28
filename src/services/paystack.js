const fetch = require('node-fetch');

const PAYSTACK_BASE = 'https://api.paystack.co';

/**
 * Verifies a transaction reference directly against Paystack's servers
 * using the SECRET key. This is the real, secure verification step that
 * was NOT possible in the earlier Android version of this project (which
 * had no backend server to safely hold a secret key) — the web app's
 * real backend lets us do this properly.
 */
async function verifyTransaction(reference) {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey || secretKey.includes('xxxx')) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured in your .env file.');
  }

  const response = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  const data = await response.json();

  if (!response.ok || !data.status) {
    throw new Error(data.message || 'Paystack verification request failed');
  }

  const verified = data.data && data.data.status === 'success';
  return {
    verified,
    amountKobo: data.data ? data.data.amount : 0,
    currency: data.data ? data.data.currency : '',
    raw: data.data,
  };
}

module.exports = { verifyTransaction };
