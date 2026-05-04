/**
 * WCA Newsletter API Server
 *
 * 功能：
 * 1. 訂閱/取消訂閱 API
 * 2. 每日 06:00 (台灣時間) 自動盤點並補充 7 天文章庫存 via Anthropic API + Web Search
 * 3. 每日 08:00 (台灣時間) 自動寄送電子報 via Zeabur Mail
 * 4. 手動觸發寄送 / 庫存補充 API
 *
 * 環境變數：
 * - ZEABUR_MAIL_API_KEY: Zeabur Email API Key
 * - SENDER_EMAIL: 寄件者 email (需在 Zeabur Email 設定的域名下)
 * - SITE_URL: 網站網址 (用於電子報中的連結)
 * - ADMIN_SECRET: 管理 API 的密鑰
 * - ANTHROPIC_API_KEY: Anthropic API Key (用於自動產文)
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

// ===== Config =====
const CONFIG = {
  ZEABUR_MAIL_API_KEY: process.env.ZEABUR_MAIL_API_KEY || '',
  SENDER_EMAIL: process.env.SENDER_EMAIL || 'newsletter@yourdomain.com',
  SENDER_NAME: process.env.SENDER_NAME || 'WCA 白袍加速器',
  SITE_URL: process.env.SITE_URL || 'https://news.wca.tw',
  ADMIN_SECRET: process.env.ADMIN_SECRET || 'change-me-in-production',
  ZEABUR_MAIL_ENDPOINT: 'https://api.zeabur.com/api/v1/zsend/emails',
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
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
// Ensure data directory exists before opening DB
try { mkdirSync(join(__dirname, 'data'), { recursive: true }); } catch {}

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
    category TEXT NOT NULL CHECK(category IN ('clinic', 'talent', 'startup', 'casper_pick')),
    title TEXT NOT NULL,
    source_name TEXT NOT NULL,
    reading_time TEXT DEFAULT '4',
    body TEXT NOT NULL,
    wca_insight TEXT NOT NULL,
    original_url TEXT NOT NULL,
    published INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(date);
`);

// Migrate: add published column if not exists (for existing DBs)
try { db.exec('ALTER TABLE articles ADD COLUMN published INTEGER DEFAULT 0'); } catch {}

// Migrate: fix column order after casper_pick migration (published/created_at/updated_at were swapped)
try {
  const badRow = db.prepare("SELECT published FROM articles WHERE typeof(published) = 'text' AND published LIKE '%-%' LIMIT 1").get();
  if (badRow) {
    console.log('[MIGRATE] Fixing swapped columns from previous migration...');
    db.exec(`
      CREATE TABLE articles_fixed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('clinic', 'talent', 'startup', 'casper_pick')),
        title TEXT NOT NULL,
        source_name TEXT NOT NULL,
        reading_time TEXT DEFAULT '4',
        body TEXT NOT NULL,
        wca_insight TEXT NOT NULL,
        original_url TEXT NOT NULL,
        published INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO articles_fixed (id, date, category, title, source_name, reading_time, body, wca_insight, original_url, published, created_at, updated_at)
        SELECT id, date, category, title, source_name, reading_time, body, wca_insight, original_url,
          CASE
            WHEN typeof(published) = 'text' AND published LIKE '%-%' THEN 0
            ELSE COALESCE(published, 0)
          END,
          CASE
            WHEN typeof(published) = 'text' AND published LIKE '%-%' THEN published
            ELSE created_at
          END,
          CASE
            WHEN typeof(updated_at) = 'text' AND updated_at LIKE '%-%' THEN updated_at
            WHEN typeof(created_at) = 'text' AND created_at LIKE '%-%' THEN created_at
            ELSE CURRENT_TIMESTAMP
          END
        FROM articles;
      DROP TABLE articles;
      ALTER TABLE articles_fixed RENAME TO articles;
      CREATE INDEX IF NOT EXISTS idx_articles_date ON articles(date);
    `);
    console.log('[MIGRATE] Column order fixed successfully');
  }
  // Cleanup: fix any rows with non-datetime created_at or updated_at
  db.exec(`
    UPDATE articles SET created_at = updated_at WHERE length(CAST(created_at AS TEXT)) < 10;
    UPDATE articles SET updated_at = created_at WHERE length(CAST(updated_at AS TEXT)) < 10;
  `);
} catch (e) { console.error('Migration fix failed:', e.message); }

// Category sort order for SQL queries
const CAT_ORDER = `CASE category WHEN 'clinic' THEN 1 WHEN 'talent' THEN 2 WHEN 'startup' THEN 3 WHEN 'casper_pick' THEN 4 ELSE 5 END`;

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
function buildNewsletterHTML(date, articles) {
  const today = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const siteUrl = CONFIG.SITE_URL;
  const readMoreUrl = `${siteUrl}/news/?date=${today}`;

  const categoryLabels = { clinic: '診所經營管理', talent: '醫療領導人才', startup: '醫療科技新創', casper_pick: 'Casper 特別推薦' };
  const categorySvgs = {
    clinic: '<svg viewBox="3 2 18 24" width="14" height="16" style="vertical-align:-3px;margin-right:5px;" fill="none" stroke="#09182B" stroke-width="1.5"><path d="M12 3L4 7.5v5.5c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V7.5l-8-4.5z"/></svg>',
    talent: '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:5px;" fill="none" stroke="#09182B" stroke-width="1.8"><circle cx="12" cy="8" r="4.5"/><path d="M4 21v-2a7 7 0 0114 0v2"/></svg>',
    startup: '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:5px;" fill="none" stroke="#09182B" stroke-width="1.8"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    casper_pick: '<svg viewBox="0 0 24 24" width="14" height="14" style="vertical-align:-2px;margin-right:5px;" fill="none" stroke="#09182B" stroke-width="1.8"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>',
  };
  const articleNumbers = ['Article I', 'Article II', 'Article III'];

  // Build article cards HTML
  const articlesHtml = (articles || []).map((a, i) => {
    const label = categoryLabels[a.category] || a.category;
    const icon = categorySvgs[a.category] || '';

    // Extract first paragraph only for newsletter preview
    const firstPMatch = a.body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const firstParagraph = firstPMatch
      ? firstPMatch[1].replace(/<[^>]+>/g, '').trim()
      : a.body.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim().split('\n')[0];
    const preview = firstParagraph + '......<a href="' + readMoreUrl + '" style="color: #C8A359; text-decoration: underline;">去官網看完整摘要</a>';

    return `
      <!-- Article ${i + 1} -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#FFFFFF;">
        <tr>
          <td style="padding: 0 32px 8px;">
            ${i === 0 ? '' : '<div style="height: 1px; background: #E5E2DB; margin-bottom: 24px;"></div>'}
            <div style="display: inline-block; padding: 5px 14px; background: linear-gradient(135deg, #F0D695, #C8A359); color: #09182B; font-size: 12px; font-weight: 500; border-radius: 4px; letter-spacing: 0.5px;">
              ${icon}${label}
            </div>
            <div style="font-size: 11px; color: #8C8C8C; letter-spacing: 2px; margin-top: 12px;">— ${articleNumbers[i] || `Article ${i + 1}`} —</div>
            <h2 style="font-size: 18px; font-weight: 700; color: #09182B; line-height: 1.6; margin: 8px 0 12px;">${a.title}</h2>
            <div style="font-size: 12px; color: #8C8C8C; margin-bottom: 16px;">${a.source_name} ｜ ${today} ｜ 閱讀 ${a.reading_time} 分鐘</div>
            <p style="font-size: 14px; color: #5A5A5A; line-height: 1.9; margin: 0 0 16px;">${preview}</p>
            <div style="background: #FAFAF7; border-left: 3px solid #C8A359; padding: 16px 20px; border-radius: 0 8px 8px 0; margin-bottom: 24px;">
              <div style="font-size: 11px; color: #C8A359; font-weight: 600; letter-spacing: 1px; margin-bottom: 8px;">WCA INSIGHT</div>
              <p style="font-size: 13px; color: #5A5A5A; line-height: 1.8; margin: 0;">${a.wca_insight.length > 150 ? a.wca_insight.slice(0, 150) + '…' : a.wca_insight}</p>
            </div>
          </td>
        </tr>
      </table>`;
  }).join('\n');

  return `
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0; padding:0; background-color:#FAFAF7; font-family: 'Helvetica Neue', Arial, 'Noto Sans TC', sans-serif;">
  <table role="presentation" width="100%" style="background-color:#FAFAF7;">
    <tr><td align="center" style="padding: 20px 0;">

      <!-- Header -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#09182B; border-radius: 12px 12px 0 0;">
        <tr>
          <td style="padding: 28px 32px; text-align: center;">
            <img src="${siteUrl}/news/WCA_logo.png" alt="WCA" width="80" height="80" style="display: block; margin: 0 auto 8px; border-radius: 4px;" />
            <div style="font-size: 12px; color: rgba(255,255,255,0.55); letter-spacing: 2px; margin-top: 4px;">
              WCA 白袍加速器 — 每日醫療新聞精選
            </div>
            <div style="height: 2px; background: linear-gradient(90deg, transparent, #9E7D3D 30%, #F0D695 50%, #9E7D3D 70%, transparent); margin-top: 16px;"></div>
          </td>
        </tr>
      </table>

      <!-- Date Banner -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#FFFFFF;">
        <tr>
          <td style="padding: 28px 32px 12px; text-align: center;">
            <div style="font-size: 13px; color: #C8A359; letter-spacing: 3px; text-transform: uppercase;">Daily Medical Briefing</div>
            <div style="font-size: 22px; font-weight: 700; color: #09182B; margin-top: 8px;">${today}</div>
          </td>
        </tr>
      </table>

${articlesHtml}

      <!-- CTA: Read More on Website -->
      <table role="presentation" width="640" style="max-width:640px; background-color:#FFFFFF;">
        <tr>
          <td style="padding: 8px 32px 32px; text-align: center;">
            <div style="height: 1px; background: #E5E2DB; margin-bottom: 28px;"></div>
            <p style="font-size: 14px; color: #5A5A5A; margin-bottom: 20px;">
              閱讀完整報導、WCA 獨家洞察與更多歷史日報 →
            </p>
            <a href="${readMoreUrl}"
               style="display: inline-block; padding: 14px 36px; background: linear-gradient(135deg, #C8A359, #9E7D3D); color: #FFFFFF; text-decoration: none; font-size: 15px; font-weight: 600; border-radius: 8px; letter-spacing: 1px;">
              前往網站閱讀完整版
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
              <a href="${siteUrl}/api/unsubscribe?email={{EMAIL}}" style="color: #C8A359; text-decoration: underline;">取消訂閱</a>
            </div>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</body>
</html>`;
}

// ===== Helper: Send newsletter to subscribers =====
// If `emails` is provided, only send to those emails; otherwise send to all active subscribers
async function sendDailyNewsletter(date, emails) {
  const today = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });

  let subscribers;
  if (emails && emails.length > 0) {
    // Send to specific emails only
    const placeholders = emails.map(() => '?').join(',');
    subscribers = db.prepare(`SELECT email, name FROM subscribers WHERE email IN (${placeholders})`).all(...emails);
    // Also allow sending to emails not in subscriber list (for testing)
    const existingEmails = new Set(subscribers.map(s => s.email));
    emails.forEach(e => {
      if (!existingEmails.has(e)) subscribers.push({ email: e, name: '' });
    });
  } else {
    subscribers = db.prepare('SELECT email, name FROM subscribers WHERE active = 1 AND confirmed = 1').all();
  }

  if (subscribers.length === 0) {
    console.log(`[${today}] No recipients. Skipping.`);
    return { sent: 0, message: 'No recipients' };
  }

  // Fetch today's articles from DB
  const articles = db.prepare(`SELECT * FROM articles WHERE date = ? ORDER BY ${CAT_ORDER}`).all(today);
  if (articles.length === 0) {
    console.log(`[${today}] No articles found for today. Skipping.`);
    return { sent: 0, message: 'No articles for today' };
  }

  const subject = `WCA 每日醫療精選 — ${today}`;
  const htmlTemplate = buildNewsletterHTML(today, articles);

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
    const { date, emails } = req.body;
    const result = await sendDailyNewsletter(date, emails);
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
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const latest = db.prepare('SELECT DISTINCT date FROM articles WHERE date <= ? ORDER BY date DESC LIMIT 1').get(today);

    if (!latest) {
      return res.json({ date: null, weekday: null, articles: [] });
    }

    const articles = db.prepare(
      `SELECT id, category, title, source_name, reading_time, body, wca_insight, original_url FROM articles WHERE date = ? ORDER BY ${CAT_ORDER}`
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
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const rows = db.prepare(
      `SELECT date, category, title FROM articles WHERE date <= ? ORDER BY date DESC, ${CAT_ORDER}`
    ).all(today);

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
      `SELECT id, category, title, source_name, reading_time, body, wca_insight, original_url FROM articles WHERE date = ? ORDER BY ${CAT_ORDER}`
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
      articles = db.prepare(`SELECT * FROM articles WHERE date = ? ORDER BY ${CAT_ORDER}`).all(date);
    } else {
      articles = db.prepare(`SELECT * FROM articles ORDER BY date DESC, ${CAT_ORDER}`).all();
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

// Admin: Toggle article publish status
app.put('/api/admin/articles/:id/publish', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { id } = req.params;
    const article = db.prepare('SELECT id, published FROM articles WHERE id = ?').get(id);
    if (!article) return res.status(404).json({ error: '找不到該文章' });

    const newStatus = article.published ? 0 : 1;
    db.prepare('UPDATE articles SET published = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, id);
    res.json({ message: newStatus ? '文章已上稿' : '文章已取消上稿', published: newStatus });
  } catch (err) {
    console.error('Admin publish article error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Admin: Generate article from URL via AI =====
app.post('/api/admin/generate-article', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { url, category } = req.body;
  if (!url) return res.status(400).json({ error: '請提供 URL' });
  if (!CONFIG.ANTHROPIC_API_KEY) return res.status(500).json({ error: '尚未設定 ANTHROPIC_API_KEY' });

  try {
    // 1. Fetch URL content
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const pageRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WCA-Bot/1.0)' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const html = await pageRes.text();

    // Simple text extraction
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12000);

    // 2. Call Anthropic API
    const categoryLabel = { clinic: '診所經營管理', talent: '醫療領導人才', startup: '醫療科技新創', casper_pick: 'Casper 特別推薦' }[category] || category;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CONFIG.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `你是 WCA 白袍加速器的醫療新聞編輯。請根據以下英文原文，產生結構化的繁體中文新聞摘要。

分類：${categoryLabel}
原文 URL：${url}
原文內容：
${text}

請以 JSON 格式回覆，包含以下欄位：
- title: 繁體中文標題，吸引醫療經營者，具體且有數據感（例：「Cedar 研究揭示：診所 77% 的應收款正滑向難以回收的深淵」），不超過 40 字
- source_name: 原始來源媒體名稱（英文）
- reading_time: 預估閱讀分鐘數（字串，通常 "4" 或 "5"）
- body: 繁體中文摘要，800-1200 字，HTML 格式（使用 <p> 和 <br> 標籤）。須包含：事件背景與核心發現、3-4 個關鍵數據點（用 <strong> 加粗）、對產業的影響分析
- wca_insight: WCA 獨家洞察，200-400 字，純文字（不要 HTML）。角度必須是「這對台灣的診所經營者/醫師創業者意味著什麼」，給出具體可行的建議。語氣專業但有溫度，像一個資深顧問在跟學員分享觀點。

只回覆 JSON，不要加任何前綴、說明或 markdown 包裹。`
        }]
      }),
    });

    const claudeData = await claudeRes.json();
    if (!claudeRes.ok) throw new Error(claudeData.error?.message || 'Anthropic API error');

    const content = claudeData.content[0].text;
    // Parse JSON - handle potential markdown code blocks
    const jsonStr = content.replace(/^```json?\s*/i, '').replace(/\s*```\s*$/,'').trim();
    const generated = JSON.parse(jsonStr);

    res.json({ generated });
  } catch (err) {
    console.error('Generate article error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ===== Auto Article Inventory =====

function getTaipeiDate(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

function getArticleInventory() {
  const categories = ['clinic', 'talent', 'startup'];
  const missing = [];
  for (let i = 0; i < 7; i++) {
    const date = getTaipeiDate(i);
    const existing = db.prepare('SELECT category FROM articles WHERE date = ?').all(date).map(r => r.category);
    for (const cat of categories) {
      if (!existing.includes(cat)) {
        missing.push({ date, category: cat });
      }
    }
  }
  return missing;
}

const CATEGORY_SEARCH = {
  clinic: {
    label: '診所經營管理',
    queries: [
      'clinic management healthcare practice operations 2026',
      'healthcare revenue cycle patient experience ambulatory care 2026',
    ],
  },
  talent: {
    label: '醫療領導人才',
    queries: [
      'healthcare leadership physician executive workforce 2026',
      'hospital CEO medical director healthcare talent 2026',
    ],
  },
  startup: {
    label: '醫療科技新創',
    queries: [
      'health tech startup digital health funding 2026',
      'healthcare AI startup medtech innovation funding 2026',
    ],
  },
};

// Helper: extract key terms (company names, dollar amounts) from a title for dedup matching
function extractKeyTerms(title) {
  const terms = new Set();
  // Extract English company/brand names (2+ chars)
  const engMatches = title.match(/[A-Z][A-Za-z0-9.]+(?:\s[A-Z][A-Za-z0-9.]+)*/g);
  if (engMatches) engMatches.forEach(m => terms.add(m.toLowerCase()));
  // Extract dollar amounts like "$4B", "40億", "1.25億", "1,600萬"
  const moneyMatches = title.match(/[\d,.]+\s*[億萬]/g);
  if (moneyMatches) moneyMatches.forEach(m => terms.add(m.replace(/\s/g, '')));
  return [...terms];
}

// Helper: check if a generated article duplicates existing articles
function isDuplicateArticle(newArticle, existingArticles) {
  const newUrl = (newArticle.original_url || '').toLowerCase();
  const newTitle = (newArticle.title || '').toLowerCase();
  const newTerms = extractKeyTerms(newArticle.title || '');

  for (const existing of existingArticles) {
    const exUrl = (existing.original_url || '').toLowerCase();
    const exTitle = (existing.title || '').toLowerCase();
    const exTerms = extractKeyTerms(existing.title || '');

    // 1. Exact URL match (ignore trailing slashes / query params)
    const normalizeUrl = u => u.replace(/\/+$/, '').split('?')[0];
    if (newUrl && exUrl && normalizeUrl(newUrl) === normalizeUrl(exUrl)) {
      console.log(`[DEDUP] URL match: ${newUrl}`);
      return true;
    }

    // 2. Same URL domain+path prefix (same article, different tracking params)
    try {
      const newParsed = new URL(newUrl);
      const exParsed = new URL(exUrl);
      if (newParsed.hostname === exParsed.hostname && newParsed.pathname === exParsed.pathname) {
        console.log(`[DEDUP] Same domain+path: ${newParsed.hostname}${newParsed.pathname}`);
        return true;
      }
    } catch {}

    // 3. Key term overlap: if 2+ significant terms match, likely same story
    if (newTerms.length > 0 && exTerms.length > 0) {
      const overlap = newTerms.filter(t => exTerms.some(et => et.includes(t) || t.includes(et)));
      if (overlap.length >= 2) {
        console.log(`[DEDUP] Key term overlap (${overlap.join(', ')}): "${newArticle.title}" vs "${existing.title}"`);
        return true;
      }
    }

    // 4. High title similarity (> 50% character overlap for Chinese titles)
    if (newTitle.length > 10 && exTitle.length > 10) {
      const newChars = new Set([...newTitle]);
      const exChars = new Set([...exTitle]);
      const intersection = [...newChars].filter(c => exChars.has(c)).length;
      const similarity = intersection / Math.min(newChars.size, exChars.size);
      if (similarity > 0.7) {
        console.log(`[DEDUP] Title similarity ${(similarity * 100).toFixed(0)}%: "${newArticle.title}" vs "${existing.title}"`);
        return true;
      }
    }
  }
  return false;
}

async function generateArticleWithAI(date, category, retryCount = 0) {
  const catInfo = CATEGORY_SEARCH[category];
  if (!catInfo) throw new Error(`Unknown category: ${category}`);

  const query = catInfo.queries[Math.floor(Math.random() * catInfo.queries.length)];

  // Fetch recent articles to avoid duplicates — use 60 for broader coverage
  const recentArticles = db.prepare(
    'SELECT title, original_url, source_name FROM articles WHERE category = ? ORDER BY date DESC LIMIT 60'
  ).all(category);
  const usedList = recentArticles.map(a => `- ${a.title} (${a.source_name}) ${a.original_url}`).join('\n');

  // Extract banned topics/companies from recent articles for explicit exclusion
  const allTerms = new Set();
  recentArticles.forEach(a => extractKeyTerms(a.title).forEach(t => allTerms.add(t)));
  const bannedTopics = [...allTerms].filter(t => t.length > 2).slice(0, 50).join(', ');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{
        role: 'user',
        content: `你是 WCA 白袍加速器的每日醫療新聞編輯。

請搜尋以下關鍵字，找到一則近期（7天內）的可信英文醫療新聞：
搜尋關鍵字：${query}

可信來源包括：Fierce Healthcare, STAT News, Healthcare Dive, Modern Healthcare, Becker's Hospital Review, TechCrunch Health, MedCity News, Axios Health, HIMSS, KFF Health News 等。
選擇對台灣醫療經營者有參考價值的新聞。

找到新聞後，請根據原文撰寫以下 JSON 結構的繁體中文文章：

{
  "title": "繁體中文標題，吸引醫療經營者，具體且有數據感，不超過 50 字",
  "source_name": "原始來源名稱，如 Fierce Healthcare",
  "reading_time": "4",
  "body": "繁體中文摘要，800-1200字，HTML格式用<p>標籤。須包含：事件背景與核心發現、3-4個關鍵數據點（用<strong>加粗）、對產業的影響分析",
  "wca_insight": "WCA獨家洞察，200-400字純文字。角度：這對台灣的診所經營者/醫師創業者意味著什麼，給出具體可行的建議。語氣專業但有溫度。",
  "original_url": "原始英文新聞URL"
}

分類：${catInfo.label}
目標日期：${date}

===== 嚴格禁止重複 =====
以下是過去已使用過的文章，你必須選擇一則「完全不同的新聞事件」。
不同的意思是：不同的公司、不同的事件、不同的報告。
即使是同一事件被不同媒體報導，也算重複，不可使用。

已使用文章清單：
${usedList}

已使用過的公司/主題關鍵字（全部禁止再用）：
${bannedTopics}

重要：
- 只回覆 JSON，不要加任何前綴、說明或 markdown 包裹
- original_url 必須是你搜尋到的真實 URL
- 必須是上方清單中「從未出現過」的公司和新聞事件
- 如果搜尋結果都是已使用過的主題，請換一組搜尋關鍵字重新搜尋
- body 使用 <p> 標籤分段，關鍵數據用 <strong> 加粗
- wca_insight 不要用 HTML，純文字即可`,
      }],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `API error ${response.status}`);

  // Extract JSON from response — Claude may return multiple text blocks with
  // thinking/explanation text mixed in. Find the block containing valid JSON.
  const textBlocks = data.content.filter(b => b.type === 'text');
  if (textBlocks.length === 0) throw new Error('No text response from Claude');

  let article = null;

  for (const block of textBlocks) {
    const cleaned = block.text.replace(/^```json?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    // Try to find a JSON object in the text
    const jsonMatch = cleaned.match(/\{[\s\S]*"title"[\s\S]*"original_url"[\s\S]*\}/);
    if (jsonMatch) {
      try { article = JSON.parse(jsonMatch[0]); break; } catch { /* try next block */ }
    }
    // Also try parsing the whole block
    try { article = JSON.parse(cleaned); break; } catch { /* try next block */ }
  }

  if (!article) {
    // Last resort: concatenate all text and try to extract JSON
    const allText = textBlocks.map(b => b.text).join('\n');
    const lastMatch = allText.match(/\{[\s\S]*"title"[\s\S]*"original_url"[\s\S]*\}/);
    if (lastMatch) {
      article = JSON.parse(lastMatch[0]);
    }
  }

  if (!article) {
    throw new Error('Could not extract JSON from Claude response');
  }

  // Post-generation duplicate check — retry up to 2 times if duplicate detected
  if (isDuplicateArticle(article, recentArticles)) {
    if (retryCount < 2) {
      console.log(`[DEDUP] Duplicate detected for "${article.title}", retrying (attempt ${retryCount + 2}/3)...`);
      await new Promise(r => setTimeout(r, 2000));
      return generateArticleWithAI(date, category, retryCount + 1);
    }
    console.warn(`[DEDUP] Still duplicate after 3 attempts: "${article.title}" — inserting anyway to avoid missing date`);
  }

  return article;
}

