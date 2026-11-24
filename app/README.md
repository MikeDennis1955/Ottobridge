# Hand Review Table (source)

Published at https://claude.ai/artifact/P2JmxJ5n8Xdu3cGbzdBuUt

- `hands/*.hand` plain-text hand scripts (the format Mike edits)
- `model.ts` data model (copy of src/model.ts)
- `src/parse.ts` text format -> HandScript; `src/rules.ts` rules engine + validator; `src/app.ts` reviewer UI; `src/index.html` page + CSS
- Build: `npm i -D esbuild typescript && node build.mjs` -> dist/index.html (hands embedded)
- Mike's review notes live in the artifact's db, collection `notes` (doc id `<handId>~<step>`); his edited scripts in collection `scripts` (doc id = hand id).

## Other acceptable leads (2026-11-20)
Under a trick, `ok: H D` lists other suits that are fine to lead there. In Student mode a lead in one of those suits gets "That might work, but we think X is slightly better. Let's go that way." instead of a nudge, and play continues with the script's card.
