# Naukri Auto-Apply (Playwright)

Automates logging into your Naukri account, **updating your resume** (which bumps
your profile in recruiter searches), then searching for jobs matching your
keywords/locations/experience, filtering to jobs posted in the last 24 hours, and
clicking Apply on the ones that Naukri can complete in one click ("Easy Apply" style).

## Setup

```bash
cd naukri-auto-apply
npm install
npx playwright install chromium
cp .env.example .env
# then edit .env — fill in your credentials & preferences
```

Drop your resume in the project root as `resume.pdf` (or point `RESUME_PATH` in
`.env` at another file — `.pdf/.doc/.docx/.rtf`, max 2MB).

## Run

```bash
# Dry run first — collects jobs, reports what it would apply to, applies to nothing.
npm run dry

# Just update the resume on your Naukri profile.
npm run resume

# Just apply to jobs.
npm start

# Just apply to Recommended jobs (see "Recommended jobs" below).
npm run recommended
npm run recommended-dry   # report what it would apply to, click nothing

# Just share interest on Early access roles (see "Early access roles" below).
npm run early-access
npm run early-access-dry   # report what it would share interest on, click nothing

# Do all of it (resume update + apply + recommended + early-access interest) in one login —
# this is what the daily schedule runs.
npm run daily
```

Applied job IDs are saved in `applied.json` so re-runs skip them.
Login session is cached in `storage-state.json` so you don't re-authenticate every run.

## Resume update

`npm run resume` (and the combined `npm run daily`) opens your Naukri profile and
replaces your existing resume with the file at `RESUME_PATH` (default `resume.pdf`
in the project root). Re-uploading also refreshes your profile's **"last updated"**
timestamp, which is the signal Naukri uses to rank you higher in recruiter
searches — so a daily resume refresh keeps you near the top.

The upload uses Naukri's profile resume `<input type="file">`. If Naukri changes
that control and you start seeing `no-file-input`, open your profile, Inspect the
"Update resume" button, and add its selector to `FILE_INPUT_SELECTORS` in
`resume.js`. Screenshots of each attempt land in `screenshots/`.

## Recommended jobs

After the search-based apply flow, the daily run opens the homepage, clicks
**View all** on the "Jobs based on your profile / applies" widget, and lands on
Naukri's **Recommended jobs** page. It then walks the tabs one by one —
**Profile → Applies → Preferences → You might like** — and applies to the
relevant jobs on each tab (same apply logic as the search flow: one-click applies, chatbot
handling per `SKIP_CHATBOT`, external-site jobs skipped per `SKIP_EXTERNAL`).

- Jobs that appear in several tabs are only tried once; everything handled is
  recorded in `applied.json`, so re-runs skip it.
- By default (`RECOMMENDED_FILTER=true`) a job is applied to only if it passes
  all three checks:
  - **Role**: the title matches the search flow's allowed roles (Java developer,
    software engineer, …) and isn't excluded (senior/lead/manager, .NET, PHP,
    sales, testing, …).
  - **Skills**: at least `MIN_SKILL_MATCH` (default 1) of `SKILLS` (defaults to
    `KEYWORDS`) appear on the card. If the card doesn't show them, the job page's
    description and key skills are checked before applying.
  - **Experience**: the job's band overlaps `MIN_EXPERIENCE`–`MAX_EXPERIENCE`
    (read from the job page if the card doesn't show it; jobs with no
    experience range are skipped).

  Jobs rejected on the job page are recorded in `applied.json` so they aren't
  reopened. Set `RECOMMENDED_FILTER=false` to apply to every recommended job.
- `RECOMMENDED_MAX_PER_TAB` (default 25, `0` = no cap) limits apply attempts per
  tab per run. Naukri also enforces its own daily apply limit.
- Turn the step off with `RECOMMENDED=false`.

## Early access roles

After the apply flow, the daily run opens Naukri's **"Early access roles"**
section and clicks **Share interest** on roles matching this salary rule
(amounts in LPA, i.e. lakhs per annum):

