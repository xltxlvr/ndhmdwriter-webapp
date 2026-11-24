#!/usr/bin/env node
/* ndhmd-agent — ndhmd 웹 작업대용 로컬 컴파일 에이전트
 *
 * 하는 일은 하나다: 웹 페이지가 보낸 .tex(와 그림)를 임시 폴더에 풀어 latexmk 로 컴파일하고,
 * 진행 로그를 흘려 보낸 뒤 PDF 와 .synctex.gz 를 돌려준다. 그 밖의 명령은 실행하지 않는다.
 *
 *   node ndhmd-agent.mjs [--port 47321] [--app ../dist/index.html] [--origin https://호스트] ...
 *
 * 의존 패키지 없음. Node 18 이상.
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ───────────── 설정 ───────────── */
function parseArgs(argv) {
  const o = { port: 47321, host: "127.0.0.1", origins: [], app: null, work: path.join(os.tmpdir(), "ndhmd-agent"),
              timeout: 300, shellEscape: "restricted", keep: 3, maxMB: 100, token: process.env.NDHMD_AGENT_TOKEN || null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v = null; const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => (v !== null ? v : argv[++i]);
    switch (a) {
      case "--port": o.port = +next(); break;
      case "--host": o.host = next(); break;
      case "--origin": o.origins.push(next().replace(/\/+$/, "")); break;
      case "--app": o.app = path.resolve(next()); break;
      case "--work": o.work = path.resolve(next()); break;
      case "--timeout": o.timeout = +next(); break;
      case "--shell-escape": o.shellEscape = next(); break;
      case "--keep": o.keep = +next(); break;
      case "--max-mb": o.maxMB = +next(); break;
      case "--token": o.token = next(); break;
      case "-h": case "--help": o.help = true; break;
      default: console.error("알 수 없는 옵션: " + a); o.help = true;
    }
  }
  if (!["off", "restricted", "on"].includes(o.shellEscape)) { console.error("--shell-escape 는 off|restricted|on 중 하나여야 합니다."); o.help = true; }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) { console.error("--port 가 올바르지 않습니다."); o.help = true; }
  return o;
}
const HELP = `ndhmd-agent ${VERSION} — ndhmd 웹 작업대용 로컬 컴파일 에이전트

사용법: node ndhmd-agent.mjs [옵션]

  --port N              듣는 포트 (기본 47321). 주소는 항상 127.0.0.1 입니다.
  --app 파일            이 index.html 을 에이전트가 직접 내줍니다. 이 경우 같은 출처라 설정이 가장 단순합니다.
  --origin URL          웹 페이지를 다른 곳(예: GitHub Pages)에서 열 때, 그 출처를 허용합니다. 여러 번 쓸 수 있습니다.
  --work 폴더           임시 작업 폴더 (기본: 시스템 임시 폴더/ndhmd-agent). 한글이 없는 경로를 권합니다.
  --timeout 초          컴파일 제한 시간 (기본 300)
  --shell-escape 모드   off | restricted | on (기본 restricted = TeX Live 기본값).
                        shell escape가 필요할 때 on. 웹 쪽에서는 바꿀 수 없습니다.
  --keep N              남겨 둘 최근 작업 수 (기본 3)
  --max-mb N            요청 크기 상한(MB, 기본 100)
  --token 값            연결 코드를 직접 정합니다(기본: ~/.ndhmd-agent/token 에 저장된 무작위 값).
`;

