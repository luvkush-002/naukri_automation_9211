// Shared infrastructure for the Naukri automation scripts.
// Config, logging, screenshots, login, and browser/context setup live here so
// both the apply flow (apply.js) and the resume re-upload flow (resume.js)
// reuse the exact same session handling and anti-automation tweaks.
import { chromium } from 'playwright';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const STORAGE_STATE = path.join(__dirname, 'storage-state.json');
export const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

export function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// Resolve a possibly-relative path against the project directory so the resume
// file works the same whether the script is run from the repo root or elsewhere.
function resolveInProject(p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.join(__dirname, p);
}

export const cfg = {
  email: process.env.NAUKRI_EMAIL,
  password: process.env.NAUKRI_PASSWORD,
  keywords: (process.env.KEYWORDS || '').split(',').map(s => s.trim()).filter(Boolean),
  locations: (process.env.LOCATIONS || '').split(',').map(s => s.trim()).filter(Boolean),
  minExp: parseInt(process.env.MIN_EXPERIENCE || '0', 10),
  maxExp: parseInt(process.env.MAX_EXPERIENCE || '30', 10),
  postedWithinHours: parseInt(process.env.POSTED_WITHIN_HOURS || '24', 10),
  maxPerKeyword: parseInt(process.env.MAX_APPLIES_PER_KEYWORD || '25', 10),
  skipExternal: (process.env.SKIP_EXTERNAL || 'true') === 'true',
  skipChatbot: (process.env.SKIP_CHATBOT || 'true') === 'true',
  headless: (process.env.HEADLESS || 'false') === 'true',
  geoLat: parseFloat(process.env.GEO_LAT || '12.9716'),   // Default: Bangalore
  geoLng: parseFloat(process.env.GEO_LNG || '77.5946'),
  dryRun: process.argv.includes('--dry-run'),
  // Local resume file to push to your Naukri profile (default: resume.pdf in
  // the project root). Naukri accepts .doc/.docx/.rtf/.pdf up to 2MB.
  resumePath: resolveInProject(process.env.RESUME_PATH || 'resume.pdf'),
  // --- Early access roles (share-interest) flow, runs after apply ---
  // Share interest when the salary range's lower bound is >= eaMinSalaryLower
  // OR its upper bound is >= eaMinSalaryUpper (both in LPA), or when the
  // card shows no salary range at all ("Not disclosed").
  earlyAccess: (process.env.EARLY_ACCESS || 'true') === 'true',
  eaMinSalaryLower: parseFloat(process.env.EARLY_ACCESS_MIN_SALARY_LOWER || '5'),
  eaMinSalaryUpper: parseFloat(process.env.EARLY_ACCESS_MIN_SALARY_UPPER || '9'),
  eaMaxInterests: parseInt(process.env.EARLY_ACCESS_MAX_INTERESTS || '50', 10),
  // --- Recommended jobs flow (homepage "View all" -> each tab) ---
  // Applies to jobs on every recommended-jobs tab (Profile, Applies,
  // Preferences, You might like). By default only jobs that match your role
  // titles, at least MIN_SKILL_MATCH of SKILLS, and [minExp, maxExp] are
  // applied to; RECOMMENDED_FILTER=false applies to everything.
  recommended: (process.env.RECOMMENDED || 'true') === 'true',
  recommendedFilter: (process.env.RECOMMENDED_FILTER || 'true') === 'true',
  // Skills a recommended job must mention (card or job page). Defaults to KEYWORDS.
  skills: (process.env.SKILLS || process.env.KEYWORDS || '').split(',').map(s => s.trim()).filter(Boolean),
  minSkillMatch: parseInt(process.env.MIN_SKILL_MATCH || '1', 10),
  // Per-tab cap on apply attempts in one run (0 = no cap).
  recommendedMaxPerTab: parseInt(process.env.RECOMMENDED_MAX_PER_TAB || '25', 10),
  // Static profile used to auto-answer Naukri's post-apply chatbot questions
  // (notice period, CTC, location, relocation, skill experience, etc.) with
  // no AI/API involved — pure keyword-matching against your fixed answers.
  profile: {
    totalExperienceYears: process.env.TOTAL_EXPERIENCE_YEARS || '',
    noticePeriod: process.env.NOTICE_PERIOD || '',
    // Text form typed first (e.g. "8 LPA"); the *_NUMBER form (rupees) is used
    // when the field wants digits, and its lakh value for chips/"in lakhs".
    currentCtc: process.env.CURRENT_CTC || '',
    currentCtcNumber: process.env.CURRENT_CTC_NUMBER || '',
    expectedCtc: process.env.EXPECTED_CTC || '',
    expectedCtcNumber: process.env.EXPECTED_CTC_NUMBER || '',
    currentLocation: process.env.CURRENT_LOCATION || '',
    preferredLocations: process.env.PREFERRED_LOCATIONS || '',
    currentDesignation: process.env.CURRENT_DESIGNATION || '',
    highestEducation: process.env.HIGHEST_EDUCATION || '',
    noticeNegotiable: process.env.NOTICE_NEGOTIABLE || 'No',
    defaultSkillExperience: process.env.DEFAULT_SKILL_EXPERIENCE_YEARS || '2',
    // e.g. SKILL_EXPERIENCE_OVERRIDES={"java":"4","aws":"1","reactjs":"3"}
    skillExperienceOverrides: safeJsonParse(process.env.SKILL_EXPERIENCE_OVERRIDES, {}),
  },
};

