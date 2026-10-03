// StudyDesk server: static files + /api/extract (Gemma vision via the Gemini API).
// Zero dependencies; Node 18+. The API key is read from the environment or a .env file.
const http = require("http");
const fs = require("fs");
const path = require("path");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMMA_MODEL || "gemma-4-31b-it";
const MAX_BODY = 12 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const TYPES = ["assignment", "exam", "quiz", "project", "reading", "lab", "other"];

function buildPrompt(today, courseHint) {
  return `You are StudyDesk, an assistant for students. The image is a syllabus, assignment sheet, exam schedule, course page or similar.
Today's date is ${today}.${courseHint ? ` The student says this is for the course "${courseHint}".` : ""}

Extract EVERY graded or dated item the student must do. Read only what is visible; never invent items.

Return a single JSON object and nothing else (no markdown fences):
{
  "course": "course name or code, or null",
  "items": [
    { "title": "short name, e.g. 'Problem Set 3'",
      "type": "assignment | exam | quiz | project | reading | lab | other",
      "due_date": "YYYY-MM-DD or null",
      "due_text": "the date exactly as written in the image, or null",
      "time": "HH:MM 24h or null",
      "weight_percent": number or null,
      "estimated_hours": number,
      "evidence": "exact text copied from the image for this item" }
  ],
  "unclear": [ "things that are ambiguous, e.g. a date with no year, 'TBA', a cropped table row" ]
}

Rules:
- Resolve due_date to YYYY-MM-DD only when day and month are visible. Infer the year from context (the nearest sensible future date relative to today). If you cannot be sure, use null and put the written text in due_text and mention it in "unclear".
- estimated_hours is your realistic estimate of total student effort (study time for exams and quizzes). Use 0.5-40.
- One entry per item. Do not merge or skip rows of a table.`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/extract") return await extract(req, res);
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, { ok: true, model: MODEL, hasKey: Boolean(API_KEY) });
    if (req.method === "GET") return serveStatic(req, res);
    json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    json(res, err.status || 500, { error: err.publicMessage || "Internal error" });
  }
});

async function extract(req, res) {
  if (!API_KEY) return json(res, 500, { error: "GEMINI_API_KEY is not set. Add it to .env and restart." });
  const body = JSON.parse(await readBody(req));
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(body.image || "");
  if (!match) return json(res, 400, { error: "Send a PNG, JPEG, WebP or GIF image as a data URL." });
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);
  const courseHint = typeof body.course === "string" ? body.course.slice(0, 80) : "";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`;
  const request = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: match[1], data: match[2] } }, { text: buildPrompt(today, courseHint) }] }],
      generationConfig: { temperature: 0.1 },
    }),
  };
  // The API intermittently returns 429/5xx; retry with backoff.
  let upstream;
  for (let attempt = 0; attempt < 3; attempt++) {
    upstream = await fetch(url, request);
    if (upstream.status !== 429 && upstream.status < 500) break;
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return json(res, 502, { error: data.error?.message || `Gemini API returned ${upstream.status}` });

  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  const parsed = extractJson(text);
  if (!parsed) return json(res, 502, { error: "Model did not return valid JSON. Try again." });
  json(res, 200, { model: MODEL, result: normalize(parsed, courseHint) });
}

// Gemma may emit reasoning, code fences or repeated answers around the JSON.
// Scan for balanced top-level objects and return the last one that looks like our result.
function extractJson(text) {
  const candidates = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}" && depth > 0 && --depth === 0) candidates.push(text.slice(start, i + 1));
  }
  for (const raw of candidates.reverse()) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && Array.isArray(obj.items)) return obj;
    } catch {}
  }
  return null;
}

const str = (v) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null);

function validDate(v) {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + "T12:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}

function normalize(p, courseHint) {
  const course = courseHint || str(p.course);
  return {
    course,
    items: p.items
      .filter((i) => str(i?.title))
      .map((i) => {
        const hours = Number(i.estimated_hours);
        const weight = Number(i.weight_percent);
        return {
          course,
          title: str(i.title),
          type: TYPES.includes(i.type) ? i.type : "other",
          due_date: validDate(i.due_date),
          due_text: str(i.due_text),
          time: /^([01]\d|2[0-3]):[0-5]\d$/.test(i.time || "") ? i.time : null,
          weight_percent: Number.isFinite(weight) && weight > 0 && weight <= 100 ? weight : null,
          estimated_hours: Number.isFinite(hours) ? Math.min(40, Math.max(0.5, hours)) : 2,
          evidence: str(i.evidence),
        };
      }),
    unclear: (Array.isArray(p.unclear) ? p.unclear : []).map(str).filter(Boolean),
  };
}

function serveStatic(req, res) {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel === "/" ? "index.html" : rel));
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("too large"), { status: 413, publicMessage: "Image too large (max ~8MB)." }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function loadDotEnv(file) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line);
      if (m && !line.trim().startsWith("#") && !(m[1] in process.env) && m[2]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

server.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}  (model: ${MODEL}, key ${API_KEY ? "set" : "MISSING"})`);
});