/* ───────────── 연결 코드 ───────────── */
function loadToken(opt) {
  if (opt.token) return opt.token;
  const dir = path.join(os.homedir(), ".ndhmd-agent"), f = path.join(dir, "token");
  try { const t = fs.readFileSync(f, "utf8").trim(); if (/^[A-Za-z0-9_-]{16,}$/.test(t)) return t; } catch {}
  const t = crypto.randomBytes(18).toString("base64url");
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(f, t + "\n", { mode: 0o600 }); } catch (e) { console.error("연결 코드를 저장하지 못했습니다(이번 실행에만 유효): " + e.message); }
  return t;
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ───────────── 요청 검사 ───────────── */
const ENGINES = { xelatex: "-pdfxe", lualatex: "-pdflua", pdflatex: "-pdf" };
const ALLOWED_EXT = new Set([".tex", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".pdf", ".eps", ".webp", ".sty", ".cls", ".lbx", ".bst", ".bib", ".def", ".cfg", ".clo", ".fd"]);
function cleanRel(p) {
  if (typeof p !== "string" || !p || p.length > 240) return null;
  if (/[\u0000-\u001f\\:*?"<>|]/.test(p) || p.startsWith("/") || /(^|\/)\.\.?(\/|$)/.test(p) || p.includes("//") || p.endsWith("/")) return null;
  return p;
}
function validateCompile(b) {
  if (!b || typeof b !== "object") return "요청 본문이 올바르지 않습니다.";
  if (b.version !== 1) return "지원하지 않는 요청 버전입니다.";
  if (!(b.engine in ENGINES)) return "엔진은 xelatex, lualatex, pdflatex 중 하나여야 합니다.";
  if (Array.isArray(b.latexmk) && b.latexmk[0] !== ENGINES[b.engine]) return "latexmk 인자의 엔진 표시가 engine 과 맞지 않습니다.";
  if (!Array.isArray(b.files) || !b.files.length || b.files.length > 2000) return "files 가 비었거나 너무 많습니다.";
  const seen = new Set();
  for (const f of b.files) {
    const p = f && cleanRel(f.path);
    if (!p) return "허용되지 않는 파일 경로입니다: " + String(f && f.path).slice(0, 80);
    if (!ALLOWED_EXT.has(path.extname(p).toLowerCase())) return "허용되지 않는 파일 형식입니다: " + p;
    if (typeof f.b64 !== "string") return "파일 내용이 없습니다: " + p;
    const k = p.toLowerCase(); if (seen.has(k)) return "같은 경로가 두 번 들어 있습니다: " + p; seen.add(k);
  }
  const tex = cleanRel(b.texFile);
  if (!tex || !tex.toLowerCase().endsWith(".tex") || !seen.has(tex.toLowerCase())) return "texFile 이 files 안의 .tex 가 아닙니다.";
  return null;
}
function latexmkArgs(engine, shellEscape, texFile) {
  const a = [ENGINES[engine], "-interaction=nonstopmode", "-synctex=1", "-file-line-error"];
  if (shellEscape === "off") a.push("-no-shell-escape"); else if (shellEscape === "on") a.push("-shell-escape");
  a.push(texFile);
  return a;
}

/* ───────────── 프로세스 ───────────── */
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill("SIGKILL"); } catch {} }
}
function probe(cmd, args) {
  return new Promise(res => {
    let out = "", done = false; const fin = v => { if (!done) { done = true; res(v); } };
    let c; try { c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); } catch { return fin(null); }
    c.on("error", () => fin(null));
    c.stdout.on("data", d => out += d); c.stderr.on("data", d => out += d);
    c.on("close", code => fin(code === 0 || out ? out.split(/\r?\n/).find(Boolean) || "" : null));
    setTimeout(() => { killTree(c); fin(null); }, 8000).unref();
  });
}
let toolCache = { at: 0, v: null };
async function tools() {
  if (toolCache.v && Date.now() - toolCache.at < 30000) return toolCache.v;
  const [latexmk, xe, lua, pdf] = await Promise.all([probe("latexmk", ["-v"]), probe("xelatex", ["--version"]), probe("lualatex", ["--version"]), probe("pdflatex", ["--version"])]);
  toolCache = { at: Date.now(), v: { latexmk: latexmk && latexmk.replace(/^Latexmk,\s*/, "").slice(0, 80), engines: { xelatex: !!xe, lualatex: !!lua, pdflatex: !!pdf } } };
  return toolCache.v;
}

