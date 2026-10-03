// StudyDesk frontend. Model output is rendered via textContent / input.value only (never innerHTML).
const $ = (id) => document.getElementById(id);
const { fmt, addDays, daysBetween, toDate, buildPlan, weeklyLoad, toIcs } = Planner;
const STORE = "studydesk.v1";
const MAX_EDGE = 2000;
const CONCURRENCY = 2;
const TYPES = ["assignment", "exam", "quiz", "project", "reading", "lab", "other"];

const state = load();
let notes = []; // model "unclear" remarks from this session

function load() {
  const fresh = { items: [], doneSessions: {}, settings: { hoursPerDay: 3, maxSession: 2, skipWeekends: false } };
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    return s ? { ...fresh, ...s, settings: { ...fresh.settings, ...s.settings } } : fresh;
  } catch { return fresh; }
}
function save() { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} }

const today = () => fmt(new Date());
const uid = () => Math.random().toString(36).slice(2, 10);

function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.filter((k) => k != null));
  return n;
}

// ---------- uploading ----------
const queue = $("queue");

function toDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
      const c = el("canvas", { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => reject(new Error("Could not read image"));
    img.src = url;
  });
}

const pending = [];
let running = 0;

function enqueue(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const course = el("input", { type: "text", placeholder: "Course (optional)", ariaLabel: "Course name" });
    const status = el("span", { className: "st", textContent: "Queued" });
    queue.append(el("li", {}, el("span", { className: "name", textContent: file.name || "Pasted image", title: file.name }), course, status));
    pending.push({ file, course, status });
  }
  pump();
}

function pump() {
  while (running < CONCURRENCY && pending.length) {
    const job = pending.shift();
    running++;
    process(job).finally(() => { running--; pump(); });
  }
}

async function process({ file, course, status }) {
  const set = (text, cls = "") => { status.textContent = text; status.className = "st " + cls; };
  course.disabled = true;
  set("Reading with Gemma… (can take a minute)", "busy");
  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: await toDataUrl(file), today: today(), course: course.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    const added = addItems(data.result.items, file.name);
    notes.push(...data.result.unclear.map((n) => `${data.result.course || file.name}: ${n}`));
    set(`${added} new item${added === 1 ? "" : "s"}`, "ok");
  } catch (err) {
    set(err.message, "err");
  }
  renderAll();
}

function addItems(list, source) {
  const key = (i) => [i.course, i.title, i.due_date].map((x) => (x || "").toLowerCase()).join("|");
  const seen = new Set(state.items.map(key));
  let added = 0;
  for (const i of list) {
    if (seen.has(key(i))) continue;
    state.items.push({ ...i, id: uid(), done: false, source });
    seen.add(key(i));
    added++;
  }
  return added;
}

$("file").addEventListener("change", (e) => { enqueue([...e.target.files]); e.target.value = ""; });
$("drop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } });
for (const ev of ["dragenter", "dragover"]) $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); });
for (const ev of ["dragleave", "drop"]) $("drop").addEventListener(ev, () => $("drop").classList.remove("over"));
$("drop").addEventListener("drop", (e) => { e.preventDefault(); enqueue([...e.dataTransfer.files]); });
document.addEventListener("paste", (e) => enqueue([...(e.clipboardData?.files || [])]));

// ---------- settings ----------
const S = state.settings;
$("hpd").value = S.hoursPerDay;
$("sess").value = S.maxSession;
$("wk").checked = S.skipWeekends;
const num = (v, d) => (Number.isFinite(+v) && +v > 0 ? +v : d);
$("hpd").oninput = () => { S.hoursPerDay = num($("hpd").value, 3); save(); renderDerived(); };
$("sess").oninput = () => { S.maxSession = num($("sess").value, 2); save(); renderDerived(); };
$("wk").onchange = () => { S.skipWeekends = $("wk").checked; save(); renderDerived(); };

// ---------- rendering ----------
let plan = null;

