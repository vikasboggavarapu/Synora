// Pure scheduling helpers. Dates are local "YYYY-MM-DD" strings. Works in browsers and Node.
(function (root) {
  const WINDOW_DAYS = 14; // never start earlier than this many days before a deadline

  const toDate = (s) => new Date(s + "T12:00:00"); // noon avoids DST edge cases
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return fmt(d); };
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 864e5);
  const isWeekend = (s) => [0, 6].includes(toDate(s).getDay());
  const weekStart = (s) => { const d = toDate(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return fmt(d); }; // Monday

  // Spread each open item's hours over the days before its due date, always filling the
  // least-loaded day first so work never piles up right before a deadline.
  function buildPlan(items, { today, hoursPerDay, maxSession, skipWeekends }) {
    const load = {};
    const merged = {}; // "date|itemId" -> session
    const unscheduled = []; // { item, hours } that did not fit in capacity

    const open = items
      .filter((i) => !i.done && i.due_date && i.due_date >= today && i.estimated_hours > 0)
      .sort((a, b) => a.due_date.localeCompare(b.due_date) || b.estimated_hours - a.estimated_hours);

    for (const item of open) {
      const last = item.due_date === today ? today : addDays(item.due_date, -1);
      let days = [];
      for (let d = [today, addDays(item.due_date, -WINDOW_DAYS)].sort().pop(); d <= last; d = addDays(d, 1)) days.push(d);
      const weekdays = days.filter((d) => !isWeekend(d));
      if (skipWeekends && weekdays.length) days = weekdays;

      let remaining = item.estimated_hours;
      while (remaining > 1e-9) {
        const free = days.filter((d) => hoursPerDay - (load[d] || 0) > 1e-9);
        if (!free.length) { unscheduled.push({ item, hours: remaining }); break; }
        const day = free.reduce((best, d) => ((load[d] || 0) < (load[best] || 0) ? d : best)); // ties: earliest
        const chunk = Math.min(remaining, maxSession, hoursPerDay - (load[day] || 0)); // partial session if the day is nearly full
        load[day] = (load[day] || 0) + chunk;
        const key = `${day}|${item.id}`;
        (merged[key] ||= { date: day, itemId: item.id, hours: 0 }).hours += chunk;
        remaining -= chunk;
      }
    }

    const sessions = Object.values(merged).sort((a, b) => a.date.localeCompare(b.date) || a.itemId.localeCompare(b.itemId));
    return { sessions, load, unscheduled };
  }

  // Hours of planned work per Monday-start week, for the workload chart.
  function weeklyLoad(load) {
    const weeks = {};
    for (const [d, h] of Object.entries(load)) weeks[weekStart(d)] = (weeks[weekStart(d)] || 0) + h;
    return Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b));
  }

  const icsEscape = (s) => String(s).replace(/[\\;,]/g, (m) => "\\" + m).replace(/\r?\n/g, "\\n");
  const icsDate = (s) => s.replace(/-/g, "");

  function toIcs(items, sessions, now = new Date()) {
    const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    const ev = [];
    for (const i of items.filter((i) => i.due_date)) {
      const start = i.time ? `DTSTART:${icsDate(i.due_date)}T${i.time.replace(":", "")}00` : `DTSTART;VALUE=DATE:${icsDate(i.due_date)}`;
      const end = i.time ? null : `DTEND;VALUE=DATE:${icsDate(addDays(i.due_date, 1))}`;
      ev.push(["BEGIN:VEVENT", `UID:due-${i.id}@studydesk`, `DTSTAMP:${stamp}`, start, end,
        `SUMMARY:${icsEscape(`${i.type === "exam" ? "EXAM" : "DUE"}: ${i.title}${i.course ? ` (${i.course})` : ""}`)}`,
        i.weight_percent ? `DESCRIPTION:${icsEscape(`Worth ${i.weight_percent}% of the grade`)}` : null,
        "END:VEVENT"].filter(Boolean).join("\r\n"));
    }
    for (const s of sessions) {
      const i = byId[s.itemId];
      if (!i) continue;
      ev.push(["BEGIN:VEVENT", `UID:study-${s.itemId}-${s.date}@studydesk`, `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(s.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(s.date, 1))}`,
        `SUMMARY:${icsEscape(`Study ${s.hours}h: ${i.title}`)}`, "TRANSP:TRANSPARENT", "END:VEVENT"].join("\r\n"));
    }
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StudyDesk//EN", ...ev, "END:VCALENDAR"].join("\r\n") + "\r\n";
  }

  const api = { toDate, fmt, addDays, daysBetween, isWeekend, weekStart, buildPlan, weeklyLoad, toIcs };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Planner = api;
})(typeof window !== "undefined" ? window : globalThis);
