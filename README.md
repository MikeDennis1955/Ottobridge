# Ottobridge

A practice app for beginning and advanced-beginner bridge students. Each lesson's text is
paired with scripted practice hands: the student bids and plays, and the app follows a
prepared script (Autobridge style), with notes at the key moments.

This repository is the **source of truth** for the app's code, hand scripts and lesson texts.

## What's where

| Folder | Contents |
| --- | --- |
| `app/src/` | The app (TypeScript + one HTML page). `lessons.ts` holds lesson text split by concept; `model.ts` is the data model. |
| `app/hands/` | One plain-text `.hand` script per practice hand, e.g. `L03-08.hand`. |
| `app/build.mjs` | Builds everything into a single page, `app/dist/index.html`. |
| `tools/` | Authoring-time helpers: double-dummy solver (`dd.c`) and Python scripts that check hand scripts. See `tools/README.md`. |
| `lessons/` | Mike's lesson texts (PDF / text). |
| `reports/` | Output of script checks. |

## Build and run locally

```sh
cd app
npm ci          # first time only
npm run build   # writes app/dist/index.html
```

Open `app/dist/index.html` in a browser. It is a static page with no server.

## Where the app is published

- **Claude artifact** (used for review, including Reviewer mode notes and recorded play):
  https://claude.ai/artifact/P2JmxJ5n8Xdu3cGbzdBuUt. Claude republishes it from `app/dist/index.html`.
- **GitHub Pages** (public student link, once enabled): every push to `main` runs
  `.github/workflows/pages.yml`, which builds the app and deploys it. On Pages, review notes and
  recordings are kept in the browser only (the shared notes store exists only in the artifact).

## Working rules (for Claude threads)

1. Make changes in this repo on a branch, open a pull request, and merge to `main`.
2. After merging, rebuild and republish the artifact from `app/dist/index.html` as before,
   and copy changed files back to the project folder (`/mnt/project-files/app/...`) so threads
   still reading it see the current version.
3. Mike's in-browser script edits and recordings arrive through the artifact's database
   (collections `scripts`, `recordings`, `notes`). Bring them into the repo as commits.
