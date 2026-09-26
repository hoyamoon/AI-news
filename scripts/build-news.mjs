import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import RSSParser from "rss-parser";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_ITEMS_PER_TAB = 60;
const SUMMARIZE_TOP_N = 25;

const SOURCES = {
        ai: [
              { name: "Google AI Blog", urls: ["https://blog.google/technology/ai/rss/", "https://ai.googleblog.com/feeds/posts/default"] },
              { name: "Hacker News (LLM)", urls: ["https://hnrss.org/newest?q=GPT+Claude+Gemini+NotebookLM+agent+RAG", "https://hnrss.org/frontpage"] },
              { name: "Reddit r/MachineLearning", urls: ["https://www.reddit.com/r/MachineLearning/.rss", "https://www.reddit.com/r/MachineLearning/new/.rss", "https://www.reddit.com/r/MachineLearning/top/.rss?t=week"], headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-news-bot/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" } },
              { name: "MIT News AI", urls: ["https://news.mit.edu/topic/mitartificial-intelligence2-rss.xml"] },
              { name: "The Verge AI", urls: ["https://www.theverge.com/rss/ai-artificial-intelligence/index.xml"] }
                ],
        automation: [
              { name: "Hacker News (Automation)", urls: ["https://hnrss.org/newest?q=make.com+n8n+zapier+automation+workflow+opal", "https://hnrss.org/newest?q=automation+workflow+no-code"] },
              { name: "Reddit r/n8n", urls: ["https://www.reddit.com/r/n8n/.rss", "https://www.reddit.com/r/n8n/new/.rss", "https://www.reddit.com/r/n8n/top/.rss?t=week"], headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-news-bot/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" } },
              { name: "Reddit r/automation", urls: ["https://www.reddit.com/r/automation/.rss", "https://www.reddit.com/r/automation/new/.rss"], headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-news-bot/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" } },
              { name: "Dev.to Automation", urls: ["https://dev.to/feed/tag/automation"] },
              { name: "Dev.to n8n", urls: ["https://dev.to/feed/tag/n8n"] }
                ],
        notion: [
              // Notion은 공식 블로그 RSS가 없어(구 blog/rss 3종 모두 404) 공식 릴리스 노트 Atom 피드를 사용
              { name: "Notion Releases", urls: ["https://www.notion.com/releases/rss.xml"] },
              { name: "Reddit r/Notion", urls: ["https://www.reddit.com/r/Notion/.rss", "https://www.reddit.com/r/Notion/new/.rss", "https://www.reddit.com/r/Notion/top/.rss?t=week"], headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-news-bot/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" } },
              { name: "Dev.to Notion", urls: ["https://dev.to/feed/tag/notion"] }
                ]
};

const RULES = [
      { bucket:"llm", tag:"GPT/OpenAI", w:40, k:["gpt","openai","chatgpt","gpt-4","gpt-5","responses api","assistants api"] },
      { bucket:"llm", tag:"Claude/Anthropic", w:40, k:["claude","anthropic"] },
      { bucket:"llm", tag:"Gemini/Google", w:35, k:["gemini","google ai","deepmind","vertex ai"] },
      { bucket:"agents", tag:"Agents", w:24, k:["agent","agentic","tool use","function calling","mcp","model context protocol","langgraph","autogen","crewai"] },
      { bucket:"rag", tag:"RAG/Vector", w:20, k:["rag","retrieval","vector","embedding","semantic search","rerank","pinecone","weaviate","milvus","qdrant"] },
      { bucket:"eval", tag:"Eval/Observability", w:18, k:["eval","evaluation","observability","tracing","langfuse","helicone","ragas","wandb"] },
      { bucket:"multimodal", tag:"Multimodal", w:16, k:["multimodal","vision","image generation","video generation","runway","pika","midjourney","sora"] },
      { bucket:"prod", tag:"NotebookLM", w:22, k:["notebooklm","notebook lm","notebooklm plus","workspace updates","sources","studio"] },
      { bucket:"make", tag:"Make", w:24, k:["make.com","integromat","scenario","iterator"] },
      { bucket:"n8n", tag:"n8n", w:24, k:["n8n","n8n node","n8n workflow"] },
      { bucket:"zapier", tag:"Zapier", w:20, k:["zapier","zap","zaps"] },
      { bucket:"opal", tag:"Google Opal", w:20, k:["google opal","opal no-code","opal ai","opal"] },
      { bucket:"update", tag:"Notion Update", w:22, k:["notion update","release notes","what's new","database view","formula"] },
      { bucket:"status", tag:"Notion Status", w:20, k:["notion status","incident","outage","downtime","degraded"] },
      { bucket:"creators", tag:"Creators", w:18, k:["template","creator","marketplace","notion creators"] },
      { bucket:"hot", tag:"Hot", w:20, k:["security","vulnerability","cve","rce","breach","leak","policy","pricing","rate limit","outage","incident","lawsuit"] },
      { bucket:"hot", tag:"Release", w:10, k:["release","launch","update","beta","preview","ga"] },
      ];

const SOURCE_HEALTH_LOG = {};

function nowISO() { return new Date().toISOString(); }
function lower(x) { return (x ?? "").toString().toLowerCase(); }
function hoursAgo(iso) { return (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dedupe(items) {
        const seen = new Set();
        return items.filter(it => {
                  const key = it.url || it.title;
                  if (!key || seen.has(key)) return false;
                  seen.add(key);
                  return true;
        });
}

function scoreAndClassify(item) {
        const text = lower(item.title) + " " + lower(item.source) + " " + lower(item.url) + " " + lower(item.content);
        let score = 0;
        const tags = new Set();
        const buckets = new Set();
        for (const r of RULES) {
                  if (r.k.some(k => text.includes(lower(k)))) {
                              score += r.w;
                              tags.add(r.tag);
                              buckets.add(r.bucket);
                  }
        }
        const h = item.published_at ? hoursAgo(item.published_at) : 999;
        if (h <= 24) score += 25;
        else if (h <= 72) score += 12;
        return { ...item, score, tags: [...tags], buckets: [...buckets] };
}

const FEED_TIMEOUT_MS = 15000;
const RATE_LIMIT_WAIT_MS = 5000;
const RATE_LIMIT_MAX_WAIT_MS = 15000;
const feedParser = new RSSParser();

// rss-parser.parseURL은 3xx+/타임아웃 시 응답을 소비·파기하지 않아 소켓이 남고 프로세스가 종료되지 않는다.
// fetch로 직접 받아 타임아웃(헤더+본문 전체)을 걸고, 실패 시 본문을 반드시 취소해 소켓을 정리한다.
async function fetchFeedXml(url, headers, timeoutMs = FEED_TIMEOUT_MS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(new Error("Request timed out after " + timeoutMs + "ms")), timeoutMs);
        let res;
        try {
                  res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
                  if (!res.ok) {
                              const err = new Error("Status code " + res.status);
                              err.statusCode = res.status;
                              err.retryAfter = res.headers.get("retry-after");
                              throw err;
                  }
                  return await res.text();
        } finally {
                  clearTimeout(timeoutId);
                  if (res?.body && !res.bodyUsed) await res.body.cancel().catch(() => {});
        }
}

function rateLimitWaitMs(retryAfter, defaultMs) {
        const sec = Number(retryAfter);
        if (!Number.isFinite(sec) || sec <= 0) return defaultMs;
        return Math.min(sec * 1000, RATE_LIMIT_MAX_WAIT_MS);
}

async function fetchFeedWithFallback(src, { timeoutMs = FEED_TIMEOUT_MS, rateLimitWait = RATE_LIMIT_WAIT_MS } = {}) {
        const urls = src.urls || [src.url];
        const extraHeaders = src.headers || {};

  for (const url of urls) {
            try {
                        console.log("  [CHECK] " + src.name + " -> " + url);
                        const xml = await fetchFeedXml(url, {
                                      "User-Agent": "Mozilla/5.0 (compatible; AI-news-bot/1.0; +https://github.com/hoyamoon/AI-news)",
                                      "Accept": "application/rss+xml, application/xml, text/xml, */*",
                                      ...extraHeaders
                        }, timeoutMs);
                        const feed = await feedParser.parseString(xml);
                        const items = (feed.items || []).map(it => ({
                                      title: (it.title || "").toString(),
                                      url: (it.link || "").toString(),
                                      source: src.name,
                                      published_at: it.isoDate || it.pubDate || nowISO(),
                                      content: (it.contentSnippet || it.content || "").toString(),
                                      summary_ko: "",
                                      tags: [],
                                      buckets: [],
                                      score: 0
                        }));
                        if (items.length > 0) {
                                      SOURCE_HEALTH_LOG[src.name] = { status: "ok", url, fetchedAt: nowISO() };
                                      console.log("  [OK] " + src.name + ": " + items.length + "ê° (" + url + ")");
                                      return items;
                        }
                        console.log("  [WARN] " + src.name + ": í­ëª©ìì, ë¤ì URL...");
            } catch (e) {
                        const errMsg = (e?.message || String(e)) + (e?.cause?.code ? " (" + e.cause.code + ")" : "");
                        const m = errMsg.match(/\b([3-5]\d{2})\b/);
                        const statusCode = e?.statusCode || (m ? parseInt(m[1]) : 0);
                        SOURCE_HEALTH_LOG[src.name] = { status: "fail", url, statusCode, error: errMsg, checkedAt: nowISO() };
                        console.log("  [FAIL] " + src.name + ": " + errMsg);
                        if (statusCode === 429) { const waitMs = rateLimitWaitMs(e?.retryAfter, rateLimitWait); console.log("  [WAIT] Rate limit - " + waitMs + "ms wait..."); await sleep(waitMs); }
            }
  }
        console.log("  [SKIP] " + src.name + ": ëª¨ë  URL ì¤í¨");
        return [];
}

async function summarizeKo(it) {
        if (!OPENAI_API_KEY) return "";
        const input = [
                  "ë¤ì ë´ì¤ í­ëª©ì íêµ­ì´ë¡ ìì½í´ì¤.", "ê·ì¹:", "- 3~5ë¬¸ì¥",
                  "- ë§ì§ë§ ì¤: \"ì ì¤ìíì§(ì¤ë¬´ ê´ì )\" 1ë¬¸ì¥",
                  "- ê³¼ì¥ ê¸ì§, ì¶ì¸¡ ê¸ì§, ì¬ì¤ ê¸°ë°", "- ì¶ë ¥ì ìì½ë§ (ë§í¬/ì¶ì² ë£ì§ ë§ ê²)", "",
                  "[ì ëª©] " + it.title, "[ì¶ì²] " + it.source, "[URL] " + it.url, "[ë´ì©] " + it.content
                ].join("\n");
        const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30초 타임아웃
  let res;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: "You are a helpful assistant that writes concise Korean summaries." }, { role: "user", content: input }],
        temperature: 0.2,
        max_tokens: 350
      })
    });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res || !res.ok) {
    const t = res ? await res.text().catch(() => "") : "timeout";
    throw new Error("OpenAI error " + (res ? res.status : "abort") + ": " + t);
  }
    const data = await res.json();
        return (data.choices?.[0]?.message?.content || "").trim();
}

