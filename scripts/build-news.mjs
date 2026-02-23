import fs from "fs";
import path from "path";
import RSSParser from "rss-parser";

const parser = new RSSParser();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const MAX_ITEMS_PER_TAB = 60;
const SUMMARIZE_TOP_N = 25;

const SOURCES = {
    ai: [
      { name: "Google AI Blog", url: "https://blog.google/technology/ai/rss/" },
      { name: "Hacker News (LLM)", url: "https://hnrss.org/newest?q=GPT+Claude+Gemini+NotebookLM+agent+RAG" },
      { name: "Reddit r/MachineLearning", url: "https://www.reddit.com/r/MachineLearning/.rss" }
        ],
    automation: [
      { name: "Hacker News (Automation)", url: "https://hnrss.org/newest?q=make.com+n8n+zapier+automation+workflow+opal" },
      { name: "Reddit r/n8n", url: "https://www.reddit.com/r/n8n/.rss" }
        ],
    notion: [
      { name: "Notion Blog", url: "https://www.notion.so/blog/rss" },
      { name: "Reddit r/Notion", url: "https://www.reddit.com/r/Notion/.rss" }
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

function nowISO(){ return new Date().toISOString(); }
function lower(x){ return (x ?? "").toString().toLowerCase(); }
function hoursAgo(iso){
    const t = new Date(iso).getTime();
    return (Date.now() - t) / (1000*60*60);
}

function dedupe(items){
    const seen = new Set();
    const out = [];
    for (const it of items){
          const key = it.url || it.title;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(it);
    }
    return out;
}

function scoreAndClassify(item){
    const text = lower(item.title) + " " + lower(item.source) + " " + lower(item.url) + " " + lower(item.content);
    let score = 0;
    const tags = new Set(item.tags || []);
    const buckets = new Set(item.buckets || []);
    for (const r of RULES){
          if (r.k.some(k => text.includes(lower(k)))){
                  score += r.w;
                  tags.add(r.tag);
                  buckets.add(r.bucket);
          }
    }
    const h = item.published_at ? hoursAgo(item.published_at) : 999;
    if (h <= 24) score += 25;
    else if (h <= 72) score += 12;
    return { ...item, score, tags:[...tags], buckets:[...buckets] };
}

async function fetchFeed(src){
    const feed = await parser.parseURL(src.url);
    return (feed.items || []).map(it => ({
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
}

async function summarizeKo(it){
    if (!OPENAI_API_KEY) return "";
    const input = [
          "다음 뉴스 항목을 한국어로 요약해줘.",
          "규칙:",
          "- 3~5문장",
          "- 마지막 줄: \"왜 중요한지(실무 관점)\" 1문장",
          "- 과장 금지, 추측 금지, 사실 기반",
          "- 출력은 요약만 (링크/출처 넣지 말 것)",
          "",
          "[제목] " + it.title,
          "[출처] " + it.source,
          "[URL] " + it.url,
          "[내용] " + it.content
        ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
                "Authorization": "Bearer " + OPENAI_API_KEY,
                "Content-Type": "application/json"
        },
        body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                  { role: "system", content: "You are a helpful assistant that writes concise Korean summaries." },
                  { role: "user", content: input }
                        ],
                temperature: 0.2,
                max_tokens: 350
        })
  });

  if (!res.ok){
        const t = await res.text().catch(()=> "");
        throw new Error("OpenAI error " + res.status + ": " + t);
  }

  const data = await res.json();
    return (data.choices?.[0]?.message?.content || "").trim();
}

async function buildTab(tab){
    let items = [];
    for (const src of (SOURCES[tab] || [])){
          try{
                  items.push(...await fetchFeed(src));
          }catch(e){
                  console.log("[" + tab + "] source fail: " + src.name, e?.message || e);
          }
    }

  items = dedupe(items).map(scoreAndClassify).sort((a,b)=> (b.score||0)-(a.score||0));
    items = items.slice(0, MAX_ITEMS_PER_TAB);

  for (let i=0; i<Math.min(SUMMARIZE_TOP_N, items.length); i++){
        try{
                const sum = await summarizeKo(items[i]);
                items[i].summary_ko = sum;
        }catch(e){
                items[i].summary_ko = "";
                console.log("[" + tab + "] summarize fail", items[i].title, e?.message || e);
        }
  }

  items = items.map(it => {
        if (it.summary_ko && it.summary_ko.trim()) return it;
        const fallback = (it.content || "").replace(/\s+/g," ").trim().slice(0, 180);
        return { ...it, summary_ko: fallback ? "요약 생성 실패. 원문 일부: " + fallback : "요약 생성 실패." };
  });

  const cleaned = items.map(it => ({
        title: it.title,
        url: it.url,
        source: it.source,
        published_at: it.published_at,
        summary_ko: it.summary_ko,
        tags: it.tags,
        buckets: it.buckets,
        score: it.score
  }));

  return { updated_at: nowISO(), items: cleaned };
}

async function main(){
    console.log("=== AI News Builder 시작 ===");
    const dataDir = path.join(process.cwd(), "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  for (const tab of ["ai","automation","notion"]){
        console.log("[BUILD] " + tab + " 수집 시작...");
        const out = await buildTab(tab);
        fs.writeFileSync(path.join(dataDir, tab + ".json"), JSON.stringify(out, null, 2), "utf-8");
        console.log("[GPT] " + tab + " 요약 중... " + out.items.length + "개");
        console.log("[DONE] data/" + tab + ".json 저장 완료 (" + out.items.length + "개)");
  }
    console.log("=== 전체 완료 ===");
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