// Fatal unless email + password are present — every flow needs to log in.
export function requireCreds() {
  if (!cfg.email || !cfg.password) {
    console.error('❌ NAUKRI_EMAIL and NAUKRI_PASSWORD must be set in .env');
    process.exit(1);
  }
}

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
export const jitter = (min, max) => sleep(min + Math.random() * (max - min));

export async function screenshot(page, name) {
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}-${name}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); log(`  📸 ${file}`); }
  catch { /* ignore */ }
}

// True when the given module file is the process entry point (ESM has no
// require.main; compare the module URL to argv[1]). Lets each module export its
// functions while still running standalone via `node resume.js` etc.
export function isMainModule(metaUrl) {
  return !!process.argv[1] && metaUrl === pathToFileURL(process.argv[1]).href;
}

// ---------- Login ----------
// Naukri renders multiple text inputs on the page (search bar, filters, etc.),
// so we anchor to the password field and pick the email input INSIDE THE SAME FORM.
// We also type character-by-character with jitter — `fill()` is silently ignored
// by Naukri's React validators.
export async function login(page) {
  log('🔐 Logging in to Naukri...');
  await page.goto('https://www.naukri.com/nlogin/login', { waitUntil: 'domcontentloaded' });
  await jitter(2000, 3000);
  log(`   at URL: ${page.url()}`);
  await screenshot(page, 'login-page');

  // If the session is actually still valid, Naukri bounces /login to a
  // logged-in page. Detect that instead of waiting 20s for a password field
  // that will never render here.
  if (/mnjuser|homepage|myprofile/i.test(page.url())) {
    log('✅ Already logged in (login page redirected to a logged-in page).');
    return;
  }

  const pwInput = page.locator('input[type="password"]').first();
  try {
    await pwInput.waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    log('⚠️  Password field never appeared.');
    return await manualLoginFallback(page);
  }

  // Scope the email input to the SAME form/container as the password field.
  // Falls through to the whole page if no form ancestor is found.
  const form = pwInput.locator('xpath=ancestor::form[1]');
  const hasForm = await form.count();
  const scope = hasForm ? form : page;

  // Try candidates in order of specificity; skip hidden / display:none inputs.
  const emailCandidates = [
    'input#usernameField',
    'input[placeholder*="Email" i]',
    'input[placeholder*="Username" i]',
    'input[placeholder*="mobile" i]',
    'input[type="email"]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[type="text"]',
    'input:not([type])',
  ];

  let emailInput = null;
  for (const sel of emailCandidates) {
    const cand = scope.locator(sel).first();
    if (await cand.count() && await cand.isVisible().catch(() => false)) {
      emailInput = cand;
      const ph = await cand.getAttribute('placeholder').catch(() => '');
      log(`   email field: "${sel}"  placeholder="${ph}"`);
      break;
    }
  }

  if (!emailInput) {
    log('⚠️  Could not locate a visible email/username input inside the login form.');
    return await manualLoginFallback(page);
  }

  try {
    await emailInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await emailInput.type(cfg.email, { delay: 70 + Math.random() * 60 });
    await jitter(300, 700);

    // Verify the value stuck (Naukri sometimes rejects rapid input).
    const emailValue = await emailInput.inputValue().catch(() => '');
    log(`   email typed → "${emailValue}"`);
    if (emailValue.trim() !== cfg.email.trim()) {
      log('⚠️  Email field value did not match after typing. Retrying with keyboard focus.');
      await emailInput.focus();
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Delete');
      await page.keyboard.type(cfg.email, { delay: 90 });
    }

    await pwInput.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await pwInput.type(cfg.password, { delay: 70 + Math.random() * 60 });
    await jitter(300, 700);

    const pwValue = await pwInput.inputValue().catch(() => '');
    log(`   password typed → ${pwValue.length} chars`);

    // Submit: prefer the button inside the same form; exclude social buttons.
    let submitBtn = scope.locator(
      'button[type="submit"]:not(:has-text("Google")):not(:has-text("Facebook")), ' +
      'button:has-text("Login"):not(:has-text("Google")):not(:has-text("Facebook")):not(:has-text("Email"))'
    ).first();

    if (!(await submitBtn.count())) {
      submitBtn = page.locator('button:has-text("Login")').first();
    }
    log('   clicking submit...');
    await submitBtn.click();
  } catch (e) {
    log('⚠️  Automated fill failed:', e.message.slice(0, 200));
    await screenshot(page, 'login-fill-failed');
    return await manualLoginFallback(page);
  }

  try {
    await Promise.race([
      page.waitForURL(/mnjuser|jobsearch|myprofile|homepage/i, { timeout: 45000 }),
      page.locator('a[href*="/mnjuser/profile"], .nI-gNb-drawer, .user-name').first().waitFor({ timeout: 45000 }),
    ]);
    await jitter(1500, 2500);
    log('✅ Login OK');
    return;
  } catch {
    // Check for known error banners before giving up.
    const errText = await page.locator('.erLbl, .error-txt, [class*="error"]').first().textContent().catch(() => '');
    if (errText && errText.trim()) log(`⚠️  Naukri error banner: "${errText.trim()}"`);
    await screenshot(page, 'login-stuck');
    log('⚠️  Login submit did not land on a logged-in page.');
    return await manualLoginFallback(page);
  }
}