async function buildTab(tab) {
        let items = [];
        for (const src of (SOURCES[tab] || [])) {
                  items.push(...await fetchFeedWithFallback(src));
                  await sleep(1000);
        }
        items = dedupe(items).map(scoreAndClassify).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, MAX_ITEMS_PER_TAB);
        console.log("[GPT] " + tab + " ìì½ ì¤... " + items.length + "ê°");
        for (let i = 0; i < Math.min(SUMMARIZE_TOP_N, items.length); i++) {
                  try { items[i].summary_ko = await summarizeKo(items[i]); }
                  catch (e) { items[i].summary_ko = ""; console.log("[" + tab + "] summarize fail: " + (e?.message || e)); }
        }
        items = items.map(it => {
                  if (it.summary_ko && it.summary_ko.trim()) return it;
                  const fb = (it.content || "").replace(/\s+/g, " ").trim().slice(0, 180);
                  return { ...it, summary_ko: fb ? "ìì½ ìì± ì¤í¨. ìë¬¸ ì¼ë¶: " + fb : "ìì½ ìì± ì¤í¨." };
        });
        return { updated_at: nowISO(), items: items.map(it => ({ title: it.title, url: it.url, source: it.source, published_at: it.published_at, summary_ko: it.summary_ko, tags: it.tags, buckets: it.buckets, score: it.score })) };
}

