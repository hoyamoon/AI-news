import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs/promises';
import path from 'path';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const RSS_FEEDS = {
  ai: [
    'https://feeds.feedburner.com/oreilly/radar',
    'https://www.artificialintelligence-news.com/feed/',
    'https://techcrunch.com/category/artificial-intelligence/feed/',
  ],
  automation: [
    'https://zapier.com/blog/feed/',
    'https://www.automationworld.com/rss.xml',
  ],
  notion: [
    'https://www.notion.so/blog/rss.xml',
  ],
};

const parser = new XMLParser({ ignoreAttributes: false });

async function fetchRSS(url) {
  try {
    const res = await fetch(url, { timeout: 10000 });
    const xml = await res.text();
    const data = parser.parse(xml);
    const channel = data?.rss?.channel || data?.feed;
    const items = channel?.item || channel?.entry || [];
    return Array.isArray(items) ? items : [items];
  } catch (e) {
    console.warn('[SKIP] ' + url + ' - ' + e.message);
    return [];
  }
}

function extractItem(item) {
  const title = item.title?.['#text'] || item.title || '';
  const link = item.link?.href || item.link || item.guid?.['#text'] || item.guid || '';
  const pubDate = item.pubDate || item.published || item.updated || '';
  const description = item.description?.['#text'] || item.description || item.summary?.['#text'] || item.summary || '';
  return {
    title: String(title).trim(),
    link: String(link).trim(),
    pubDate: String(pubDate).trim(),
    description: String(description).replace(/<[^>]+>/g, '').trim().slice(0, 300),
  };
}

async function summarizeKorean(title, description) {
  if (!OPENAI_API_KEY) return description || title;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'IT 뉴스를 한국어로 2~3문장으로 핵심만 요약하세요.' },
          { role: 'user', content: '제목: ' + title + '\n내용: ' + description },
        ],
        max_tokens: 200,
        temperature: 0.5,
      }),
    });
    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || description || title;
  } catch (e) {
    console.warn('[GPT Error]', e.message);
    return description || title;
  }
}

async function buildCategory(category, urls) {
  console.log('[BUILD] ' + category + ' 수집 시작...');
  const allItems = [];
  for (const url of urls) {
    const items = await fetchRSS(url);
    for (const raw of items.slice(0, 5)) {
      const item = extractItem(raw);
      if (!item.title || !item.link) continue;
      allItems.push(item);
    }
  }
  const seen = new Set();
  const unique = allItems.filter(item => {
    if (seen.has(item.link)) return false;
    seen.add(item.link);
    return true;
  });
  const top10 = unique.slice(0, 10);
  console.log('[GPT] ' + category + ' 요약 중... ' + top10.length + '개');
  const results = [];
  for (const item of top10) {
    const summary = await summarizeKorean(item.title, item.description);
    results.push({ title: item.title, link: item.link, pubDate: item.pubDate, summary });
  }
  await fs.mkdir('data', { recursive: true });
  const outPath = path.join('data', category + '.json');
  await fs.writeFile(outPath, JSON.stringify({ updatedAt: new Date().toISOString(), items: results }, null, 2), 'utf-8');
  console.log('[DONE] ' + outPath + ' 저장 완료 (' + results.length + '개)');
}

async function main() {
  console.log('=== AI News Builder 시작 ===');
  for (const [category, urls] of Object.entries(RSS_FEEDS)) {
    await buildCategory(category, urls);
  }
  console.log('=== 전체 완료 ===');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