- Salary range shown → share interest when the **lower bound ≥ 5** OR the
  **upper bound ≥ 9** (e.g. `5-8 Lacs PA` and `3-9 Lacs PA` qualify;
  `3-7 Lacs PA` doesn't).
- No salary range shown ("Not disclosed") → share interest anyway.

Thresholds are configurable via `EARLY_ACCESS_MIN_SALARY_LOWER` /
`EARLY_ACCESS_MIN_SALARY_UPPER` in `.env`, the per-run cap via
`EARLY_ACCESS_MAX_INTERESTS`, and the whole step can be turned off with
`EARLY_ACCESS=false`. Roles already interest-shared are remembered in
`early-access-shared.json` so re-runs skip them. Run it standalone with
`npm run early-access` (or `npm run early-access-dry` to preview).

## What it does / doesn't do

- ✅ Applies to Naukri "one-click" jobs.
- ⏭️ Skips jobs that redirect to a company website (each company site is different — not automatable generically).
- 💬 Jobs with a chatbot (extra questions) modal: by default (`SKIP_CHATBOT=true`) these are skipped. Set `SKIP_CHATBOT=false` to auto-answer them instead, using a fixed profile (notice period, CTC, location, relocation, skill experience, etc.) from `.env` — see "Chatbot auto-answer" below. No AI/API is used; it's pure keyword matching against your fixed answers.
- ⚠️ Naukri may show OTP / captcha on login — the script pauses up to 3 minutes for you to solve it in the visible browser window.

## Chatbot auto-answer

When `SKIP_CHATBOT=false`, `handleChatbot()` in `apply.js` reads each bot question,
matches it against a rule set (`CHATBOT_RULES`) and answers from `.env`:

| Question about | Answer |
|---|---|
| Experience in a skill | `DEFAULT_SKILL_EXPERIENCE_YEARS` (2) if the skill is in `SKILLS` / `KEYWORDS` (or `SKILL_EXPERIENCE_OVERRIDES`, which sets a per-skill value), else `0`. Yes/No chips → Yes / No. No skill named → `TOTAL_EXPERIENCE_YEARS`. |
| Relocation | `Yes` if the job location (or the city in the question) is in `PREFERRED_LOCATIONS` (falls back to `LOCATIONS`), else `No`. |
| Face-to-face / offline / walk-in interview | `Yes` if the job location is `CURRENT_LOCATION`, else `No`. |
| Current CTC | `CURRENT_CTC` (text form); if the field rejects text or wants digits/rupees → `CURRENT_CTC_NUMBER`; "in lakhs" questions and salary chips → lakh value. |
| Expected CTC | `EXPECTED_CTC` (text form); if the field needs a number → `EXPECTED_CTC_NUMBER`; lakh questions use its lakh value. |
| Notice period, current/preferred location, designation, education | the matching `.env` field. |

City names are compared with aliases (Bengaluru = Bangalore, Gurgaon = Gurugram, Bombay = Mumbai).

Every question the chatbot asks and every answer given is logged:

- **Console**: `💬 Q1: "<question>"  [options]` followed by `A: "<answer>"  (rule: <name>)`.
- **`chatbot-qa.log`**: plain text, one block per job (title, company, location,
  URL, each Q with its options and answer, any rejected answer that was retried,
  and the final outcome). Easiest file to skim after a run.
- **`chatbot-log.json`**: the same data as JSON.

Both are included in the GitHub Actions run artifacts.

If a question doesn't match any rule, it is **never guessed**: the job is
marked `skipped` with reason `chatbot-unmatched: <question text>`, a
screenshot is saved, the question is logged with `A: (no answer — no matching rule)`,
and it's added to `chatbot-answers.json`. Fill in its `answer` there, or add a
rule to `CHATBOT_RULES` in `apply.js`.

## Tuning

Edit `.env`:
- `KEYWORDS` — comma-separated (each becomes a search).
- `LOCATIONS` — comma-separated (blank = all India).
- `MIN_EXPERIENCE` / `MAX_EXPERIENCE` — years.
- `POSTED_WITHIN_HOURS` — Naukri's filter granularity is 1 day, so 24 is the tightest useful value.
- `MAX_APPLIES_PER_KEYWORD` — hard cap per keyword-location pair.
- `HEADLESS=false` recommended so you can watch, intervene on OTP, and abort if anything looks wrong.

## Caveats

- Naukri's Terms of Service restrict automated access. Use at your own discretion — a low per-run cap and human-like delays reduce risk of your account being flagged.
- Your Naukri profile should already be complete (resume uploaded, current CTC / expected CTC / notice period filled in). Missing profile fields cause many applies to fail silently — the script screenshots those into `screenshots/`.
- Selectors are Naukri's public DOM — they change. If you see many `no-apply-button` skips, open a job page manually, right-click the Apply button → Inspect, and update the selector in `apply.js`.

## Scheduling — four times daily via GitHub Actions

The repo ships a workflow at `.github/workflows/daily.yml` that runs
`node run.js` (resume update + auto-apply) every day at **04:30, 08:30, 11:30,
and 14:30 IST**. GitHub cron is UTC-only; the corresponding schedules are
`'0 23 * * *'`, `'0 3 * * *'`, `'0 6 * * *'`, and `'0 9 * * *'`. These start
one hour before the previous scheduled times.
You can also trigger it by hand from the repo's **Actions** tab ("Run workflow").

### ⚠️ Read this first — the headless caveat

GitHub Actions runs **headless in the cloud**, so it can't help you past an
OTP/captcha the way a visible local browser can. The cloud run therefore depends
on a **valid saved session** (`storage-state.json`). You seed that session once
(locally), store it as a secret, and the workflow caches it between runs. Naukri
sessions expire every so often — when a run starts failing at login, re-seed the
secret (below). If you'd rather not deal with this, run `npm run daily` from a
local cron / launchd job instead, where a browser can pop up for OTP.

### 1. Push the repo to GitHub

Your `.gitignore` already excludes `.env`, `storage-state.json`, and the result
logs, so no secrets get committed. **Keep the repo private** if you commit
`resume.pdf` (it's your personal document) — or use the resume secret in step 3.

### 2. Add repository secrets

Repo → **Settings → Secrets and variables → Actions → Secrets**:

| Secret | Value |
| --- | --- |
| `NAUKRI_EMAIL` | your Naukri email |
| `NAUKRI_PASSWORD` | your Naukri password |
| `NAUKRI_STORAGE_STATE_B64` | base64 of your local `storage-state.json` (see "Seeding the session secret") |
| `RESUME_PDF_B64` | *(optional)* base64 of your resume, if you don't want to commit `resume.pdf` |

### 3. Add repository variables (search config)

Repo → **Settings → Secrets and variables → Actions → Variables**. These mirror
the non-secret fields in `.env` (e.g. `KEYWORDS`, `LOCATIONS`, `MIN_EXPERIENCE`,
`MAX_APPLIES_PER_KEYWORD`, `SKIP_CHATBOT`, and the chatbot-profile fields). Any you
leave unset fall back to the defaults in `lib.js`. Set at least `KEYWORDS`.

### Seeding the session secret

Run the tool once locally so it logs in and writes `storage-state.json`, then
base64-encode it into the secret:

```bash
npm start            # log in (solve any OTP/captcha in the visible browser)
# macOS / Linux:
base64 -i storage-state.json | pbcopy      # macOS — now paste into the secret
base64 -w0 storage-state.json              # Linux — copy the output
```

Paste the result as `NAUKRI_STORAGE_STATE_B64`. To seed the resume secret the same
way: `base64 -i resume.pdf | pbcopy` → `RESUME_PDF_B64`.

After the first cloud run, the workflow caches the refreshed session (via
`actions/cache`) and reuses it, so you only re-seed when the session actually
expires. Each run's screenshots and result logs are uploaded as a downloadable
**artifact** on the run page for debugging.

### Alternative: local schedule (more reliable for OTP)

On macOS, a `launchd`/cron job avoids the headless-OTP problem entirely:

```cron
# crontab -e  → run 9 AM daily (Mac must be awake)
0 9 * * * cd /path/to/naukri-auto-apply && /usr/local/bin/node run.js >> cron.log 2>&1
```
