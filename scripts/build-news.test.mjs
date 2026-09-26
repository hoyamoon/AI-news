// 회귀 테스트: RSS 404/429/timeout 응답 뒤에도 fallback이 작동하고 프로세스가 스스로 종료되는지 검증
// 실행: node --test scripts/
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "build-news.mjs")).href;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title>Hello</title><link>https://example.com/1</link><description>body</description></item>
</channel></rss>`;

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/404":
        // 소비되지 않으면 소켓에 남는 큰 본문 (기존 rss-parser 누수 재현 조건)
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("x".repeat(256 * 1024));
        break;
      case "/429":
        res.writeHead(429, { "Content-Type": "text/html" });
        res.end("x".repeat(256 * 1024));
        break;
      case "/hang":
        break; // 응답 헤더를 영원히 보내지 않음
      case "/stall-body":
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.write("<?xml version=\"1.0\"?><rss>"); // 본문 도중 멈춤
        break;
      case "/ok":
        res.writeHead(200, { "Content-Type": "application/rss+xml" });
        res.end(RSS);
        break;
      default:
        res.writeHead(500);
        res.end();
    }
  });
  // 서버가 keep-alive 연결을 끊지 않게 해 클라이언트 쪽 정리만으로 종료되는지 확인
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

// 별도 프로세스에서 fetchFeedWithFallback만 실행하고, process.exit 없이 자연 종료되는지 측정
function runChild(urls, { killAfterMs = 20000 } = {}) {
  const code = `
    import { fetchFeedWithFallback, SOURCE_HEALTH_LOG } from ${JSON.stringify(SCRIPT_URL)};
    const items = await fetchFeedWithFallback({ name: "T", urls: ${JSON.stringify(urls)} }, { timeoutMs: 500, rateLimitWait: 50 });
    console.log("RESULT " + JSON.stringify({ n: items.length, first: items[0]?.title ?? null, health: SOURCE_HEALTH_LOG.T }));
  `;
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    let killed = false;
    const killer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, killAfterMs);
    child.on("exit", (exitCode) => {
      clearTimeout(killer);
      const line = out.split("\n").find(l => l.startsWith("RESULT "));
      resolve({ killed, exitCode, elapsedMs: Date.now() - t0, result: line ? JSON.parse(line.slice(7)) : null, out, err });
    });
  });
}

test("404 -> 429 -> 헤더 무응답 -> 본문 멈춤 뒤 정상 URL로 fallback하고 프로세스가 자연 종료된다", async () => {
  const r = await runChild([base + "/404", base + "/429", base + "/hang", base + "/stall-body", base + "/ok"]);
  assert.equal(r.killed, false, "프로세스가 종료되지 않음 (열린 핸들 누수)\n" + r.out + r.err);
  assert.equal(r.exitCode, 0, r.err);
  assert.equal(r.result.n, 1);
  assert.equal(r.result.first, "Hello");
  assert.equal(r.result.health.status, "ok");
  assert.ok(r.elapsedMs < 10000, "종료까지 너무 오래 걸림: " + r.elapsedMs + "ms");
});

test("모든 URL이 실패해도 빈 결과로 끝나고 프로세스가 자연 종료된다", async () => {
  const r = await runChild([base + "/404", base + "/429", base + "/hang"]);
  assert.equal(r.killed, false, "프로세스가 종료되지 않음 (열린 핸들 누수)\n" + r.out + r.err);
  assert.equal(r.exitCode, 0, r.err);
  assert.equal(r.result.n, 0);
  assert.equal(r.result.health.status, "fail");
  assert.match(r.result.health.error, /timed out/);
  assert.ok(r.elapsedMs < 10000, "종료까지 너무 오래 걸림: " + r.elapsedMs + "ms");
});

test("429 상태 코드가 health 로그에 기록된다", async () => {
  const r = await runChild([base + "/429"]);
  assert.equal(r.killed, false);
  assert.equal(r.result.health.statusCode, 429);
});