async function replenishInventory() {
  if (!CONFIG.ANTHROPIC_API_KEY) {
    console.log('[INVENTORY] Skipped: ANTHROPIC_API_KEY not set');
    return;
  }

  const missing = getArticleInventory();
  if (missing.length === 0) {
    console.log('[INVENTORY] All 7 days fully stocked');
    return;
  }

  console.log(`[INVENTORY] Missing ${missing.length} articles, generating...`);

  const insertStmt = db.prepare(
    'INSERT INTO articles (date, category, title, source_name, reading_time, body, wca_insight, original_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  let success = 0;
  let failed = 0;

  for (const { date, category } of missing) {
    try {
      console.log(`[INVENTORY] Generating ${category} for ${date}...`);
      const article = await generateArticleWithAI(date, category);
      insertStmt.run(date, category, article.title, article.source_name, article.reading_time || '4', article.body, article.wca_insight, article.original_url);
      success++;
      console.log(`[INVENTORY] ✓ ${date} ${category}: ${article.title.slice(0, 30)}...`);
      // Small delay between API calls
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      failed++;
      console.error(`[INVENTORY] ✗ ${date} ${category}: ${err.message}`);
    }
  }

  console.log(`[INVENTORY] Done: ${success} created, ${failed} failed`);
}

// Admin: Trigger inventory replenish manually
app.post('/api/admin/replenish', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const missing = getArticleInventory();
    if (missing.length === 0) {
      return res.json({ message: '庫存充足，無需補充', missing: 0 });
    }
    // Run in background, respond immediately
    res.json({ message: `開始補充 ${missing.length} 篇文章`, missing: missing.length });
    await replenishInventory();
  } catch (err) {
    console.error('Replenish error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Admin: Check inventory status
app.get('/api/admin/inventory', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CONFIG.ADMIN_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const categories = ['clinic', 'talent', 'startup'];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = getTaipeiDate(i);
    const articles = db.prepare('SELECT category, title FROM articles WHERE date = ?').all(date);
    const missingCats = categories.filter(c => !articles.find(a => a.category === c));
    days.push({ date, articles: articles.length, missing: missingCats });
  }

  const totalMissing = days.reduce((sum, d) => sum + d.missing.length, 0);
  res.json({ totalMissing, days });
});

// ===== Cron: Daily 6:00 AM — Auto Replenish Inventory =====
cron.schedule('0 6 * * *', async () => {
  console.log('[CRON] Triggering inventory replenish at 6:00 AM (Asia/Taipei)...');
  try {
    await replenishInventory();
  } catch (err) {
    console.error('[CRON] Inventory replenish failed:', err);
  }
}, {
  timezone: 'Asia/Taipei',
  scheduled: true,
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

app.listen(PORT, () => {
  const subscriberCount = db.prepare('SELECT COUNT(*) as count FROM subscribers WHERE active = 1').get().count;
  console.log(`
╔══════════════════════════════════════════════╗
║   WCA Newsletter API Server                  ║
║   Port: ${PORT}                                  ║
║   Active subscribers: ${String(subscriberCount).padEnd(23)}║
║   Cron: 6AM inventory, 8AM newsletter        ║
╚══════════════════════════════════════════════╝
  `);
});