/* ───────────── 서버 ───────────── */
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { process.stdout.write(HELP); process.exit(process.argv.length > 2 && !process.argv.includes("-h") && !process.argv.includes("--help") ? 2 : 0); }
  const token = loadToken(opt);
  await fsp.mkdir(opt.work, { recursive: true });
  const selfOrigins = new Set([`http://127.0.0.1:${opt.port}`, `http://localhost:${opt.port}`, `http://[::1]:${opt.port}`]);
  const allowedOrigins = new Set([...selfOrigins, ...opt.origins]);
  const allowedHosts = new Set([`127.0.0.1:${opt.port}`, `localhost:${opt.port}`, `[::1]:${opt.port}`]);
  const jobs = new Map(); // id → {dir, stem, createdAt}
  let running = null;

  // 지난 실행의 찌꺼기를 치운다(하루 넘은 job- 폴더)
  try { for (const n of await fsp.readdir(opt.work)) if (/^job-[0-9a-f]{12}$/.test(n)) { const p = path.join(opt.work, n); const st = await fsp.stat(p); if (Date.now() - st.mtimeMs > 864e5) await fsp.rm(p, { recursive: true, force: true }); } } catch {}

  const cors = (req, res) => {
    const o = req.headers.origin;
    if (o && allowedOrigins.has(o)) {
      res.setHeader("Access-Control-Allow-Origin", o); res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  };
  const send = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length, "Cache-Control": "no-store" }); res.end(b); };
  const authed = req => { const h = req.headers.authorization || ""; return h.startsWith("Bearer ") && safeEq(h.slice(7), token); };

  const server = http.createServer(async (req, res) => {
    try {
      // DNS 재결합 방지: Host 가 우리 주소가 아니면 거절
      if (!allowedHosts.has(String(req.headers.host || "").toLowerCase())) return send(res, 403, { error: "host" });
      // 다른 출처의 페이지가 부르는 것 방지: Origin 이 있으면 허용 목록에 있어야 한다
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return send(res, 403, { error: "origin", message: "이 출처는 허용되지 않았습니다. 에이전트를 --origin " + origin + " 로 시작하십시오." });
      cors(req, res);
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      const url = new URL(req.url, "http://x");
      const p = url.pathname;

      if (req.method === "GET" && (p === "/" || p === "/index.html")) {
        if (opt.app) { try { const b = await fsp.readFile(opt.app); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(b); } catch (e) { return send(res, 500, { error: "app", message: "--app 파일을 읽지 못했습니다: " + e.message }); } }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("ndhmd-agent " + VERSION + " 가 동작 중입니다.\n웹 작업대는 --app 으로 내주거나, 다른 곳에서 연 페이지에서 이 주소로 연결하십시오.\n");
      }

      if (req.method === "GET" && p === "/hello") {
        if (!authed(req)) return send(res, 200, { agent: "ndhmd-agent", version: VERSION, needsToken: true });
        const t = await tools();
        return send(res, 200, { agent: "ndhmd-agent", version: VERSION, needsToken: false, platform: process.platform, latexmk: t.latexmk, engines: t.engines,
          shellEscape: opt.shellEscape, timeout: opt.timeout, maxMB: opt.maxMB, busy: !!running });
      }

      if (p === "/favicon.ico") { res.writeHead(204); return res.end(); }
      if (!authed(req)) return send(res, 401, { error: "token", message: "연결 코드가 없거나 틀렸습니다." });

      if (req.method === "POST" && p === "/compile") return await handleCompile(req, res);

      const m = /^\/job\/([0-9a-f]{12})\/(pdf|synctex|log)$/.exec(p);
      if (req.method === "GET" && m) {
        const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: "job" });
        const f = { pdf: [j.stem + ".pdf", "application/pdf"], synctex: [j.stem + ".synctex.gz", "application/gzip"], log: [j.stem + ".log", "text/plain; charset=utf-8"] }[m[2]];
        try { const b = await fsp.readFile(path.join(j.dir, f[0])); res.writeHead(200, { "Content-Type": f[1], "Content-Length": b.length, "Cache-Control": "no-store" }); return res.end(b); }
        catch { return send(res, 404, { error: "file", message: f[0] + " 이(가) 없습니다." }); }
      }
      return send(res, 404, { error: "not-found" });
    } catch (e) {
      try { send(res, 500, { error: "internal", message: String(e && e.message || e) }); } catch {}
    }
  });

  async function readBody(req, limit) {
    const len = +req.headers["content-length"];
    if (len > limit) throw Object.assign(new Error("요청이 너무 큽니다(" + opt.maxMB + "MB 상한)."), { code: 413 });
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error("요청이 너무 큽니다(" + opt.maxMB + "MB 상한)."), { code: 413 }); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  async function handleCompile(req, res) {
    if (running) return send(res, 409, { error: "busy", message: "다른 컴파일이 진행 중입니다." });
    let body;
    try { body = JSON.parse((await readBody(req, opt.maxMB * 1048576)).toString("utf8")); }
    catch (e) { return send(res, e.code || 400, { error: "body", message: e.code ? e.message : "JSON 을 읽지 못했습니다." }); }
    const bad = validateCompile(body); if (bad) return send(res, 400, { error: "request", message: bad });
    if (running) return send(res, 409, { error: "busy", message: "다른 컴파일이 진행 중입니다." });

    const id = crypto.randomBytes(6).toString("hex"), dir = path.join(opt.work, "job-" + id);
    const texFile = body.texFile, stem = path.basename(texFile).replace(/\.tex$/i, "");
    const job = { id, dir, stem, child: null, aborted: false, timedOut: false };
    running = job;
    // 스트림(NDJSON)으로 진행을 알린다
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const emit = o => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(o) + "\n"); };
    res.on("close", () => { if (!res.writableFinished) { job.aborted = true; killTree(job.child); } });
    const t0 = Date.now();
    try {
      await fsp.mkdir(dir, { recursive: true });
      for (const f of body.files) {
        const dest = path.join(dir, ...f.path.split("/"));
        if (path.relative(dir, dest).startsWith("..")) throw new Error("경로가 작업 폴더를 벗어납니다: " + f.path);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, Buffer.from(f.b64, "base64"));
      }
      const args = latexmkArgs(body.engine, opt.shellEscape, texFile);
      emit({ t: "start", id, cmd: "latexmk " + args.join(" "), dir: opt.work, files: body.files.length });
      console.log(`[${new Date().toLocaleTimeString()}] 컴파일 ${id}: ${texFile} (${body.engine}, 파일 ${body.files.length}개)`);
      const code = await new Promise((resolve, reject) => {
        let c;
        try { c = spawn("latexmk", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true, env: { ...process.env, max_print_line: "1000", error_line: "254", half_error_line: "238" } }); }
        catch (e) { return reject(e); }
        job.child = c;
        const to = setTimeout(() => { job.timedOut = true; killTree(c); }, opt.timeout * 1000);
        const dec = new TextDecoder("utf-8");
        const pump = d => emit({ t: "log", s: dec.decode(d, { stream: true }) });
        c.stdout.on("data", pump); c.stderr.on("data", pump);
        c.on("error", e => { clearTimeout(to); reject(e); });
        c.on("close", (cd, sig) => { clearTimeout(to); resolve(cd === null ? (sig || -1) : cd); });
      });
      if (job.aborted) throw Object.assign(new Error("중단됨"), { aborted: true });
      const stat = n => fsp.stat(path.join(dir, n)).then(s => s.size, () => null);
      const pdfSize = await stat(stem + ".pdf"), syncSize = await stat(stem + ".synctex.gz") ?? await stat(stem + ".synctex");
      let errors = [];
      try {
        const lg = (await fsp.readFile(path.join(dir, stem + ".log"))).toString("utf8");
        const re = /^(?:\.\/)?([^\s:][^:\n]*?\.(?:tex|sty|cls)):(\d+): (.*)$/gm; let mm;
        while ((mm = re.exec(lg)) && errors.length < 50) errors.push({ file: mm[1], line: +mm[2], msg: mm[3].trim() });
      } catch {}
      jobs.set(id, { dir, stem, createdAt: Date.now() });
      const ok = code === 0 && pdfSize != null && !job.timedOut;
      emit({ t: "done", id, ok, code: typeof code === "number" ? code : -1, timedOut: job.timedOut, ms: Date.now() - t0,
             pdf: pdfSize, synctex: syncSize != null, synctexGz: await stat(stem + ".synctex.gz") != null, errors, stem });
      console.log(`           → ${ok ? "성공" : "실패"} (${((Date.now() - t0) / 1000).toFixed(1)}초)${pdfSize != null ? ", PDF " + Math.round(pdfSize / 1024) + " KB" : ""}`);
    } catch (e) {
      if (!e.aborted) emit({ t: "done", id, ok: false, code: -1, error: String(e && e.message || e), ms: Date.now() - t0, pdf: null, synctex: false, errors: [] });
      else console.log(`           → 중단됨 (${id})`);
    } finally {
      running = null;
      if (!res.writableEnded) res.end();
      // 오래된 작업 폴더 정리
      const keep = [...jobs.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
      for (const [k, v] of keep.slice(Math.max(opt.keep, 1))) { jobs.delete(k); fsp.rm(v.dir, { recursive: true, force: true }).catch(() => {}); }
      if (job.aborted || !jobs.has(id)) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  server.on("error", e => { console.error(e.code === "EADDRINUSE" ? `포트 ${opt.port} 가 이미 쓰이고 있습니다. --port 로 다른 포트를 고르십시오.` : String(e)); process.exit(1); });
  server.listen(opt.port, opt.host, async () => {
    const t = await tools();
    const base = `http://127.0.0.1:${opt.port}/`;
    console.log(`ndhmd-agent ${VERSION}`);
    console.log(`  주소      ${base}`);
    console.log(`  연결 코드 ${token}`);
    if (opt.app) console.log(`  바로 열기 ${base}#token=${token}`);
    console.log(`  latexmk   ${t.latexmk || "찾지 못했습니다 — TeX Live/MiKTeX 설치와 PATH 를 확인하십시오"}`);
    console.log(`  엔진      ` + Object.entries(t.engines).map(([k, v]) => k + (v ? " ✓" : " ✗")).join("  "));
    console.log(`  shell-escape ${opt.shellEscape}${opt.shellEscape === "restricted" ? "  (shell escape가 필요할 때 --shell-escape on 으로 켭니다)" : ""}`);
    console.log(`  작업 폴더 ${opt.work}`);
    if (/[^\x20-\x7e]/.test(opt.work)) console.log("  ! 작업 폴더 경로에 한글 등이 있습니다. 일부 TeX 도구가 탈 수 있으니 --work 로 영문 경로를 권합니다.");
    if (opt.origins.length) console.log(`  허용 출처 ${opt.origins.join(", ")}`);
    console.log("종료: Ctrl+C");
  });
  const bye = () => { try { killTree(running && running.child); } catch {} server.close(); setTimeout(() => process.exit(0), 200).unref(); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
main().catch(e => { console.error(e); process.exit(1); });
