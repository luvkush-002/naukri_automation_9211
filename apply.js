// Naukri auto-apply flow.
// Searches for jobs matching your keywords/locations/experience, filters to
// relevant roles posted recently, and clicks Apply on the ones Naukri can
// complete in one click. Shared login/browser/config infra lives in lib.js.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  cfg, log, sleep, jitter, screenshot, STORAGE_STATE,
  requireCreds, launchContext, ensureLoggedIn, isMainModule,
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APPLIED_LOG = path.join(__dirname, 'applied.json');
const RESULTS_CSV = path.join(__dirname, 'results.csv');
const RESULTS_JSON = path.join(__dirname, 'results.json');
const CHATBOT_LOG = path.join(__dirname, 'chatbot-log.json');
const CHATBOT_ANSWERS = path.join(__dirname, 'chatbot-answers.json');
const CHATBOT_QA_LOG = path.join(__dirname, 'chatbot-qa.log');

export function loadApplied() {
  try { return new Set(JSON.parse(fs.readFileSync(APPLIED_LOG, 'utf8'))); }
  catch { return new Set(); }
}
export function saveApplied(set) {
  fs.writeFileSync(APPLIED_LOG, JSON.stringify([...set], null, 2));
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function ensureCsvHeader() {
  if (!fs.existsSync(RESULTS_CSV)) {
    fs.writeFileSync(RESULTS_CSV, 'timestamp,jobId,role,company,status,reason,url\n');
  }
}
export function appendResult(r) {
  ensureCsvHeader();
  const row = [
    new Date().toISOString(),
    r.id, r.title, r.company, r.status, r.reason, r.url,
  ].map(csvEscape).join(',') + '\n';
  fs.appendFileSync(RESULTS_CSV, row);

  let all = [];
  try { all = JSON.parse(fs.readFileSync(RESULTS_JSON, 'utf8')); } catch {}
  all.push({ timestamp: new Date().toISOString(), ...r });
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(all, null, 2));
}

// ---------- Search URL ----------
function jobAgeParam(hours) {
  return Math.max(1, Math.ceil(hours / 24));
}

function buildSearchUrl(keyword, location) {
  const kw = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const loc = location ? location.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
  const p = loc ? `${kw}-jobs-in-${loc}` : `${kw}-jobs`;
  const params = new URLSearchParams();
  params.set('k', keyword);
  if (location) params.set('l', location);
  // Naukri's `experience` param is a single value (not a min-max range) — it
  // matches jobs whose posted experience band *contains* this value. Passing
  // the midpoint of [minExp, maxExp] keeps us inside the desired band without
  // biasing toward either edge. The real min/max enforcement happens in
  // `experienceMatches()` below, using the experience text on each job card.
  const midExp = Math.round((cfg.minExp + cfg.maxExp) / 2);
  params.set('experience', String(midExp));
  params.set('jobAge', String(jobAgeParam(cfg.postedWithinHours)));
  return `https://www.naukri.com/${p}?${params.toString()}`;
}

// ---------- Role / skill / experience relevance filter ----------
// The user only wants to apply to Java-focused roles at 1-3 yrs experience.
// Naukri's keyword search is fuzzy and returns plenty of unrelated titles
// (e.g. ".NET developer", "manual tester", "sales") for broad keywords like
// "java" or "microservices". We filter locally on: (1) job title matches an
// allowed role pattern, (2) generic titles (e.g. "software engineer") must
// also show a Java/Spring Boot skill on the card, and (3) the experience
// range shown on the card overlaps [MIN_EXPERIENCE, MAX_EXPERIENCE].
const ROLE_TITLE_PATTERNS = [
  /java\s*(?:backend|back-end)\s*developer/i,
  /java\s*full[\s-]*stack\s*developer/i,
  /junior\s*java\s*developer/i,
  /java\s*developer/i,
  /associate\s*software\s*engineer/i,
  /software\s*(?:development\s*)?engineer/i,
  /software\s*developer/i,
];

// Titles that don't inherently imply Java — require a Java/Spring Boot skill
// mention on the card (title or key-skills chips) before accepting them.
const GENERIC_TITLE_PATTERN = /^(?!.*java).*(software\s*(?:development\s*)?engineer|associate\s*software\s*engineer|software\s*developer)/i;

const REQUIRED_SKILL_PATTERNS = [/java\b/i, /spring\s*boot/i, /springboot/i, /spring\s*security/i, /microservices?/i];

// Titles that signal a clearly unrelated/unwanted stack — reject outright
// even if a role pattern above happens to also match.
const EXCLUDE_TITLE_PATTERNS = [
  /\.net/i, /\bphp\b/i, /\bpython\b(?!.*java)/i, /\bnode\.?js\b(?!.*java)/i,
  /\breact\b(?!.*java)/i, /\bandroid\b/i, /\bios\b/i, /\bsales\b/i, /\bmarketing\b/i,
  /\bbusiness\s*development\b/i, /\bbpo\b/i, /\bhr\b/i, /\btester\b/i, /manual\s*testing/i,
  /\bqa\s*engineer\b(?!.*java)/i, /\bsenior\b/i, /\blead\b/i, /\bmanager\b/i, /\barchitect\b/i,
];

export function titleIsRelevant(title, skillText) {
  const t = title || '';
  if (EXCLUDE_TITLE_PATTERNS.some(re => re.test(t))) return false;
  if (!ROLE_TITLE_PATTERNS.some(re => re.test(t))) return false;
  if (GENERIC_TITLE_PATTERN.test(t)) {
    const combined = `${t} ${skillText || ''}`;
    if (!REQUIRED_SKILL_PATTERNS.some(re => re.test(combined))) return false;
  }
  return true;
}

