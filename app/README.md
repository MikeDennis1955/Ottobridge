# Hand Review Table (source)

Published at https://claude.ai/artifact/P2JmxJ5n8Xdu3cGbzdBuUt

- `hands/*.hand` plain-text hand scripts (the format Mike edits)
- `model.ts` data model (copy of src/model.ts)
- `src/parse.ts` text format -> HandScript; `src/rules.ts` rules engine + validator; `src/app.ts` reviewer UI; `src/index.html` page + CSS
- Build: `npm i -D esbuild typescript && node build.mjs` -> dist/index.html (hands embedded)
- Mike's review notes live in the artifact's db, collection `notes` (doc id `<handId>~<step>`); his edited scripts in collection `scripts` (doc id = hand id).

## Other acceptable leads (2026-11-20)
Under a trick, `ok: H D` lists other suits that are fine to lead there. In Student mode a lead in one of those suits gets "That might work, but we think X is slightly better. Let's go that way." instead of a nudge, and play continues with the script's card.

## Defensive hands (Lesson 6, 2026-11-26)
The student sits South and East declares, so the student makes the opening lead.
- `lead planning:` section (instead of `planning:`): `declarer: 15-17 = why`, `dummy: 10-40 = why` (40 shows as "10 or more"), `partner: 0-5 = why`, plus `remind:` lines. The table asks for points before the lead; a single number or a range inside the script's range counts as right.
- Defending, the student picks only the opening lead and any card marked `*`; the rest plays itself. The opening lead is judged card by card (no touching-card equivalence).
- Lead notes can name a whole suit: `HQ not S: ...` covers any spade; a card note (`HQ not H5:`) wins over a suit note.
- `ok: C` under trick 1 makes a lead in that suit count as right too (the table follows the script's card); `ok: S` with the script's own suit accepts any card of that suit.
