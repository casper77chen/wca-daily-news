/**
 * WCA Newsletter API Server
 *
 * 功能：
 * 1. 訂閱/取消訂閱 API
 * 2. 每日 08:00 (台灣時間) 自動寄送電子報 via Zeabur Mail
 * 3. 手動觸發寄送 API
 *
 * 環境變數：
 * - ZEABUR_MAIL_API_KEY: Zeabur Email API Key
 * - SENDER_EMAIL: 寄件者 email (需在 Zeabur Email 設定的域名下)
 * - SITE_URL: 網站網址 (用於電子報中的連結)
 * - ADMIN_SECRET: 管理 API 的密鑰
 */

import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// ===== Config =====
const CONFIG = {
  ZEABUR_MAIL_API_KEY: process.env.ZEABUR_MAIL_API_KEY || '',
  SENDER_EMAIL: process.env.SENDER_EMAIL || 'newsletter@yourdomain.com',
  SENDER_NAME: process.env.SENDER_NAME || 'WCA 白袍加速器',
  SITE_URL: process.env.SITE_URL || 'https://news.wca.tw',
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'change-me-in-production',
  ZEABUR_MAIL_ENDPOINT: 'https://api.zeabur.com/api/v1/zsend/emails',
};

// ===== Middleware =====
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['*'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(express.json());

// ===== Database =====
const db = new Database(join(__dirname, 'data', 'subscribers.db'));
db.pragma('journal_mode = WAL');

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    subscribed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed INTEGER DEFAULT 1,
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS send_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    recipient_count INTEGER,
    subject TEXT,
    status TEXT DEFAULT 'success',
    error_message TEXT
  );
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('clinic', 'talent', 'startup')),
    title TEXT NOT NULL,
    source_name TEXT NOT NULL,
    reading_time TEXT DEFAULT '4',
    body TEXT NOT NULL,
    wca_insight TEXT NOT NULL,
    original_url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(date);