async function manualLoginFallback(page) {
  if (cfg.headless) {
    throw new Error('Login failed and HEADLESS=true — set HEADLESS=false in .env so you can complete login manually.');
  }
  // On CI we run headed (under xvfb) purely to dodge Akamai's headless
  // fingerprinting — there is still no human to solve an OTP, so fail fast
  // instead of burning 5 minutes waiting for one.
  if (process.env.CI) {
    await screenshot(page, 'login-blocked-ci');
    throw new Error(
      'Login could not complete on CI. Usually means the seeded session expired ' +
      '(re-run `npm run export-session` and update NAUKRI_STORAGE_STATE_B64) or ' +
      'Naukri/Akamai blocked the runner — check screenshots/login-blocked-ci.png.'
    );
  }
  log('👉 Please complete the login in the visible browser window.');
  log('   Waiting up to 5 minutes for you to reach Naukri homepage/profile.');
  try {
    await Promise.race([
      page.waitForURL(/mnjuser|jobsearch|myprofile|homepage/i, { timeout: 300000 }),
      page.locator('a[href*="/mnjuser/profile"], .nI-gNb-drawer, .user-name').first().waitFor({ timeout: 300000 }),
    ]);
    log('✅ Login OK (manual)');
  } catch {
    await screenshot(page, 'login-timeout');
    throw new Error('Manual login timed out. Re-run when ready.');
  }
}

// ---------- Browser / context ----------
// Launches Chromium with the anti-automation flags and an India-flavoured
// context (geo, locale, timezone), restoring a cached session if present.
export async function launchContext() {
  const browser = await chromium.launch({
    headless: cfg.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    storageState: fs.existsSync(STORAGE_STATE) ? STORAGE_STATE : undefined,
    viewport: { width: 1366, height: 820 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    // Auto-grant geolocation (no prompt) — origin gets it site-wide.
    permissions: ['geolocation', 'notifications'],
    geolocation: { latitude: cfg.geoLat, longitude: cfg.geoLng },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  // Hide automation flags.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  });

  return { browser, context };
}

// Opens a page, verifies the cached session is still logged in, and does a
// fresh login if not. Persists the (possibly refreshed) session back to disk.
// Returns the page so callers can keep using it.
export async function ensureLoggedIn(context) {
  const page = await context.newPage();
  try {
    await page.goto('https://www.naukri.com/mnjuser/homepage', { waitUntil: 'domcontentloaded' });
    // The homepage is a React app: the logged-in markers attach ~800ms AFTER
    // DOMContentLoaded. Counting them immediately always returned 0, so every
    // run did a pointless re-login — which then redirects back here (no
    // password field) and fails with a misleading error. Wait for them.
    const loggedIn = await page
      .locator('a[href*="/mnjuser/profile"], .user-name, #root .nI-gNb-drawer')
      .first()
      .waitFor({ state: 'attached', timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!loggedIn) await login(page);
    await context.storageState({ path: STORAGE_STATE });
  } catch (e) {
    log('⚠️  Session check failed, doing a fresh login:', e.message);
    await login(page);
    await context.storageState({ path: STORAGE_STATE });
  }
  return page;
}