// Parses experience text like "1-3 Yrs", "2-5 Yrs", "3+ Yrs" from a job card.
export function extractExperienceRange(text) {
  if (!text) return null;
  let m = text.match(/(\d+)\s*-\s*(\d+)\s*Yrs?/i);
  if (m) return { min: +m[1], max: +m[2] };
  m = text.match(/(\d+)\s*\+\s*Yrs?/i);
  if (m) return { min: +m[1], max: +m[1] + 10 };
  return null;
}

// ---------- Skill match (recommended-jobs filter) ----------
// Builds a matcher per configured skill. Spaces/hyphens/dots in a skill are
// optional ("spring boot" matches "springboot", "Spring-Boot"), a trailing "s"
// is allowed ("microservice" ~ "microservices"), and the skill must not be part
// of a longer word, so "java" never matches "javascript".
function skillRegex(skill) {
  const chars = skill.toLowerCase().replace(/[\s\-_.]+/g, '').split('');
  const body = chars.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\-_.]*');
  return new RegExp(`(?<![a-z0-9])${body}s?(?![a-z0-9])`, 'i');
}

const SKILL_MATCHERS = cfg.skills.map(s => ({ skill: s, re: skillRegex(s) }));

// Returns the configured skills (SKILLS, defaulting to KEYWORDS) found in `text`.
export function matchedSkills(text) {
  const t = text || '';
  return SKILL_MATCHERS.filter(m => m.re.test(t)).map(m => m.skill);
}

// Keeps jobs whose experience band overlaps the configured [minExp, maxExp].
// Unknown/unparsed experience text is kept (fails open) so a DOM/selector
// change doesn't silently drop every job — but it's logged as a warning.
export function experienceMatches(range) {
  if (!range) return true;
  return range.min <= cfg.maxExp && range.max >= cfg.minExp;
}

