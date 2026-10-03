# StudyDesk

Screenshots of your syllabi and assignment sheets in. One deadline list and a balanced study plan out.

Gemma 4 reads the screenshots. Plain code builds the schedule, so the plan is instant, predictable and recalculates as you edit.

## Features

- **Multi-course input.** Drop in as many screenshots as you like. Syllabi, assignment sheets and exam schedules all work. Duplicates are merged.
- **Deadline list.** Each item has a title, course, type, date, estimated hours and grade weight, plus the quoted text from the screenshot it came from. Everything is editable. Ambiguous dates ("TBA", no year) are flagged instead of guessed.
- **Study plan.** Each deadline's hours are spread over the days before it, always filling the least-loaded day first, so work doesn't pile up the night before. You set hours per day, longest session, and whether to skip weekends.
- **Honest warnings.** Overdue items, undated items, and deadlines that can't fit in your capacity are called out.
- **Workload by week.** A bar per week shows when you're overloaded.
- **Calendar export.** Download an `.ics` file with deadlines and study sessions for Google Calendar, Apple Calendar or Outlook.
- **Private by default.** Your list and progress are stored in your browser (`localStorage`). Only the screenshots go to the Gemini API, through your own key.

## Run

Needs Node 18+. No `npm install`.

```
# put GEMINI_API_KEY=your-key in a .env file in this folder
npm start        # http://localhost:3000
npm test         # scheduler tests
```

`GEMMA_MODEL` (default `gemma-4-31b-it`) and `PORT` (default `3000`) are optional.

## Notes

- Gemma reasons before answering, so each screenshot takes 30-90 seconds. Up to two are processed at once.
- `estimated_hours` is a model guess. Check it, since the plan depends on it.
- The server pulls the last valid JSON object out of the model's reply, because Gemma can emit its reasoning and repeat the answer around it.
