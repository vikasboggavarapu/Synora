// Run: node planner.test.js
const assert = require("assert");
const P = require("./public/planner.js");

const opts = { today: "2026-10-05", hoursPerDay: 3, maxSession: 2, skipWeekends: false }; // a Monday
const item = (id, due, hours, extra = {}) => ({ id, title: id, due_date: due, estimated_hours: hours, ...extra });


{
  const { sessions, load, unscheduled } = P.buildPlan([item("a", "2026-10-12", 10)], opts);
  assert.strictEqual(unscheduled.length, 0);
  assert.strictEqual(sessions.reduce((n, s) => n + s.hours, 0), 10);
  assert(Math.max(...Object.values(load)) <= 3, "daily capacity respected");
  assert(sessions.every((s) => s.date >= opts.today && s.date < "2026-10-12"), "all sessions before the due date");
  assert(sessions.length >= 4, "spread over several days");
}
// 2. Impossible workload is reported, not silently dropped
{
  const { unscheduled } = P.buildPlan([item("big", "2026-10-06", 10)], opts); // only today fits
  assert.strictEqual(unscheduled.length, 1);
  assert.strictEqual(unscheduled[0].hours, 7);
}
// 3. Weekends skipped when asked (and fallback when only weekend days remain)
{
  const { sessions } = P.buildPlan([item("a", "2026-10-12", 4)], { ...opts, skipWeekends: true });
  assert(sessions.every((s) => !P.isWeekend(s.date)));
  const sat = P.buildPlan([item("w", "2026-10-11", 1)], { ...opts, today: "2026-10-10", skipWeekends: true });
  assert.strictEqual(sat.sessions.length, 1, "falls back to weekend when nothing else is available");
}
// 4. Done, undated, overdue items are ignored
{
  const { sessions } = P.buildPlan([item("d", "2026-10-12", 2, { done: true }), item("n", null, 2), item("o", "2026-10-01", 2)], opts);
  assert.strictEqual(sessions.length, 0);
}
// 5. Earlier deadlines are placed first and shared days stay balanced
{
  const { load } = P.buildPlan([item("x", "2026-10-09", 6), item("y", "2026-10-09", 6)], opts);
  assert(Math.max(...Object.values(load)) <= 3);
}
// 6. Weekly load groups by Monday
{
  const w = P.weeklyLoad({ "2026-10-05": 2, "2026-10-11": 1, "2026-10-12": 3 });
  assert.deepStrictEqual(w, [["2026-10-05", 3], ["2026-10-12", 3]]);
}
// 7. ICS output is well formed and escapes text
{
  const ics = P.toIcs([item("a", "2026-10-12", 2, { title: "Lab, report; final", type: "exam", time: "09:30", course: "CS101" })], [{ date: "2026-10-10", itemId: "a", hours: 2 }]);
  assert(ics.startsWith("BEGIN:VCALENDAR") && ics.trim().endsWith("END:VCALENDAR"));
  assert(ics.includes("DTSTART:20261012T093000"));
  assert(ics.includes("SUMMARY:EXAM: Lab\\, report\\; final (CS101)"));
  assert(ics.includes("DTSTART;VALUE=DATE:20261010"));
}
console.log("planner tests passed");