function renderAll() {
  $("app").hidden = state.items.length === 0;
  renderDeadlines();
  renderDerived();
}

function renderDerived() {
  plan = buildPlan(state.items, { today: today(), ...S });
  renderStats();
  renderToday();
  renderAlerts();
  renderWeeks();
  renderPlan();
}

function field(type, value, onInput, props = {}) {
  const i = el("input", { type, value: value ?? "", ...props });
  i.oninput = () => onInput(i.value);
  return i;
}

function courseColor(course) {
  if (!course) return "var(--accent)";
  let h = 0;
  for (const ch of course.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 42%)`;
}

const TYPE_ICON = { assignment: "📝", exam: "🎯", quiz: "❓", project: "🛠️", reading: "📖", lab: "🧪", other: "📌" };

function urgency(item, left) {
  if (item.done) return ["ok", "Done"];
  if (left == null) return ["none", "No date"];
  if (left < 0) return ["overdue", countdown(left)];
  return [left <= 3 ? "soon" : "", countdown(left)];
}

function renderDeadlines() {
  const t = today();
  const sorted = [...state.items].sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999"));
  $("deadlines").replaceChildren(...sorted.map((item) => {
    const left = item.due_date ? daysBetween(t, item.due_date) : null;
    const [ucls, utext] = urgency(item, left);
    const box = el("input", { type: "checkbox", checked: item.done, title: "Mark done", ariaLabel: "Mark done" });
    const d = item.due_date && toDate(item.due_date);
    const block = el("div", { className: `dateblock ${item.done ? "" : ucls === "overdue" || ucls === "soon" ? ucls : item.due_date ? "" : "none"}` },
      el("b", { textContent: d ? String(d.getDate()) : "?" }),
      el("span", { textContent: d ? d.toLocaleDateString(undefined, { month: "short" }) : "TBA" }));
    const row = el("div", { className: `item${item.done ? " done" : ""}`, style: `--c:${courseColor(item.course)}` }, block, el("div", { className: "item-body" },
      el("div", { className: "item-top" },
        box,
        el("span", { textContent: TYPE_ICON[item.type] || "📌", title: item.type }),
        field("text", item.title, (v) => { item.title = v; save(); renderDerived(); }, { className: "title", ariaLabel: "Title" }),
        item.weight_percent ? el("span", { className: "chip", title: "Share of the grade", textContent: `${item.weight_percent}%` }) : null,
        el("span", { className: `pill ${ucls}`, textContent: utext }),
        el("button", { className: "x", title: "Delete", ariaLabel: "Delete", textContent: "×", onclick: () => { state.items = state.items.filter((i) => i !== item); save(); renderAll(); } })),
      el("div", { className: "item-meta" },
        field("text", item.course, (v) => { item.course = v || null; save(); renderDerived(); }, { className: "course", placeholder: "Course", ariaLabel: "Course" }),
        typeSelect(item),
        field("date", item.due_date, (v) => { item.due_date = v || null; save(); renderAll(); }, { ariaLabel: "Due date" }),
        field("number", item.estimated_hours, (v) => { item.estimated_hours = num(v, 1); save(); renderDerived(); }, { min: 0.5, step: 0.5, title: "Estimated study hours", ariaLabel: "Estimated hours" }),
        el("span", { className: "muted", textContent: "hours" })),
      item.due_text && !item.due_date ? el("div", { className: "note", textContent: `Written date: "${item.due_text}". Pick a date above to schedule it.` }) : null,
      item.evidence ? el("p", { className: "evidence", textContent: `“${item.evidence}”` }) : null));
    box.onchange = () => { item.done = box.checked; save(); renderAll(); };
    return row;
  }));
}

function typeSelect(item) {
  const s = el("select", { ariaLabel: "Type" }, ...TYPES.map((t) => el("option", { value: t, textContent: t, selected: t === item.type })));
  s.onchange = () => { item.type = s.value; save(); renderDeadlines(); };
  return s;
}

function countdown(left) {
  if (left == null) return "no date";
  if (left < 0) return `${-left}d overdue`;
  return left === 0 ? "today" : left === 1 ? "tomorrow" : `in ${left}d`;
}

const itemById = (id) => state.items.find((i) => i.id === id);
const hrs = (h) => `${Math.round(h * 10) / 10}h`;

function renderStats() {
  const t = today();
  const open = state.items.filter((i) => !i.done);
  const upcoming = open.filter((i) => i.due_date && i.due_date >= t).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const thisWeek = upcoming.filter((i) => daysBetween(t, i.due_date) <= 7).length;
  const overdue = open.filter((i) => i.due_date && i.due_date < t).length;
  const next = upcoming[0];
  const stat = (value, label, cls = "", small = false) =>
    el("div", { className: `stat ${cls}` }, el("div", { className: `v${small ? " sm" : ""}`, textContent: value }), el("div", { className: "l", textContent: label }));
  $("stats").replaceChildren(
    stat(String(open.length), "Open items"),
    stat(hrs(open.reduce((n, i) => n + i.estimated_hours, 0)), "Work remaining"),
    stat(String(overdue || thisWeek), overdue ? "Overdue" : "Due this week", overdue ? "hot" : ""),
    stat(next ? `${next.title} · ${countdown(daysBetween(t, next.due_date))}` : "Nothing upcoming", "Next up", "", true));
}

function renderToday() {
  const t = today();
  const mine = plan.sessions.filter((s) => s.date === t);
  $("today").replaceChildren(
    el("h2", { textContent: "☀️ Today" }),
    el("div", { className: "big", textContent: hrs(plan.load[t] || 0) }),
    el("div", { className: "muted", textContent: mine.length ? "planned study time" : "Nothing scheduled today. Enjoy it, or get ahead." }),
    ...mine.slice(0, 4).map((s) => {
      const item = itemById(s.itemId);
      return el("div", { className: "row" }, el("span", { textContent: item?.title }), el("strong", { textContent: hrs(s.hours) }));
    }));
}

function renderAlerts() {
  const t = today();
  const out = [];
  const overdue = state.items.filter((i) => !i.done && i.due_date && i.due_date < t);
  if (overdue.length) out.push(["bad", `${overdue.length} overdue: ${overdue.map((i) => i.title).join(", ")}`]);
  const undated = state.items.filter((i) => !i.done && !i.due_date);
  if (undated.length) out.push(["", `${undated.length} item${undated.length > 1 ? "s have" : " has"} no date and can't be scheduled yet: ${undated.map((i) => i.title).join(", ")}`]);
  for (const u of plan.unscheduled) {
    out.push(["bad", `Not enough capacity: ${u.item.title} still needs ${hrs(u.hours)} before ${u.item.due_date}. Raise your daily hours, skip nothing, or ask for an extension.`]);
  }
  for (const n of notes) out.push(["", `Gemma flagged: ${n}`]);
  $("alerts").replaceChildren(...out.map(([c, m]) => el("div", { className: `alert ${c}`, textContent: m })));
}