`);

// ===== Helper: Send email via Zeabur Mail =====
async function sendViaZeaburMail({ to, subject, html, from, fromName }) {
  const response = await fetch(CONFIG.ZEABUR_MAIL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CONFIG.ZEABUR_MAIL_API_KEY}`,
    },
    body: JSON.stringify({
      from: from || CONFIG.SENDER_EMAIL,
      from_name: fromName || CONFIG.SENDER_NAME,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Zeabur Mail API error (${response.status}): ${errorText}`);
  }

  return response.json();
}

// ===== Helper: Build newsletter HTML =====
function buildNewsletterHTML(date) {
  const today = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

  // Try to load today's news HTML file
  const newsFilePath = join(__dirname, '..', 'news', `${today}.html`);

  // Build email template
  return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#FAFAF7; font-family: 'Helvetica Neue', Arial, 'Noto Sans TC', sans-serif;">
  <table role="presentation" width="100%" style="background-color:#FAFAF7;">
    <tr><td align="center" style="padding: 0;">

      <!-- Header -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#09182B; border-radius: 12px 12px 0 0;">
        <tr>
          <td style="padding: 28px 32px; text-align: center;">
            <div style="font-family: 'Cinzel', serif; font-size: 20px; font-weight: 700; color: #C8A359; letter-spacing: 3px;">
              WCA
            </div>
            <div style="font-family: 'Noto Sans TC', sans-serif; font-size: 12px; color: rgba(255,255,255,0.55); letter-spacing: 2px; margin-top: 4px;">
              白袍加速器 — 每日醫療新聞精選
            </div>
            <div style="height: 2px; background: linear-gradient(90deg, transparent, #9E7D3D 30%, #F0D695 50%, #9E7D3D 70%, transparent); margin-top: 16px;"></div>
          </td>
        </tr>
      </table>

      <!-- Date Banner -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#FFFFFF;">
        <tr>
          <td style="padding: 28px 32px 20px; text-align: center;">
            <div style="font-size: 13px; color: #C8A359; letter-spacing: 3px; text-transform: uppercase;">Daily Medical Briefing</div>
            <div style="font-size: 22px; font-weight: 700; color: #09182B; margin-top: 8px;">${today}</div>
          </td>
        </tr>
      </table>

      <!-- CTA to read online -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#FFFFFF;">
        <tr>
          <td style="padding: 0 32px 28px; text-align: center;">
            <p style="font-size: 15px; color: #5A5A5A; line-height: 1.8; margin-bottom: 20px;">
              今日三篇全球醫療精選已為您準備好，點擊下方按鈕閱讀完整報導與 WCA 獨家洞察。
            </p>
            <a href="${CONFIG.SITE_URL}/news/${today}.html"
               style="display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #C8A359, #9E7D3D); color: #FFFFFF; text-decoration: none; font-size: 15px; font-weight: 600; border-radius: 8px; letter-spacing: 1px;">
              閱讀今日精選 →
            </a>
          </td>
        </tr>
      </table>

      <!-- Footer -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#09182B; border-radius: 0 0 12px 12px;">
        <tr>
          <td style="padding: 24px 32px; text-align: center;">
            <div style="font-size: 11px; color: rgba(255,255,255,0.4); line-height: 1.8;">
              WCA 白袍加速器 — 醫療創業的金質標準<br>
              <a href="${CONFIG.SITE_URL}/api/unsubscribe?email={{EMAIL}}" style="color: #C8A359; text-decoration: underline;">取消訂閱</a>
            </div>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

// ===== Helper: Send newsletter to all subscribers =====
async function sendDailyNewsletter(date) {
  const today = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const subscribers = db.prepare('SELECT email, name FROM subscribers WHERE active = 1 AND confirmed = 1').all();

  if (subscribers.length === 0) {
    console.log(`[${today}] No active subscribers. Skipping.`);
    return { sent: 0, message: 'No active subscribers' };
  }

  const subject = `WCA 每日醫療精選 — ${today}`;
  const htmlTemplate = buildNewsletterHTML(today);

  let successCount = 0;
  let errors = [];

  // Send in batches of 50 to avoid rate limits
  const BATCH_SIZE = 50;
  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);

    // Send individually so we can personalize unsubscribe links
    const promises = batch.map(async (sub) => {
      try {
        const personalizedHtml = htmlTemplate.replace('{{EMAIL}}', encodeURIComponent(sub.email));
        await sendViaZeaburMail({
          to: sub.email,
          subject,
          html: personalizedHtml,
        });
        successCount++;
      } catch (err) {
        errors.push({ email: sub.email, error: err.message });
        console.error(`Failed to send to ${sub.email}:`, err.message);
      }
    });

    await Promise.all(promises);

    // Small delay between batches
    if (i + BATCH_SIZE < subscribers.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Log the send
  db.prepare(`
    INSERT INTO send_log (recipient_count, subject, status, error_message)
    VALUES (?, ?, ?, ?)
  `).run(
    successCount,
    subject,
    errors.length > 0 ? 'partial' : 'success',
    errors.length > 0 ? JSON.stringify(errors) : null
  );

  console.log(`[${today}] Newsletter sent: ${successCount}/${subscribers.length} successful`);
  return { sent: successCount, total: subscribers.length, errors };
}

// ===== Routes =====

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Subscribe
app.post('/api/subscribe', (req, res) => {
  const { email, name } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: '請輸入有效的 Email 地址' });
  }

  try {
    const existing = db.prepare('SELECT * FROM subscribers WHERE email = ?').get(email);

    if (existing) {
      if (existing.active) {
        return res.json({ message: '您已經訂閱囉！', already_subscribed: true });
      }
      // Reactivate
      db.prepare('UPDATE subscribers SET active = 1, name = ? WHERE email = ?').run(name || '', email);
      return res.json({ message: '歡迎回來！已重新啟用您的訂閱。', reactivated: true });
    }

    db.prepare('INSERT INTO subscribers (email, name) VALUES (?, ?)').run(email, name || '');

    // Send welcome email
    try {
      sendViaZeaburMail({
        to: email,
        subject: '歡迎訂閱 WCA 每日醫療新聞精選',
        html: `
<!DOCTYPE html>
<html><body style="margin:0; padding:0; background:#FAFAF7; font-family: Arial, sans-serif;">
<table width="100%" style="background:#FAFAF7;"><tr><td align="center" style="padding:40px 0;">
  <table width="560" style="max-width:560px; background:#FFFFFF; border-radius:12px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <tr><td style="background:#09182B; padding:24px; text-align:center;">
      <div style="font-size:20px; font-weight:700; color:#C8A359; letter-spacing:3px;">WCA</div>
      <div style="font-size:11px; color:rgba(255,255,255,0.5); margin-top:4px;">白袍加速器</div>
    </td></tr>
    <tr><td style="padding:32px;">
      <h2 style="color:#09182B; font-size:18px; margin-bottom:16px;">歡迎加入 WCA 每日醫療新聞精選！</h2>
      <p style="color:#5A5A5A; font-size:14px; line-height:1.8;">
        感謝您的訂閱！從明天開始，您將在每天早上 8:00 收到我們精心挑選的三篇全球醫療產業報導，涵蓋：
      </p>
      <ul style="color:#5A5A5A; font-size:14px; line-height:2;">
        <li><strong>診所經營管理</strong> — 全球診所經營最佳實踐</li>
        <li><strong>醫療領導人才</strong> — 醫療領袖的洞見與策略</li>
        <li><strong>醫療科技新創</strong> — 最新醫療科技趨勢</li>
      </ul>
      <p style="color:#5A5A5A; font-size:14px; line-height:1.8; margin-top:16px;">
        每篇都附有 WCA 獨家策略洞察，幫助您在五分鐘內掌握全球醫療產業的關鍵動態。
      </p>
      <div style="text-align:center; margin-top:24px;">
        <a href="${CONFIG.SITE_URL}" style="display:inline-block; padding:12px 28px; background:linear-gradient(135deg,#C8A359,#9E7D3D); color:#FFF; text-decoration:none; border-radius:8px; font-weight:600;">
          立即閱讀今日精選 →
        </a>
      </div>
    </td></tr>
    <tr><td style="background:#09182B; padding:16px; text-align:center;">
      <div style="font-size:11px; color:rgba(255,255,255,0.4);">WCA 白袍加速器 — 醫療創業的金質標準</div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`,
      });
    } catch (e) {
      console.error('Welcome email failed:', e.message);
    }

    res.json({ message: '訂閱成功！歡迎加入 WCA 每日醫療新聞精選。', subscribed: true });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: '訂閱時發生錯誤，請稍後再試。' });
  }
});

// Unsubscribe (GET for email link compatibility)
app.get('/api/unsubscribe', (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).send(unsubscribeHTML('請提供有效的 Email 地址。', false));
  }

  try {
    const result = db.prepare('UPDATE subscribers SET active = 0 WHERE email = ? AND active = 1').run(decodeURIComponent(email));

    if (result.changes > 0) {
      res.send(unsubscribeHTML('您已成功取消訂閱 WCA 每日醫療新聞精選。', true));
    } else {
      res.send(unsubscribeHTML('此 Email 不在訂閱名單中。', false));
    }
  } catch (err) {
    console.error('Unsubscribe error:', err);
    res.status(500).send(unsubscribeHTML('取消訂閱時發生錯誤，請稍後再試。', false));
  }
});

function unsubscribeHTML(message, success) {
  return `
<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>取消訂閱 — WCA</title></head>
<body style="margin:0;padding:60px 20px;background:#FAFAF7;font-family:Arial,sans-serif;text-align:center;">
  <div style="max-width:480px;margin:0 auto;background:#FFF;padding:40px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <div style="font-size:24px;font-weight:700;color:#C8A359;letter-spacing:3px;margin-bottom:8px;">WCA</div>
    <div style="font-size:12px;color:#8C8C8C;margin-bottom:24px;">白袍加速器</div>
    <p style="font-size:16px;color:${success ? '#2D7D46' : '#B8860B'};font-weight:600;margin-bottom:12px;">${message}</p>
    <p style="font-size:14px;color:#5A5A5A;">若您改變心意，歡迎隨時重新訂閱。</p>
    <a href="${CONFIG.SITE_URL}" style="display:inline-block;margin-top:20px;padding:10px 24px;background:#09182B;color:#FFF;text-decoration:none;border-radius:8px;font-size:13px;">回到首頁</a>
  </div>
</body></html>`;
}

// Admin: Trigger newsletter manually
app.post('/api/admin/send-newsletter', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { date } = req.body;
    const result = await sendDailyNewsletter(date);
    res.json({ message: 'Newsletter sent', ...result });
  } catch (err) {
    console.error('Manual send error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: View subscribers
app.get('/api/admin/subscribers', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const subscribers = db.prepare('SELECT id, email, name, subscribed_at, active FROM subscribers ORDER BY subscribed_at DESC').all();
  const stats = {
    total: subscribers.length,
    active: subscribers.filter(s => s.active).length,
    inactive: subscribers.filter(s => !s.active).length,
  };

  res.json({ stats, subscribers });
});

// Admin: View send log
app.get('/api/admin/send-log', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const log = db.prepare('SELECT * FROM send_log ORDER BY sent_at DESC LIMIT 30').all();
  res.json({ log });
});

// ===== Helper: Get Chinese weekday =====
function getWeekday(dateStr) {
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return weekdays[d.getDay()];
}

// ===== Public Article Routes =====

// Get latest date's articles
app.get('/api/articles/latest', (req, res) => {
  try {
    const latest = db.prepare('SELECT DISTINCT date FROM articles ORDER BY date DESC LIMIT 1').get();

    if (!latest) {
      return res.json({ date: null, weekday: null, articles: [] });
    }

    const articles = db.prepare(
      'SELECT id, category, title, source_name, reading_time, body, wca_insight, original_url FROM articles WHERE date = ? ORDER BY id ASC'
    ).all(latest.date);

    res.json({ date: latest.date, weekday: getWeekday(latest.date), articles });
  } catch (err) {
    console.error('Get latest articles error:', err);
    res.status(500).json({ error: '取得文章時發生錯誤' });
  }
});

// Get all available dates with article summaries
app.get('/api/articles/dates', (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT date, category, title FROM articles ORDER BY date DESC, id ASC'
    ).all();

    const dateMap = new Map();
    for (const row of rows) {
      if (!dateMap.has(row.date)) {
        dateMap.set(row.date, []);
      }
      dateMap.get(row.date).push({ category: row.category, title: row.title });
    }

    const dates = [];
    for (const [date, articles] of dateMap) {
      dates.push({ date, weekday: getWeekday(date), articles });
    }

    res.json({ dates });
  } catch (err) {
    console.error('Get article dates error:', err);
    res.status(500).json({ error: '取得日期列表時發生錯誤' });
  }
});

// Get articles by date
app.get('/api/articles', (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({ error: '請提供 date 參數 (YYYY-MM-DD)' });
  }

  try {
    const articles = db.prepare(
      'SELECT id, category, title, source_name, reading_time, body, wca_insight, original_url FROM articles WHERE date = ? ORDER BY id ASC'
    ).all(date);

    res.json({ date, weekday: getWeekday(date), articles });
  } catch (err) {
    console.error('Get articles by date error:', err);
    res.status(500).json({ error: '取得文章時發生錯誤' });
  }
});

// ===== Admin Article Routes =====

// Admin: List all articles
app.get('/api/admin/articles', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { date } = req.query;
    let articles;
    if (date) {
      articles = db.prepare('SELECT * FROM articles WHERE date = ? ORDER BY id ASC').all(date);
    } else {
      articles = db.prepare('SELECT * FROM articles ORDER BY date DESC, id ASC').all();
    }
    res.json({ articles });
  } catch (err) {
    console.error('Admin list articles error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Create article
app.post('/api/admin/articles', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { date, category, title, source_name, reading_time, body, wca_insight, original_url } = req.body;

    if (!date || !category || !title || !source_name || !body || !wca_insight || !original_url) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }

    const result = db.prepare(`
      INSERT INTO articles (date, category, title, source_name, reading_time, body, wca_insight, original_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(date, category, title, source_name, reading_time || '4', body, wca_insight, original_url);

    res.json({ id: result.lastInsertRowid, message: '文章已建立' });
  } catch (err) {
    console.error('Admin create article error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Update article
app.put('/api/admin/articles/:id', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM articles WHERE id = ?').get(id);

    if (!existing) {
      return res.status(404).json({ error: '找不到該文章' });
    }

    const fields = ['date', 'category', 'title', 'source_name', 'reading_time', 'body', 'wca_insight', 'original_url'];
    const updates = [];
    const values = [];

    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '沒有提供要更新的欄位' });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    db.prepare(`UPDATE articles SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    res.json({ message: '文章已更新' });
  } catch (err) {
    console.error('Admin update article error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Delete article
app.delete('/api/admin/articles/:id', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM articles WHERE id = ?').run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: '找不到該文章' });
    }

    res.json({ message: '文章已刪除' });
  } catch (err) {
    console.error('Admin delete article error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Cron: Daily 8:00 AM Taiwan Time =====
cron.schedule('0 8 * * *', async () => {
  console.log('[CRON] Triggering daily newsletter at 8:00 AM (Asia/Taipei)...');
  try {
    await sendDailyNewsletter();
  } catch (err) {
    console.error('[CRON] Newsletter send failed:', err);
  }
}, {
  timezone: 'Asia/Taipei',
  scheduled: true,
});

// ===== Start =====
// Ensure data directory exists
import { mkdirSync } from 'fs';
try { mkdirSync(join(__dirname, 'data'), { recursive: true }); } catch {}

app.listen(PORT, () => {
  const subscriberCount = db.prepare('SELECT COUNT(*) as count FROM subscribers WHERE active = 1').get().count;
  console.log(`
╔══════════════════════════════════════════════╗
║   WCA Newsletter API Server                  ║
║   Port: ${PORT}                                  ║
║   Active subscribers: ${String(subscriberCount).padEnd(23)}║
║   Cron: Daily 8:00 AM (Asia/Taipei)         ║
╚══════════════════════════════════════════════╝
  `);
});