function saveHealthReport(dataDir) {
        const reportPath = path.join(dataDir, "source-health.json");
        fs.writeFileSync(reportPath, JSON.stringify({ generated_at: nowISO(), sources: SOURCE_HEALTH_LOG }, null, 2), "utf-8");
        console.log("\n=== ìì¤ í¬ì¤ ë¦¬í¬í¸ ===");
        for (const [name, info] of Object.entries(SOURCE_HEALTH_LOG)) {
                  if (info.status === "ok") console.log("  OK " + name + " (" + info.url + ")");
                  else console.log("  FAIL " + name + " [" + (info.statusCode || "ERR") + "] " + (info.error || ""));
        }
        console.log("í¬ì¤ ë¦¬í¬í¸: data/source-health.json\n");
}

async function main() {
        console.log("=== AI News Builder ìì ===");
        const dataDir = path.join(process.cwd(), "data");
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        for (const tab of ["ai", "automation", "notion"]) {
                  console.log("\n[BUILD] " + tab + " ìì§ ìì...");
                  const out = await buildTab(tab);
                  fs.writeFileSync(path.join(dataDir, tab + ".json"), JSON.stringify(out, null, 2), "utf-8");
                  console.log("[DONE] data/" + tab + ".json ì ì¥ ìë£ (" + out.items.length + "ê°)");
        }
        saveHealthReport(dataDir);
        console.log("=== ì ì²´ ìë£ ===");
}

export { fetchFeedXml, fetchFeedWithFallback, SOURCE_HEALTH_LOG };

// 테스트에서 import할 때는 빌드를 실행하지 않는다
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
        main().catch(err => { console.error(err); process.exit(1); });
}