function renderWeeks() {
  const weeks = weeklyLoad(plan.load);
  const cap = S.hoursPerDay * (S.skipWeekends ? 5 : 7);
  const max = Math.max(cap, ...weeks.map(([, h]) => h), 1);
  $("weeks").replaceChildren(...(weeks.length ? weeks.map(([w, h]) =>
    el("div", { className: "week" },
      el("span", { textContent: `Week of ${toDate(w).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` }),
      el("div", { className: "track" }, el("div", { className: "fill" + (h >= cap - 1e-9 ? " over" : ""), style: `width:${(h / max) * 100}%` })),
      el("span", { textContent: hrs(h) }))) : [el("div", { className: "muted", textContent: "No scheduled work yet." })]));
}

function dayLabel(d) {
  const n = daysBetween(today(), d);
  const base = toDate(d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return n === 0 ? `Today · ${base}` : n === 1 ? `Tomorrow · ${base}` : base;
}

function renderPlan() {
  const days = [...new Set(plan.sessions.map((s) => s.date))];
  $("plan").replaceChildren(...(days.length ? days.map((d) =>
    el("div", { className: "day" + (d === today() ? " today" : "") },
      el("h3", { textContent: dayLabel(d) }, el("small", { textContent: hrs(plan.load[d]) })),
      ...plan.sessions.filter((s) => s.date === d).map((s) => {
        const item = itemById(s.itemId);
        const key = `${d}|${s.itemId}`;
        const box = el("input", { type: "checkbox", checked: !!state.doneSessions[key] });
        const label = el("label", { className: "session" + (state.doneSessions[key] ? " done" : ""), style: `--c:${courseColor(item.course)}` }, box,
          el("span", { className: "h", textContent: hrs(s.hours) }),
          el("span", { className: "t", textContent: `${item.title}${item.course ? ` · ${item.course}` : ""}` }),
          el("span", { className: "d", textContent: `due ${countdown(daysBetween(today(), item.due_date))}` }));
        box.onchange = () => { state.doneSessions[key] = box.checked; save(); label.classList.toggle("done", box.checked); };
        return label;
      }))) : [el("div", { className: "empty", textContent: "Add dates and estimates to see your plan." })]));
}

// ---------- actions ----------
$("add").onclick = () => {
  state.items.push({ id: uid(), course: null, title: "New item", type: "assignment", due_date: addDays(today(), 7), due_text: null, time: null, weight_percent: null, estimated_hours: 2, evidence: null, done: false, source: "manual" });
  save(); renderAll();
};

$("clear").onclick = () => {
  if (!confirm("Delete all deadlines and progress?")) return;
  state.items = []; state.doneSessions = {}; notes = [];
  save(); queue.replaceChildren(); renderAll();
};

$("ics").onclick = () => {
  const a = el("a", { href: URL.createObjectURL(new Blob([toIcs(state.items.filter((i) => !i.done), plan.sessions)], { type: "text/calendar" })), download: "studydesk.ics" });
  a.click();
  URL.revokeObjectURL(a.href);
};

// Sample data, dated relative to today, so the app can be tried without a screenshot or API key.
function loadDemo() {
  const t = today();
  const mk = (course, title, type, days, hours, weight, evidence) => ({
    course, title, type, due_date: addDays(t, days), due_text: null, time: null, weight_percent: weight, estimated_hours: hours, evidence,
  });
  addItems([
    mk("CS 201", "Assignment 1: BST implementation", "assignment", 6, 6, 10, "Assignment 1 (BST implementation) Due Oct 14 10%"),
    mk("CS 201", "Quiz 1: Arrays and lists", "quiz", 12, 3, 5, "Quiz 1 (Arrays and lists) Oct 21 5%"),
    mk("CS 201", "Midterm exam", "exam", 20, 12, 25, "Midterm Exam Nov 4, 6:00 PM 25%"),
    mk("MATH 120", "Problem set 4", "assignment", 3, 4, 8, "Problem Set 4 due Friday"),
    mk("MATH 120", "Calculus exam 2", "exam", 14, 10, 30, "Exam 2: Chapters 5-8"),
    mk("ENG 110", "Essay draft", "project", 9, 7, 15, "Essay draft due, 1500 words"),
    mk("ENG 110", "Reading: Chapter 3", "reading", 1, 1.5, null, "Read Chapter 3 before Thursday"),
  ], "demo");
  state.items.push({ id: uid(), course: "BIO 101", title: "Lab report", type: "lab", due_date: null, due_text: "TBA", time: null, weight_percent: 10, estimated_hours: 4, evidence: "Lab report due TBA", done: false, source: "demo" });
  save(); renderAll();
}
$("demo").onclick = loadDemo;

renderAll();
if (location.search.includes("demo") && !state.items.length) loadDemo();
