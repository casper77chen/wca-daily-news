/**
 * Migration Script: Extract articles from existing HTML files and POST to the API.
 *
 * Usage:
 *   API_BASE=https://wca-news-api.zeabur.app ADMIN_SECRET=xxx node migrate-articles.js
 *
 * Defaults:
 *   API_BASE  = https://wca-news-api.zeabur.app
 *   ADMIN_SECRET = change-me-in-production
 */

import { readFileSync } from 'fs';
import { basename } from 'path';

const API_BASE = (process.env.API_BASE || 'https://wca-news-api.zeabur.app').replace(/\/+$/, '');
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-me-in-production';

// ===== HTML files to migrate =====
const FILES = [
  { path: new URL('../news/index.html', import.meta.url).pathname, date: '2026-04-06' },
  { path: new URL('../news/archive/2026-04-05.html', import.meta.url).pathname, date: '2026-04-05' },
  { path: new URL('../news/archive/2026-04-04.html', import.meta.url).pathname, date: '2026-04-04' },
  { path: new URL('../news/archive/2026-04-03.html', import.meta.url).pathname, date: '2026-04-03' },
  { path: new URL('../news/archive/2026-04-02.html', import.meta.url).pathname, date: '2026-04-02' },
  { path: new URL('../news/archive/2026-04-01.html', import.meta.url).pathname, date: '2026-04-01' },
  { path: new URL('../news/archive/2026-03-31.html', import.meta.url).pathname, date: '2026-03-31' },
];

// ===== Parse articles from a single HTML string =====
function parseArticles(html, date) {
  const articles = [];

  // Split by <article ...> tags (supports both with and without data-category)
  const cardRegex = /<article\s+class="news-card"[^>]*>([\s\S]*?)<\/article>/g;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const cardHtml = match[1];

    // Extract category from data-category attribute or from tag--{category} class
    const dataCatMatch = match[0].match(/data-category="(clinic|talent|startup)"/);
    const tagCatMatch = cardHtml.match(/tag--(clinic|talent|startup)/);
    const category = dataCatMatch ? dataCatMatch[1] : (tagCatMatch ? tagCatMatch[1] : null);
    if (!category) continue;

    // Title
    const titleMatch = cardHtml.match(/<h2\s+class="news-title">([\s\S]*?)<\/h2>/);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Source name
    const sourceMatch = cardHtml.match(/<span\s+class="source-name">([\s\S]*?)<\/span>/);
    const source_name = sourceMatch ? sourceMatch[1].trim() : '';

    // Reading time (extract the number)
    const readingTimeMatch = cardHtml.match(/閱讀\s*(\d+)\s*分鐘/);
    const reading_time = readingTimeMatch ? readingTimeMatch[1] : '4';

    // Body (inner HTML of news-body div)
    const bodyMatch = cardHtml.match(/<div\s+class="news-body">([\s\S]*?)<\/div>\s*(?:<div\s+class="wca-insight"|<div\s+class="section-label">)/);
    let body = '';
    if (bodyMatch) {
      body = bodyMatch[1].trim();
    } else {
      // Fallback: try a simpler match
      const bodyFallback = cardHtml.match(/<div\s+class="news-body">([\s\S]*?)<\/div>/);
      body = bodyFallback ? bodyFallback[1].trim() : '';
    }

    // WCA Insight (inner HTML of wca-insight__body div)
    const insightMatch = cardHtml.match(/<div\s+class="wca-insight__body">([\s\S]*?)<\/div>/);
    const wca_insight = insightMatch ? insightMatch[1].trim() : '';

    // Original URL
    const urlMatch = cardHtml.match(/<a\s+href="([^"]+)"[^>]*class="read-original"/);
    const original_url = urlMatch ? urlMatch[1] : '';

    if (!title || !body) {
      console.warn(`  [WARN] Skipping article with missing title or body in ${date}`);
      continue;
    }

    articles.push({
      date,
      category,
      title,
      source_name,
      reading_time,
      body,
      wca_insight,
      original_url,
    });
  }

  return articles;
}

// ===== POST a single article to the API =====
async function postArticle(article) {
  const res = await fetch(`${API_BASE}/api/admin/articles`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_SECRET}`,
    },
    body: JSON.stringify(article),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  return res.json();
}

// ===== Main =====
async function main() {
  console.log(`Migrating articles to ${API_BASE}`);
  console.log(`Files to process: ${FILES.length}\n`);

  let totalInserted = 0;
  let totalErrors = 0;

  for (const { path, date } of FILES) {
    process.stdout.write(`Migrating ${date}...`);

    let html;
    try {
      html = readFileSync(path, 'utf-8');
    } catch (err) {
      console.log(` SKIP (file not found: ${path})`);
      continue;
    }

    const articles = parseArticles(html, date);

    if (articles.length === 0) {
      console.log(' 0 articles found');
      continue;
    }

    let inserted = 0;
    let errors = 0;

    for (const article of articles) {
      try {
        await postArticle(article);
        inserted++;
      } catch (err) {
        errors++;
        console.error(`\n  [ERROR] "${article.title.slice(0, 40)}...": ${err.message}`);
      }
    }

    console.log(` ${inserted} articles inserted${errors > 0 ? `, ${errors} errors` : ''}`);
    totalInserted += inserted;
    totalErrors += errors;
  }

  console.log(`\nDone. Total: ${totalInserted} inserted, ${totalErrors} errors.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
