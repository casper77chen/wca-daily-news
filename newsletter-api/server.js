/**
 * WCA Newsletter API Server
 *
 * Features:
 * 1. Subscribe/Unsubscribe API
 * 2. Daily 08:00 (Taiwan time) auto-send newsletter via Zeabur Mail
 * 3. Manual trigger API
 *
 * Environment Variables:
 * - ZEABUR_MAIL_API_KEY: Zeabur Email API Key
 * - SENDER_EMAIL: Sender email (must be under Zeabur Email configured domain)
 * - SITE_URL: Website URL (for links in newsletter)
 * - ADMIN_SECRET: Admin API secret key
 */

import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
  ZEABUR_MAIL_API_KEY: process.env.ZEABUR_MAIL_API_KEY || '',
  SENDER_EMAIL: process.env.SENDER_EMAIL || 'newsletter@yourdomain.com',
  SENDER_NAME: process.env.SENDER_NAME || 'WCA \u767d\u888d\u52a0\u901f\u5668',
  SITE_URL: process.env.SITE_URL || 'https://news.wca.tw',
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'change-me-in-production',
  ZEABUR_MAIL_ENDPOINT: 'https://api.zeabur.com/api/v1/zsend/emails',
};

app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : ['*'], methods: ['GET', 'POST'] }));
app.use(express.json());

try { mkdirSync(join(__dirname, 'data'), { recursive: true }); } catch {}
const db = new Database(join(__dirname, 'data', 'subscribers.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '', subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed INTEGER DEFAULT 1, active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS send_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    recipient_count INTEGER, subject TEXT, status TEXT DEFAULT 'success', error_message TEXT
  );
`);
async function sendViaZeaburMail({ to, subject, html, from, fromName }) {
  const response = await fetch(CONFIG.ZEABUR_MAIL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.ZEABUR_MAIL_API_KEY}` },
    body: JSON.stringify({ from: from || CONFIG.SENDER_EMAIL, from_name: fromName || CONFIG.SENDER_NAME, to: Array.isArray(to) ? to : [to], subject, html }),
  });
  if (!response.ok) { const errorText = await response.text(); throw new Error(`Zeabur Mail API error (${response.status}): ${errorText}`); }
  return response.json();
}

function buildNewsletterHTML(date) {
  const today = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  return `<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#FAFAF7;font-family:'Helvetica Neue',Arial,sans-serif;">
<table role="presentation" width="100%" style="background-color:#FAFAF7;"><tr><td align="center">
<table role="presentation" width="640" style="max-width:640px;background-color:#09182B;border-radius:12px 12px 0 0;">
<tr><td style="padding:28px 32px;text-align:center;">
<div style="font-size:20px;font-weight:700;color:#C8A359;letter-spacing:3px;">WCA</div>
<div style="font-size:12px;color:rgba(255,255,255,0.55);letter-spacing:2px;margin-top:4px;">\u767d\u888d\u52a0\u901f\u5668 \u2014 \u6bcf\u65e5\u91ab\u7642\u65b0\u805e\u7cbe\u9078</div>
<div style="height:2px;background:linear-gradient(90deg,transparent,#9E7D3D 30%,#F0D695 50%,#9E7D3D 70%,transparent);margin-top:16px;"></div>
</td></tr></table>
<table role="presentation" width="640" style="max-width:640px;background-color:#FFFFFF;">
<tr><td style="padding:28px 32px 20px;text-align:center;">
<div style="font-size:13px;color:#C8A359;letter-spacing:3px;text-transform:uppercase;">Daily Medical Briefing</div>
<div style="font-size:22px;font-weight:700;color:#09182B;margin-top:8px;">${today}</div>
</td></tr></table>
<table role="presentation" width="640" style="max-width:640px;background-color:#FFFFFF;">
<tr><td style="padding:0 32px 28px;text-align:center;">
<p style="font-size:15px;color:#5A5A5A;line-height:1.8;margin-bottom:20px;">\u4eca\u65e5\u4e09\u7bc7\u5168\u7403\u91ab\u7642\u7cbe\u9078\u5df2\u70ba\u60a8\u6e96\u5099\u597d\uff0c\u9ede\u64ca\u4e0b\u65b9\u6309\u9215\u95b1\u8b80\u5b8c\u6574\u5831\u5c0e\u8207 WCA \u7368\u5bb6\u6d1e\u5bdf\u3002</p>
<a href="${CONFIG.SITE_URL}/news/${today}.html" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#C8A359,#9E7D3D);color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;border-radius:8px;letter-spacing:1px;">\u95b1\u8b80\u4eca\u65e5\u7cbe\u9078 \u2192</a>
</td></tr></table>
<table role="presentation" width="640" style="max-width:640px;background-color:#09182B;border-radius:0 0 12px 12px;">
<tr><td style="padding:24px 32px;text-align:center;">
<div style="font-size:11px;color:rgba(255,255,255,0.4);line-height:1.8;">WCA \u767d\u888d\u52a0\u901f\u5668<br>
<a href="${CONFIG.SITE_URL}/api/unsubscribe?email={{EMAIL}}" style="color:#C8A359;text-decoration:underline;">\u53d6\u6d88\u8a02\u95b1</a></div>
</td></tr></table></td></tr></table></body></html>`;
}
async function sendDailyNewsletter(date) {
  const today = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const subscribers = db.prepare('SELECT email, name FROM subscribers WHERE active = 1 AND confirmed = 1').all();
  if (subscribers.length === 0) { console.log(`[${today}] No active subscribers.`); return { sent: 0, message: 'No active subscribers' }; }
  const subject = `WCA \u6bcf\u65e5\u91ab\u7642\u7cbe\u9078 \u2014 ${today}`;
  const htmlTemplate = buildNewsletterHTML(today);
  let successCount = 0; let errors = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    const promises = batch.map(async (sub) => {
      try {
        const personalizedHtml = htmlTemplate.replace('{{EMAIL}}', encodeURIComponent(sub.email));
        await sendViaZeaburMail({ to: sub.email, subject, html: personalizedHtml });
        successCount++;
      } catch (err) { errors.push({ email: sub.email, error: err.message }); console.error(`Failed to send to ${sub.email}:`, err.message); }
    });
    await Promise.all(promises);
    if (i + BATCH_SIZE < subscribers.length) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  db.prepare('INSERT INTO send_log (recipient_count, subject, status, error_message) VALUES (?, ?, ?, ?)').run(successCount, subject, errors.length > 0 ? 'partial' : 'success', errors.length > 0 ? JSON.stringify(errors) : null);
  console.log(`[${today}] Newsletter sent: ${successCount}/${subscribers.length} successful`);
  return { sent: successCount, total: subscribers.length, errors };
}

