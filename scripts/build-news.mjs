import fs from "fs";
import path from "path";
import RSSParser from "rss-parser";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_ITEMS_PER_TAB = 60;
const SUMMARIZE_TOP_N = 25;

const SOURCES = {
        ai: [
              { name: "Google AI Blog", urls: ["https://blog.google/technology/ai/rss/", "https://ai.googleblog.com/feeds/posts/default"] },
              { name: "Hacker News (LLM)", urls: ["https://hnrss.org/newest?q=GPT+Claude+Gemini+NotebookLM+agent+RAG", "https://hnrss.org/frontpage"] },
              { name: "Reddit r/MachineLearning", urls: ["https://www.reddit.com/r/MachineLearning/.rss", "https://www.reddit.com/r/MachineLearning/new/.rss", "https://www.reddit.com/r/MachineLearning/top/.rss?t=week"], headers: { "User-Agent": "Mozilla/5.0 (compatible; AI-news-bot/1.0)", "Accept": "application/rss+xml, application/xml, text/xml, */*" } },
              { name: "MIT News AI", urls: ["https://news.mit.edu/topic/artificial-intelligence2/rss"] },
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
              { name: "Notion Blog", urls: ["https://www.notion.com/blog/rss", "https://www.notion.so/blog/rss", "https://notion.ghost.io/rss/"] },
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

async function fetchFeedWithFallback(src) {
        const urls = src.urls || [src.url];
        const extraHeaders = src.headers || {};

  for (const url of urls) {
            try {
                        console.log("  [CHECK] " + src.name + " -> " + url);
                        const customParser = new RSSParser({
                                      headers: {
                                                      "User-Agent": "Mozilla/5.0 (compatible; AI-news-bot/1.0; +https://github.com/hoyamoon/AI-news)",
                                                      "Accept": "application/rss+xml, application/xml, text/xml, */*",
                                                      ...extraHeaders
                                      },
                                      timeout: 15000
                        });
                        const feed = await customParser.parseURL(url);
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
                                      console.log("  [OK] " + src.name + ": " + items.length + "개 (" + url + ")");
                                      return items;
                        }
                        console.log("  [WARN] " + src.name + ": 항목없음, 다음 URL...");
            } catch (e) {
                        const errMsg = e?.message || String(e);
                        const m = errMsg.match(/\b([3-5]\d{2})\b/);
                        const statusCode = m ? parseInt(m[1]) : 0;
                        SOURCE_HEALTH_LOG[src.name] = { status: "fail", url, statusCode, error: errMsg, checkedAt: nowISO() };
                        console.log("  [FAIL] " + src.name + ": " + errMsg);
                        if (statusCode === 429) { console.log("  [WAIT] Rate limit - 5초 대기..."); await sleep(5000); }
            }
  }
        console.log("  [SKIP] " + src.name + ": 모든 URL 실패");
        return [];
}

async function summarizeKo(it) {
        if (!OPENAI_API_KEY) return "";
        const input = [
                  "다음 뉴스 항목을 한국어로 요약해줘.", "규칙:", "- 3~5문장",
                  "- 마지막 줄: \"왜 중요한지(실무 관점)\" 1문장",
                  "- 과장 금지, 추측 금지, 사실 기반", "- 출력은 요약만 (링크/출처 넣지 말 것)", "",
                  "[제목] " + it.title, "[출처] " + it.source, "[URL] " + it.url, "[내용] " + it.content
                ].join("\n");
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
                  method: "POST",
                  headers: { "Authorization": "Bearer " + OPENAI_API_KEY, "Content-Type": "application/json" },
                  body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "system", content: "You are a helpful assistant that writes concise Korean summaries." }, { role: "user", content: input }], temperature: 0.2, max_tokens: 350 })
        });
        if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error("OpenAI error " + res.status + ": " + t); }
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
        console.log("[GPT] " + tab + " 요약 중... " + items.length + "개");
        for (let i = 0; i < Math.min(SUMMARIZE_TOP_N, items.length); i++) {
                  try { items[i].summary_ko = await summarizeKo(items[i]); }
                  catch (e) { items[i].summary_ko = ""; console.log("[" + tab + "] summarize fail: " + (e?.message || e)); }
        }
        items = items.map(it => {
                  if (it.summary_ko && it.summary_ko.trim()) return it;
                  const fb = (it.content || "").replace(/\s+/g, " ").trim().slice(0, 180);
                  return { ...it, summary_ko: fb ? "요약 생성 실패. 원문 일부: " + fb : "요약 생성 실패." };
        });
        return { updated_at: nowISO(), items: items.map(it => ({ title: it.title, url: it.url, source: it.source, published_at: it.published_at, summary_ko: it.summary_ko, tags: it.tags, buckets: it.buckets, score: it.score })) };
}

function saveHealthReport(dataDir) {
        const reportPath = path.join(dataDir, "source-health.json");
        fs.writeFileSync(reportPath, JSON.stringify({ generated_at: nowISO(), sources: SOURCE_HEALTH_LOG }, null, 2), "utf-8");
        console.log("\n=== 소스 헬스 리포트 ===");
        for (const [name, info] of Object.entries(SOURCE_HEALTH_LOG)) {
                  if (info.status === "ok") console.log("  OK " + name + " (" + info.url + ")");
                  else console.log("  FAIL " + name + " [" + (info.statusCode || "ERR") + "] " + (info.error || ""));
        }
        console.log("헬스 리포트: data/source-health.json\n");
}

async function main() {
        console.log("=== AI News Builder 시작 ===");
        const dataDir = path.join(process.cwd(), "data");
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        for (const tab of ["ai", "automation", "notion"]) {
                  console.log("\n[BUILD] " + tab + " 수집 시작...");
                  const out = await buildTab(tab);
                  fs.writeFileSync(path.join(dataDir, tab + ".json"), JSON.stringify(out, null, 2), "utf-8");
                  console.log("[DONE] data/" + tab + ".json 저장 완료 (" + out.items.length + "개)");
        }
        saveHealthReport(dataDir);
        console.log("=== 전체 완료 ===");
}

main().catch(err => { console.error(err); process.exit(1); });