// ---------- Collect job cards (title + company + url) ----------
async function collectJobs(page, limit) {
  await page.waitForLoadState('domcontentloaded');
  await jitter(1500, 2500);

  for (let i = 0; i < 5; i++) {
    await page.mouse.wheel(0, 1200);
    await jitter(500, 900);
  }

  // Each search-result card is a `.srp-jobtuple-wrapper` (Naukri's current DOM).
  // Fallback: `article` with a job link inside.
  const cardHandles = await page.locator(
    '.srp-jobtuple-wrapper, article.jobTuple, .jobTuple, div[class*="jobTuple"]'
  ).all();

  const seen = new Set();
  const jobs = [];
  for (const card of cardHandles) {
    const anchor = card.locator('a[href*="/job-listings-"], a.title').first();
    const href = await anchor.getAttribute('href').catch(() => null);
    if (!href) continue;
    const url = href.startsWith('http') ? href : `https://www.naukri.com${href}`;
    const idMatch = url.match(/-(\d{8,})(?:[/?#]|$)/);
    const id = idMatch ? idMatch[1] : url;
    if (seen.has(id)) continue;
    seen.add(id);

    const title = ((await anchor.textContent().catch(() => '')) || '').trim();

    // Company name lives in `.comp-name` / `a.subTitle` on the card.
    const company =
      ((await card.locator('a.comp-name, .comp-name, a.subTitle, .subTitle, .companyInfo').first().textContent().catch(() => '')) || '').trim();

    // Full card text (key-skills chips + experience band) used for the
    // relevance/experience filter below — cheap since it's already rendered.
    const cardText = ((await card.textContent().catch(() => '')) || '').trim();
    const expRange = extractExperienceRange(cardText);

    jobs.push({ id, url, title, company, cardText, expRange });
    if (jobs.length >= limit) break;
  }

  // Fallback if the card selectors returned nothing.
  if (!jobs.length) {
    const anchors = await page.locator('a[href*="/job-listings-"]').all();
    for (const a of anchors) {
      const href = await a.getAttribute('href').catch(() => null);
      if (!href) continue;
      const url = href.startsWith('http') ? href : `https://www.naukri.com${href}`;
      const idMatch = url.match(/-(\d{8,})(?:[/?#]|$)/);
      const id = idMatch ? idMatch[1] : url;
      if (seen.has(id)) continue;
      seen.add(id);
      const title = ((await a.textContent().catch(() => '')) || '').trim();
      jobs.push({ id, url, title, company: '' });
      if (jobs.length >= limit) break;
    }
  }
  return jobs;
}

// ---------- Extract company name on job detail page ----------
async function extractCompany(page) {
  const sels = [
    'a.styles_jd-header-comp-name__MvqAI',
    '.styles_jd-header-comp-name__MvqAI a',
    '.styles_jd-header-comp-name__MvqAI',
    '.jd-header-comp-name a',
    '.jd-header-comp-name',
    'div[class*="comp-name"] a',
    'div[class*="comp-name"]',
    '.comp-name',
  ];
  for (const s of sels) {
    const t = await page.locator(s).first().textContent().catch(() => null);
    if (t && t.trim()) return t.trim();
  }
  const meta = await page.locator('meta[itemprop="hiringOrganization"]').first().getAttribute('content').catch(() => null);
  return (meta || '').trim();
}

// ---------- Extract job location(s) on job detail page ----------
async function extractLocations(page) {
  const sels = ['[class*="jhc__location"]', '[class*="jd-header"] [class*="location"]', '[class*="job-header"] [class*="location"]', '.location'];
  for (const s of sels) {
    const t = await page.locator(s).first().textContent({ timeout: 2000 }).catch(() => null);
    if (t && t.trim()) return t.trim();
  }
  return '';
}

// ---------- Chatbot auto-answer (rule-based, no AI/API) ----------
// Naukri shows a chat-style drawer after clicking Apply for some jobs, asking
// fixed questions (notice period, CTC, location, relocation, skill experience,
// etc). We match the question text against a small rule set and answer from
// the static PROFILE in .env. Unmatched questions are never guessed — the job
// is skipped with the exact question logged so you can add a rule for it.
// ---------- Location helpers (relocation / F2F questions) ----------
// Canonical names so "Bengaluru" matches "Bangalore", "Gurgaon" matches
// "Gurugram", etc. Applied to both the job's location text and your lists.
const CITY_ALIASES = [
  [/bengaluru|banglore/g, 'bangalore'],
  [/gurgaon/g, 'gurugram'],
  [/bombay/g, 'mumbai'],
  [/new\s*delhi/g, 'delhi'],
  [/work\s*from\s*home|\bwfh\b/g, 'remote'],
];

function canonCity(text) {
  let t = String(text || '').toLowerCase();
  for (const [re, to] of CITY_ALIASES) t = t.replace(re, to);
  return t;
}

// True when any of `cities` appears (as a whole word) in any of `texts`.
function cityMatches(cities, ...texts) {
  const hay = canonCity(texts.filter(Boolean).join(' | '));
  return cities.some(c => {
    const city = canonCity(c).trim();
    return city && new RegExp(`(?<![a-z])${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(hay);
  });
}

function listOf(str) {
  return String(str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ---------- Skill-experience answers ----------
// "How many years of experience do you have in Spring Boot?" → if the skill
// is one of your profile skills (SKILLS / KEYWORDS, or a key of
// SKILL_EXPERIENCE_OVERRIDES) answer DEFAULT_SKILL_EXPERIENCE_YEARS (or the
// override), otherwise 0. A question that names no skill at all ("how many
// years of experience do you have?") gets TOTAL_EXPERIENCE_YEARS.
const SKILL_PHRASE_PATTERNS = [
  /(?:experience|exp\.?|worked|working|hands[\s-]*on)\b.*?\b(?:in|with|on|using|of)\s+([a-z0-9+#./ -]{2,40})/i,
  /([a-z0-9+#.]+(?:\s+[a-z0-9+#.]+)?)\s+experience/i,
];
const NOT_A_SKILL = /^(?:the|a|an|your|you|it|this|total|overall|relevant|work|working|years?|months?|how many|do you have)$/i;

function skillExperienceAnswer(p, q) {
  const overrideKeys = Object.keys(p.skillExperienceOverrides || {});
  const found = matchedSkills(q);
  const override = overrideKeys.find(k => skillRegex(k).test(q));
  if (override) return String(p.skillExperienceOverrides[override]);
  if (found.length) return p.defaultSkillExperience;

  for (const re of SKILL_PHRASE_PATTERNS) {
    const m = q.match(re);
    const phrase = m && m[1].trim().replace(/[?.:]+$/, '');
    if (phrase && !NOT_A_SKILL.test(phrase) && !/^(?:years?|months?)\b/i.test(phrase)) return '0';
  }
  return p.totalExperienceYears;
}

// ---------- CTC answers ----------
// Prefers the text form (e.g. "8 LPA"); if the question asks for lakhs it
// answers the lakh figure ("8"); if the input is numeric or the question asks
// for rupees/digits it answers the full number (800000). When the text form is
// typed and the chatbot rejects it, the number is retried (see handleChatbot).
function ctcAnswer(text, number, q, ctx) {
  const lakhs = number ? String(+number / 100000) : '';
  const asksLakhs = /lakh|lac|\blpa\b/i.test(q);
  const asksNumber = /rupees|\binr\b|numeric|\bnumbers?\b|digits|absolute|amount/i.test(q) || ctx.inputType === 'number';
  const optionValue = lakhs || text;
  if (asksLakhs && lakhs) return { value: lakhs, optionValue };
  if ((asksNumber || !text) && number) return { value: String(number), optionValue };
  return { value: text, fallback: number ? String(number) : null, optionValue };
}

// Rules are tried in order; the first whose regex matches and whose answer
// fits the widget (an option for chips, any text for an input) wins.
// value(profile, match, question, ctx) returns a string or
// { value, fallback?, optionValue? }. ctx = { job, inputType }.
const CHATBOT_RULES = [
  { name: 'total-experience', re: /total\s*(work\s*)?experience|overall\s*experience/i, value: p => p.totalExperienceYears },
  { name: 'notice-negotiable', re: /notice\s*period.*(negotiable|reduce)/i, value: p => p.noticeNegotiable },
  { name: 'notice-period', re: /notice\s*period/i, value: p => p.noticePeriod },
  {
    // Willing to relocate → Yes only if the job (or the city the question
    // names) is in your PREFERRED_LOCATIONS / LOCATIONS.
    name: 'relocation',
    re: /relocat/i,
    value: (p, m, q, ctx) => cityMatches(listOf(p.preferredLocations || cfg.locations.join(',')), q, ctx.job.locations) ? 'Yes' : 'No',
  },
  {
    // Face-to-face / offline interview → Yes only if the job (or the city in
    // the question) is in CURRENT_LOCATION.
    name: 'f2f-interview',
    re: /face.?to.?face|\bf2f\b|in[\s-]*person|walk[\s-]*in|offline|on[\s-]*site\s*interview|(?:visit|come\s*to).*office.*interview|interview.*(?:at|in)\s*(?:our\s*)?office/i,
    value: (p, m, q, ctx) => cityMatches(listOf(p.currentLocation), q, ctx.job.locations) ? 'Yes' : 'No',
  },
  { name: 'current-ctc', re: /current\s*(ctc|salary|package|compensation)|present\s*(ctc|salary)/i, value: (p, m, q, ctx) => ctcAnswer(p.currentCtc, p.currentCtcNumber, q, ctx) },
  { name: 'expected-ctc', re: /expected\s*(ctc|salary|package|compensation)|salary\s*expectation/i, value: (p, m, q, ctx) => ctcAnswer(p.expectedCtc, p.expectedCtcNumber, q, ctx) },
  { name: 'current-location', re: /current\s*(location|city)|based\s*(in|at)|where\s*are\s*you\s*(currently\s*)?(located|based)/i, value: p => p.currentLocation },
  { name: 'preferred-location', re: /preferred\s*location|willing\s*to\s*work\s*(in|at)|location\s*preference/i, value: p => p.preferredLocations },
  { name: 'designation', re: /current\s*(designation|role|title)/i, value: p => p.currentDesignation },
  { name: 'education', re: /highest\s*(education|qualification)/i, value: p => p.highestEducation },
  // Experience in a specific skill: 2 if it's one of your skills, else 0.
  { name: 'skill-experience', re: /experience|\bexp\b|\bexp\.|hands[\s-]*on|worked\s*(?:on|with|in)/i, value: (p, m, q) => skillExperienceAnswer(p, q) },
];

function pickOption(options, wanted) {
  if (!options || !options.length || wanted === undefined || wanted === null || wanted === '') return null;
  const w = String(wanted).toLowerCase().trim();

  let idx = options.findIndex(o => o.toLowerCase().trim() === w);
  if (idx !== -1) return idx;

  idx = options.findIndex(o => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()));
  if (idx !== -1) return idx;

  // Numeric closeness, e.g. wanted "2" against options like "1-2 Years", "3-5 Years".
  const wantedNum = parseFloat(w);
  if (!Number.isNaN(wantedNum)) {
    let best = -1, bestDiff = Infinity;
    options.forEach((o, i) => {
      const nums = (o.match(/\d+(\.\d+)?/g) || []).map(Number);
      if (nums.length) {
        const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
        const diff = Math.abs(avg - wantedNum);
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      }
    });
    if (best !== -1) return best;
  }
  return null;
}

const YES_NO = /^\s*(yes|no)\b/i;

export function matchAnswer(questionText, options, profile, ctx = {}) {
  const q = questionText || '';
  ctx = { job: {}, ...ctx };
  for (const rule of CHATBOT_RULES) {
    const m = q.match(rule.re);
    if (!m) continue;
    let ans = rule.value(profile, m, q, ctx);
    if (ans === undefined || ans === null || ans === '') continue;
    if (typeof ans !== 'object') ans = { value: String(ans) };

    if (options && options.length) {
      let wanted = ans.optionValue ?? ans.value;
      // Yes/No chips for a numeric answer ("Do you have experience in Java?").
      if (options.every(o => YES_NO.test(o)) && /^\d+(\.\d+)?$/.test(String(wanted))) {
        wanted = +wanted > 0 ? 'Yes' : 'No';
      }
      const idx = pickOption(options, wanted);
      if (idx === null) continue; // rule matched but no option fits — try other rules
      return { type: 'option', index: idx, value: options[idx], rule: rule.name };
    }
    return { type: 'text', value: String(ans.value), fallback: ans.fallback || null, rule: rule.name };
  }
  return null;
}

// After typing an answer: did the chatbot reject it (validation error shown,
// or a new bot message asking for a valid/numeric value)?
async function answerRejected(drawer, botMsgs, countBefore) {
  const err = drawer.locator('[class*="error" i]:visible, [class*="invalid" i]:visible').first();
  if (await err.count() && ((await err.textContent().catch(() => '')) || '').trim()) return true;
  const n = await botMsgs.count();
  if (n > countBefore) {
    const last = ((await botMsgs.nth(n - 1).textContent().catch(() => '')) || '');
    if (/valid|invalid|only\s*(numbers|digits|numeric)|enter\s*a\s*number|numeric\s*value/i.test(last)) return true;
  }
  return false;
}

// Every chatbot conversation is recorded twice: chatbot-log.json (one entry
// per job, machine-readable) and chatbot-qa.log (plain text, easy to skim).
function appendChatbotLog(job, chat, outcome) {
  const qa = chat.qaLog || [];
  const entry = {
    timestamp: new Date().toISOString(),
    jobId: job.id, title: job.title || '', company: job.company || '', location: job.locations || '', url: job.url,
    outcome: outcome.status, reason: outcome.reason || '',
    qa,
  };
  let all = [];
  try { all = JSON.parse(fs.readFileSync(CHATBOT_LOG, 'utf8')); } catch {}
  all.push(entry);
  fs.writeFileSync(CHATBOT_LOG, JSON.stringify(all, null, 2));

  const lines = [
    `=== ${entry.timestamp}  ${entry.title} @ ${entry.company}${entry.location ? `  (${entry.location})` : ''}`,
    `    ${entry.url}`,
  ];
  qa.forEach((x, i) => {
    lines.push(`  Q${i + 1}: ${x.q}`);
    if (x.options) lines.push(`      options: ${x.options.join(' | ')}`);
    if (x.rejected) lines.push(`      rejected: "${x.rejected}" → retried`);
    lines.push(x.a === null ? `      A: (no answer — ${x.rule})` : `      A: ${x.a}    [${x.rule}]`);
  });
  if (!qa.length) lines.push('  (no questions answered)');
  lines.push(`  → ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ''}`, '');
  fs.appendFileSync(CHATBOT_QA_LOG, lines.join('\n') + '\n');
}

// ---------- Learned chatbot answers (persisted, user-editable) ----------
// When a question doesn't match any rule in CHATBOT_RULES, we don't guess —
// we save it to chatbot-answers.json with `answer: null` and skip the job.
// Open that file, fill in the `answer` field for any question you want
// auto-answered, and re-run: the same (or a near-duplicate) question will be
// answered automatically next time, no code changes needed.
function normalizeQuestion(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadLearnedAnswers() {
  try { return JSON.parse(fs.readFileSync(CHATBOT_ANSWERS, 'utf8')); }
  catch { return []; }
}

function saveLearnedAnswers(store) {
  fs.writeFileSync(CHATBOT_ANSWERS, JSON.stringify(store, null, 2));
}

// Finds a stored entry with a filled-in `answer` whose normalized question
// exactly matches, or — for near-duplicate phrasing — where one normalized
// text contains the other (guarded by a minimum length to avoid false hits).
function findLearnedAnswer(store, questionText) {
  const norm = normalizeQuestion(questionText);
  if (!norm) return null;
  let entry = store.find(e => e.answer && e.normalized === norm);
  if (entry) return entry;
  entry = store.find(e =>
    e.answer && e.normalized.length > 8 &&
    (norm.includes(e.normalized) || e.normalized.includes(norm))
  );
  return entry || null;
}

// Upserts an unanswered question into the store (dedup by normalized text),
// bumping seenCount/lastSeen so repeated occurrences don't create duplicates.
function recordUnansweredQuestion(store, questionText, options) {
  const norm = normalizeQuestion(questionText);
  if (!norm) return;
  const now = new Date().toISOString();
  let entry = store.find(e => e.normalized === norm);
  if (entry) {
    entry.seenCount = (entry.seenCount || 1) + 1;
    entry.lastSeen = now;
    if (options && options.length) entry.options = options;
  } else {
    store.push({
      question: questionText,
      normalized: norm,
      options: options && options.length ? options : null,
      answer: null, // <-- fill this in, then re-run to auto-answer it
      seenCount: 1,
      firstSeen: now,
      lastSeen: now,
    });
  }
}

// Bubbles like "Thanks!" or "Great, noted." that aren't questions. Skipped
// when picking the current question, so a filler message posted after the
// real question doesn't hide it (or get matched by mistake — "Thanks for
// sharing your experience" would otherwise hit the skill-experience rule).
const FILLER_MSG = /^(?:thanks?|thank\s*you|great|ok(?:ay)?|got\s*it|noted|perfect|awesome|cool|sure|hi|hello|hey|welcome|alright)\b/i;
const looksLikeQuestion = t => t.includes('?') || !FILLER_MSG.test(t);

// Waits until the bot posts a message beyond `prevCount`, the apply succeeds,
// or the drawer closes. Returns 'new' | 'applied' | 'closed' | 'stuck'.
async function waitForBot(page, drawer, botMsgs, prevCount, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const success = await page.getByText(/successfully applied/i)
      .or(page.getByText(/application submitted/i)).first().count();
    if (success) return 'applied';
    const visible = (await drawer.count()) && await drawer.isVisible().catch(() => false);
    if (!visible) return 'closed';
    if ((await botMsgs.count()) > prevCount) {
      await jitter(600, 900); // let the bot finish rendering the question + its options
      return 'new';
    }
    await sleep(400);
  }
  return 'stuck';
}

// Clickable answer options for the current question: chips/buttons plus radio
// buttons (clicking the radio's label, since the input itself is often hidden).
// Only visible, enabled ones, so leftovers from earlier questions are ignored.
async function collectOptions(drawer) {
  const opts = [];
  const buttons = drawer.locator(
    '[class*="chip" i] button, button[class*="chip" i], [class*="option" i] button, li[class*="option" i] button, ' +
    '[class*="singleSelect" i] button, [class*="userOption" i] button'
  );
  for (let i = 0, n = await buttons.count(); i < n; i++) {
    const el = buttons.nth(i);
    if (!(await el.isVisible().catch(() => false)) || await el.isDisabled().catch(() => false)) continue;
    const t = ((await el.textContent().catch(() => '')) || '').trim();
    if (t && !/^(close|back|[×✕])$/i.test(t)) opts.push({ text: t, el });
  }
  const radios = drawer.locator('input[type="radio"]');
  for (let i = 0, n = await radios.count(); i < n; i++) {
    const radio = radios.nth(i);
    if (await radio.isDisabled().catch(() => false)) continue;
    const id = await radio.getAttribute('id').catch(() => null);
    let label = id ? drawer.locator(`label[for="${id}"]`).first() : null;
    if (!label || !(await label.count())) label = radio.locator('xpath=ancestor::label[1]');
    if (!(await label.count())) label = radio.locator('xpath=following-sibling::label[1]');
    const hasLabel = await label.count();
    if (hasLabel && !(await label.isVisible().catch(() => false))) continue;
    const t = ((hasLabel ? await label.textContent().catch(() => '') : await radio.getAttribute('value').catch(() => '')) || '').trim();
    if (t) opts.push({ text: t, el: hasLabel ? label : radio, radio });
  }
  return opts;
}

function answerFor(questionText, options, inputType, job) {
  const match = matchAnswer(questionText, options.length ? options : null, cfg.profile, { job, inputType });
  if (match) return match;
  const learned = findLearnedAnswer(loadLearnedAnswers(), questionText);
  if (!learned) return null;
  if (options.length) {
    const idx = pickOption(options, learned.answer);
    if (idx !== null) return { type: 'option', index: idx, value: options[idx], rule: 'learned' };
  }
  return { type: 'text', value: learned.answer, rule: 'learned' };
}

export async function handleChatbot(page, job) {
  const drawer = page.locator('.chatbot_Drawer, [class*="chatbot" i]').first();
  const botMsgs = drawer.locator('[class*="botMsg" i], [class*="bot-msg" i], [class*="botItem" i]');
  const qaLog = [];
  const MAX_STEPS = 25;
  // Bot messages already handled; only messages after this index are new.
  let seen = 0;
  let lastQuestion = '';

  // The drawer is in the DOM before it's shown (empty / animating in) — don't
  // mistake that for "closed".
  await drawer.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

  for (let step = 0; step < MAX_STEPS; step++) {
    // Wait for the bot's next message instead of re-reading the old one —
    // a slow bot would otherwise get the same question answered twice.
    const state = await waitForBot(page, drawer, botMsgs, seen);
    if (state === 'applied') return { status: 'applied', qaLog };
    if (state === 'closed') return { status: 'closed', qaLog };
    if (state === 'stuck' && step > 0) {
      await screenshot(page, `chatbot-stuck-${job.id}`);
      log(`   ⏳ chatbot did not reply after: "${lastQuestion}"`);
      return { status: 'unmatched', question: `(chatbot did not move past: ${lastQuestion})`, qaLog };
    }

    const total = await botMsgs.count();
    const newMsgs = [];
    for (let i = seen; i < total; i++) {
      const t = ((await botMsgs.nth(i).textContent().catch(() => '')) || '').trim();
      if (t) newMsgs.push(t);
    }
    // No bot-message bubbles matched (DOM change): fall back to the last message.
    if (!newMsgs.length && step === 0) {
      const t = ((await drawer.locator('[class*="message" i], [class*="msg" i]').last().textContent().catch(() => '')) || '').trim();
      if (t) newMsgs.push(t);
    }
    seen = total;

    // Only filler ("Thanks!") so far — the real question is still coming.
    const candidates = newMsgs.filter(looksLikeQuestion).reverse(); // newest first
    if (!candidates.length) {
      if (state === 'stuck') return { status: 'closed', qaLog };
      step--; // waiting on filler doesn't count as a question
      continue;
    }

    const optEls = await collectOptions(drawer);
    const options = optEls.map(o => o.text);

    const textInput = drawer.locator('textarea, input[type="text"], input[type="number"], input[type="tel"], input:not([type])').first();
    const hasTextInput = await textInput.count();
    const inputType = hasTextInput
      ? ((await textInput.getAttribute('type').catch(() => null)) === 'number' ||
         (await textInput.getAttribute('inputmode').catch(() => null)) === 'numeric' ? 'number' : 'text')
      : null;
    const select = drawer.locator('select').first();
    const hasSelect = await select.count();

    // Newest message that a rule (or a learned answer) can answer is the
    // question; e.g. "Hi! I have a few questions." followed by the real one.
    let questionText = candidates[0];
    let match2 = null;
    for (const c of candidates) {
      match2 = answerFor(c, options, inputType, job);
      if (match2) { questionText = c; break; }
    }

    if (!match2) {
      const answersStore = loadLearnedAnswers();
      recordUnansweredQuestion(answersStore, questionText, options);
      saveLearnedAnswers(answersStore);
      await screenshot(page, `chatbot-unmatched-${job.id}`);
      qaLog.push({ q: questionText, options: options.length ? options : null, a: null, rule: 'no matching rule' });
      log(`   ❓ Q${qaLog.length}: "${questionText}"${options.length ? `  [${options.join(' | ')}]` : ''} → no matching rule`);
      log(`      Saved to ${path.basename(CHATBOT_ANSWERS)} — fill in its "answer" field to auto-answer this next time.`);
      return { status: 'unmatched', question: questionText, qaLog };
    }

    if (match2.type === 'option') {
      const opt = optEls[match2.index];
      await opt.el.click({ timeout: 5000 }).catch(async () => {
        if (opt.radio) await opt.radio.check({ force: true }).catch(() => {});
      });
    } else if (hasTextInput) {
      const typeAndSend = async (value) => {
        await textInput.click().catch(() => {});
        await textInput.fill('').catch(() => {});
        await textInput.type(value, { delay: 30 + Math.random() * 30 });
        const sendBtn = drawer.locator('button[class*="send" i], [class*="sendMsg" i], button:has-text("Send")').first();
        if (await sendBtn.count()) await sendBtn.click({ timeout: 3000 }).catch(() => {});
        else await page.keyboard.press('Enter').catch(() => {});
      };
      await typeAndSend(match2.value);
      // e.g. "8 LPA" rejected because the field wants digits → retry 800000.
      if (match2.fallback) {
        await jitter(1200, 1800);
        if (await answerRejected(drawer, botMsgs, seen)) {
          log(`   💬 "${match2.value}" rejected — retrying with "${match2.fallback}"`);
          match2.rejected = match2.value;
          match2.value = match2.fallback;
          seen = await botMsgs.count(); // the error message isn't the next question
          await typeAndSend(match2.value);
        }
      }
    } else if (hasSelect) {
      await select.selectOption({ label: match2.value }).catch(async () => {
        await select.selectOption(match2.value).catch(() => {});
      });
    } else {
      await screenshot(page, `chatbot-nowidget-${job.id}`);
      qaLog.push({ q: questionText, options: null, a: null, rule: 'no input box or options found' });
      log(`   ❓ Q${qaLog.length}: "${questionText}" → no input box or options found`);
      return { status: 'unmatched', question: questionText, qaLog };
    }

    qaLog.push({
      q: questionText, options: options.length ? options : null, a: match2.value, rule: match2.rule,
      ...(match2.rejected ? { rejected: match2.rejected } : {}),
    });
    log(`   💬 Q${qaLog.length}: "${questionText}"${options.length ? `  [${options.join(' | ')}]` : ''}`);
    log(`        A: "${match2.value}"  (${match2.rule === 'learned' ? 'learned answer' : `rule: ${match2.rule}`})`);
    lastQuestion = questionText;

    const confirmBtn = drawer.locator('button:has-text("Save"), button:has-text("Submit"), button:has-text("Continue")').first();
    if (await confirmBtn.count()) await confirmBtn.click({ timeout: 3000 }).catch(() => {});
  }

  return { status: 'unmatched', question: '(max steps exceeded)', qaLog };
}

// ---------- Apply to a single job ----------
// Pass `existingPage` when the job detail page is already open (e.g. the tab a
// recommended-jobs card opened); it's closed when done, same as a fresh page.
export async function applyToJob(context, job, existingPage = null) {
  const page = existingPage || await context.newPage();
  const outcome = { ...job, status: 'unknown', reason: '' };
  let chatResult = null;
  try {
    if (!existingPage) await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(1800, 2800);

    // Ensure we have company name (fallback to job detail page).
    if (!outcome.company) outcome.company = await extractCompany(page);
    // Job location(s), used to answer relocation / F2F-interview chatbot questions.
    job.locations = await extractLocations(page);

    const applyBtn = page.locator(
      '#apply-button, ' +
      '#job-header-apply-btn, ' +
      'button.styles_apply-button__uJI3A, ' +
      'button[class*="apply-button"]:not([class*="applied"]), ' +
      'button:has-text("Apply"):not(:has-text("Applied")), ' +
      'button:has-text("I am interested"), ' +
      'a:has-text("Apply"):not(:has-text("Applied"))'
    ).first();

    if (!(await applyBtn.count())) {
      // Already applied?
      const already = await page.locator('button:has-text("Applied"), .already-applied')
        .or(page.getByText(/already applied/i)).first().count();
      if (already) { outcome.status = 'already-applied'; return outcome; }
      outcome.status = 'skipped';
      outcome.reason = 'no-apply-button';
      await screenshot(page, `no-btn-${job.id}`);
      return outcome;
    }

    const btnText = ((await applyBtn.textContent().catch(() => '')) || '').toLowerCase();

    if (/company site|external|walk-?in/.test(btnText)) {
      if (cfg.skipExternal) {
        outcome.status = 'skipped';
        outcome.reason = `external:${btnText.trim()}`;
        return outcome;
      }
    }

    if (cfg.dryRun) {
      outcome.status = 'would-apply';
      outcome.reason = btnText.trim();
      return outcome;
    }

    await applyBtn.scrollIntoViewIfNeeded().catch(() => {});
    await jitter(400, 800);

    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await applyBtn.click({ timeout: 10000 });
    await jitter(2000, 3500);

    const popup = await popupPromise;
    if (popup) {
      await popup.close().catch(() => {});
      if (cfg.skipExternal) {
        outcome.status = 'skipped';
        outcome.reason = 'external-popup';
        return outcome;
      }
    }

    // Chatbot with custom questions.
    const chatbot = page.locator('.chatbot_Drawer, .chatbot_MessageContainer, [class*="chatbot" i]').first();
    if (await chatbot.count()) {
      if (cfg.skipChatbot) {
        outcome.status = 'skipped';
        outcome.reason = 'chatbot-questions';
        await screenshot(page, `chatbot-${job.id}`);
        // Try to close the drawer if there's an X.
        await page.locator('.chatbot_Drawer button[aria-label="close" i], .crossIcon, .chatbot_Drawer .close').first().click().catch(() => {});
        return outcome;
      }

      log(`   💬 chatbot opened — answering questions`);
      chatResult = await handleChatbot(page, job);

      if (chatResult.status === 'applied') {
        outcome.status = 'applied';
        return outcome;
      }
      if (chatResult.status === 'unmatched') {
        outcome.status = 'skipped';
        outcome.reason = `chatbot-unmatched: ${chatResult.question}`.slice(0, 200);
        return outcome;
      }
      // status === 'closed' -> drawer finished/disappeared, fall through to the
      // normal success-confirmation check below.
    }

    // Success signals — Naukri shows a green toast or updates the button.
    const successLocator = page.locator('.apply-status-success, button:has-text("Applied")')
      .or(page.getByText(/you have successfully applied|application submitted|applied successfully|already applied/i))
      .first();

    try {
      await successLocator.waitFor({ timeout: 8000 });
      outcome.status = 'applied';
      return outcome;
    } catch { /* fall through */ }

    outcome.status = 'unknown';
    outcome.reason = 'no-confirmation';
    await screenshot(page, `unknown-${job.id}`);
    return outcome;
  } catch (e) {
    outcome.status = 'error';
    outcome.reason = e.message.slice(0, 200);
    await screenshot(page, `error-${job.id}`);
    return outcome;
  } finally {
    if (chatResult) {
      try { appendChatbotLog(job, chatResult, outcome); } catch (e) { log(`   ⚠️  chatbot log write failed: ${e.message}`); }
      log(`   💬 chatbot finished: ${chatResult.qaLog.filter(x => x.a !== null).length} answered → ${outcome.status}`);
    }
    await page.close().catch(() => {});
  }
}

// ---------- Apply run ----------
// Runs the full search + apply loop in an already logged-in context.
// `page` is the page returned by ensureLoggedIn() (reused for searches).
export async function runApply(context, page) {
  if (!cfg.keywords.length) {
    console.error('❌ KEYWORDS must be set in .env (at least one).');
    return { applied: 0, skipped: 0, errors: 0 };
  }

  log('🚀 Naukri auto-apply — starting');
  log(`   keywords:   ${cfg.keywords.join(' | ')}`);
  log(`   locations:  ${cfg.locations.join(' | ') || '(any)'}`);
  log(`   experience: ${cfg.minExp}-${cfg.maxExp} yrs`);
  log(`   posted <=   ${cfg.postedWithinHours}h  (Naukri jobAge=${jobAgeParam(cfg.postedWithinHours)}d)`);
  log(`   geo:        ${cfg.geoLat},${cfg.geoLng} (auto-granted)`);
  log(`   dry-run:    ${cfg.dryRun}`);

  const applied = loadApplied();
  log(`   already applied in past runs: ${applied.size}`);

  const stats = { applied: 0, alreadyApplied: 0, skipped: 0, errors: 0, would: 0, seen: 0, irrelevant: 0 };
  const locs = cfg.locations.length ? cfg.locations : [''];

  for (const kw of cfg.keywords) {
    for (const loc of locs) {
      const url = buildSearchUrl(kw, loc);
      log(`\n🔎 Searching: "${kw}" in "${loc || 'anywhere'}"`);
      log(`   ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await jitter(1500, 2500);

      const rawJobs = await collectJobs(page, cfg.maxPerKeyword * 2);
      log(`   found ${rawJobs.length} jobs on results page`);

      const jobs = rawJobs.filter(job => {
        if (!titleIsRelevant(job.title, job.cardText)) {
          log(`   ⏭️  irrelevant title, skipping: "${job.title}"`);
          stats.irrelevant++;
          return false;
        }
        if (!experienceMatches(job.expRange)) {
          log(`   ⏭️  experience mismatch (needs ${job.expRange.min}-${job.expRange.max} yrs), skipping: "${job.title}"`);
          stats.irrelevant++;
          return false;
        }
        return true;
      });
      log(`   ${jobs.length} job(s) match role + experience filters`);

      let count = 0;
      for (const job of jobs) {
        if (count >= cfg.maxPerKeyword) break;
        stats.seen++;
        if (applied.has(job.id)) { stats.skipped++; continue; }

        const label = `${job.title.slice(0, 55).padEnd(55)}  @  ${(job.company || '?').slice(0, 30)}`;
        log(`  → ${label}`);

        const r = await applyToJob(context, job);
        appendResult(r);

        const icon =
          r.status === 'applied'         ? '✅' :
          r.status === 'already-applied' ? '☑️' :
          r.status === 'would-apply'     ? '📝' :
          r.status === 'skipped'         ? '⏭️' :
          r.status === 'error'           ? '❌' : '❓';
        log(`     ${icon} ${r.status}${r.reason ? '  (' + r.reason + ')' : ''}`);

        if (r.status === 'applied')             { stats.applied++;        applied.add(job.id); }
        else if (r.status === 'already-applied'){ stats.alreadyApplied++; applied.add(job.id); }
        else if (r.status === 'would-apply')    { stats.would++;          applied.add(job.id); }
        else if (r.status === 'skipped')        { stats.skipped++;        applied.add(job.id); }
        else if (r.status === 'error')          { stats.errors++; }

        saveApplied(applied);
        await jitter(3500, 6500);
        count++;
      }
    }
  }

  log('\n📊 Summary');
  log(`   ✅ applied:        ${stats.applied}`);
  log(`   ☑️ already applied:${stats.alreadyApplied}`);
  log(`   📝 would-apply:    ${stats.would}`);
  log(`   ⏭️ skipped:        ${stats.skipped}`);
  log(`   🚫 irrelevant:     ${stats.irrelevant}`);
  log(`   ❌ errors:         ${stats.errors}`);
  log(`   👀 total seen:     ${stats.seen}`);
  log(`   📄 detailed log:   ${RESULTS_CSV}`);
  return stats;
}

// ---------- Standalone entry point ----------
if (isMainModule(import.meta.url)) {
  (async () => {
    requireCreds();
    if (!cfg.keywords.length) {
      console.error('❌ KEYWORDS must be set in .env (at least one).');
      process.exit(1);
    }
    const { browser, context } = await launchContext();
    try {
      const page = await ensureLoggedIn(context);
      await runApply(context, page);
      await context.storageState({ path: STORAGE_STATE });
    } finally {
      await browser.close();
    }
  })().catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