app.get('/api/health', (req, res) => { res.json({ status: 'ok', time: new Date().toISOString() }); });

app.post('/api/subscribe', (req, res) => {
  const { email, name } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });
  try {
    const existing = db.prepare('SELECT * FROM subscribers WHERE email = ?').get(email);
    if (existing) {
      if (existing.active) return res.json({ message: '\u60a8\u5df2\u7d93\u8a02\u95b1\u56c9\uff01', already_subscribed: true });
      db.prepare('UPDATE subscribers SET active = 1, name = ? WHERE email = ?').run(name || '', email);
      return res.json({ message: '\u6b61\u8fce\u56de\u4f86\uff01\u5df2\u91cd\u65b0\u555f\u7528\u60a8\u7684\u8a02\u95b1\u3002', reactivated: true });
    }
    db.prepare('INSERT INTO subscribers (email, name) VALUES (?, ?)').run(email, name || '');
    try { sendViaZeaburMail({ to: email, subject: '\u6b61\u8fce\u8a02\u95b1 WCA \u6bcf\u65e5\u91ab\u7642\u65b0\u805e\u7cbe\u9078', html: '<h2>Welcome to WCA Daily Medical Briefing!</h2><p>You will receive daily news at 8:00 AM.</p>' }); } catch(e) { console.error('Welcome email failed:', e.message); }
    res.json({ message: '\u8a02\u95b1\u6210\u529f\uff01\u6b61\u8fce\u52a0\u5165 WCA \u6bcf\u65e5\u91ab\u7642\u65b0\u805e\u7cbe\u9078\u3002', subscribed: true });
  } catch (err) { console.error('Subscribe error:', err); res.status(500).json({ error: 'Subscribe failed' }); }
});

app.get('/api/unsubscribe', (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).send('Missing email');
  try {
    const result = db.prepare('UPDATE subscribers SET active = 0 WHERE email = ? AND active = 1').run(decodeURIComponent(email));
    res.send(`<html><body style="text-align:center;padding:60px;font-family:Arial;background:#FAFAF7;"><h2 style="color:#C8A359;">WCA</h2><p>${result.changes > 0 ? 'Unsubscribed successfully' : 'Email not found'}</p><a href="${CONFIG.SITE_URL}">Back to site</a></body></html>`);
  } catch (err) { res.status(500).send('Error'); }
});

app.post('/api/admin/send-newsletter', async (req, res) => {
  if (req.headers.authorization !== `Bearer ${CONFIG.ADMIN_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  try { const result = await sendDailyNewsletter(req.body.date); res.json({ message: 'Newsletter sent', ...result }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/subscribers', (req, res) => {
  if (req.headers.authorization !== `Bearer ${CONFIG.ADMIN_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  const subscribers = db.prepare('SELECT id, email, name, subscribed_at, active FROM subscribers ORDER BY subscribed_at DESC').all();
  res.json({ stats: { total: subscribers.length, active: subscribers.filter(s => s.active).length }, subscribers });
});

app.get('/api/admin/send-log', (req, res) => {
  if (req.headers.authorization !== `Bearer ${CONFIG.ADMIN_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ log: db.prepare('SELECT * FROM send_log ORDER BY sent_at DESC LIMIT 30').all() });
});

cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Triggering daily newsletter at 8:00 AM (Asia/Taipei)...');
  try { await sendDailyNewsletter(); } catch (err) { console.error('[CRON] Newsletter send failed:', err); }
}, { timezone: 'Asia/Taipei', scheduled: true });

app.listen(PORT, () => {
  const count = db.prepare('SELECT COUNT(*) as count FROM subscribers WHERE active = 1').get().count;
  console.log(`WCA Newsletter API running on port ${PORT} | ${count} active subscribers | Cron: Daily 8:00 AM Asia/Taipei`);
});
