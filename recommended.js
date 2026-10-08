// Naukri "Recommended jobs" flow.
// From the logged-in homepage, clicks "View all" on the "Jobs based on your
// profile / applies" widget, which lands on /mnjuser/recommendedjobs. That page
// has one tab per recommendation source — Profile, Applies, Preferences, You
// might like — and this walks them one by one, applying to every job listed.
// Each card opens its job page in a new tab when clicked; that page is handed
// to apply.js's applyToJob, so chatbot handling, external-site skipping and
// the applied.json history are shared with the search-based apply flow.
import {
  cfg, log, jitter, screenshot, STORAGE_STATE,
  requireCreds, launchContext, ensureLoggedIn, isMainModule,
} from './lib.js';
import {
  applyToJob, loadApplied, saveApplied, appendResult,
  titleIsRelevant, extractExperienceRange, experienceMatches, matchedSkills,
} from './apply.js';

const RECOMMENDED_URL = 'https://www.naukri.com/mnjuser/recommendedjobs';

// Tab wrappers on the recommended-jobs page, keyed by their element id. The
// label regex is a fallback in case Naukri renames the ids.
const TABS = [
  { id: 'profile', label: /^profile/i },
  { id: 'apply', label: /^applies/i },
  { id: 'preference', label: /^preferences/i },
  { id: 'similar_jobs', label: /^you might like/i },
];

const CARD_SELECTOR = 'article.jobTuple[data-job-id]';

// ---------- Navigate: homepage "View all" -> recommended jobs ----------
async function openRecommendedPage(page) {
  try {
    await page.goto('https://www.naukri.com/mnjuser/homepage', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(2500, 4000);
    const viewAll = page.locator('a[href*="/mnjuser/recommendedjobs"]').filter({ hasText: /view all/i }).first();
    await viewAll.waitFor({ state: 'attached', timeout: 15000 });
    await viewAll.scrollIntoViewIfNeeded().catch(() => {});
    await viewAll.click({ timeout: 8000 });
    await page.waitForURL(/recommendedjobs/, { timeout: 20000 });
    log('   opened Recommended jobs via homepage "View all"');
  } catch (e) {
    log(`   homepage "View all" not usable (${e.message.slice(0, 80)}) — opening ${RECOMMENDED_URL} directly`);
    await page.goto(RECOMMENDED_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.locator(CARD_SELECTOR).first().waitFor({ timeout: 20000 }).catch(() => {});
  await jitter(1500, 2500);
}

// Clicks a tab and waits for its card list. Returns the tab's visible label
// (e.g. "Applies (55)") or null when the tab isn't on the page.
async function openTab(page, tab) {
  let el = page.locator(`#${tab.id} .tab-list-item`).first();
  if (!(await el.count())) {
    el = page.locator('.tab-list-item').filter({ hasText: tab.label }).first();
    if (!(await el.count())) return null;
  }
  const label = ((await el.textContent().catch(() => '')) || '').trim();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 8000 });
  await jitter(2500, 3500);
  await page.locator(CARD_SELECTOR).first().waitFor({ timeout: 15000 }).catch(() => {});
  return label || tab.id;
}

// Snapshot of the cards in the active tab. Scrolls first in case the list
// lazy-loads, then scrolls back up so card clicks start from a stable spot.
async function collectCards(page) {
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 2500);
    await jitter(300, 600);
  }
  const cards = await page.locator(CARD_SELECTOR).evaluateAll(els => els.map(el => ({
    id: el.getAttribute('data-job-id'),
    title: (el.querySelector('.title')?.getAttribute('title') || el.querySelector('.title')?.textContent || '').trim(),
    company: (el.querySelector('.subTitle')?.getAttribute('title') || el.querySelector('.subTitle')?.textContent || '').trim(),
    cardText: (el.innerText || '').trim(),
  })));
  await page.evaluate(() => window.scrollTo(0, 0));
  return cards.filter(c => c.id);
}

// Clicks the card's title, which opens the job detail page in a new tab.
// Returns that page, or null if no new tab appeared.
async function openCardJob(page, context, jobId) {
  const card = page.locator(`${CARD_SELECTOR}[data-job-id="${jobId}"]`).first();
  if (!(await card.count())) return null;
  await card.scrollIntoViewIfNeeded().catch(() => {});
  await jitter(300, 700);
  const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
  await card.locator('.title').first().click({ timeout: 8000 });
  const popup = await popupPromise;
  if (popup) await popup.waitForLoadState('domcontentloaded').catch(() => {});
  return popup;
}

// ---------- Relevance filter: role + skills + experience ----------
// Card-level check. Returns { ok:false, reason } for a definite reject, or
// { ok:true, needsPage } where needsPage lists checks the card couldn't
// settle (skills not shown on the card, experience band not parsed) and that
// must be confirmed on the job detail page before applying.
function checkCard(card) {
  if (!titleIsRelevant(card.title, card.cardText)) return { ok: false, reason: 'role/title not in profile' };
  const needsPage = [];
  const exp = extractExperienceRange(card.cardText);
  if (!exp) needsPage.push('experience');
  else if (!experienceMatches(exp)) return { ok: false, reason: `experience ${exp.min}-${exp.max} yrs outside ${cfg.minExp}-${cfg.maxExp}` };
  if (matchedSkills(`${card.title} ${card.cardText}`).length < cfg.minSkillMatch) needsPage.push('skills');
  return { ok: true, needsPage };
}

// Job-page check for whatever checkCard couldn't settle. Reads only the job
// header + description + key skills, not the "similar jobs" sidebar, which
// would otherwise match skills from unrelated postings.
async function checkJobPage(jobPage, needsPage) {
  await jobPage.locator('[class*="job-desc"], [class*="key-skill"], [class*="jd-header"]').first()
    .waitFor({ timeout: 10000 }).catch(() => {});
  const parts = await jobPage.locator(
    '[class*="jd-header"], [class*="job-header"], [class*="job-desc"], [class*="key-skill"]'
  ).allInnerTexts().catch(() => []);
  const text = parts.join(' \n ');
  if (!text.trim()) return { ok: false, reason: 'job page details not found' };
  if (needsPage.includes('experience')) {
    const exp = extractExperienceRange(text);
    if (!exp) return { ok: false, reason: 'experience range not found' };
    if (!experienceMatches(exp)) return { ok: false, reason: `experience ${exp.min}-${exp.max} yrs outside ${cfg.minExp}-${cfg.maxExp}` };
  }
  if (needsPage.includes('skills')) {
    const found = matchedSkills(text);
    if (found.length < cfg.minSkillMatch) {
      return { ok: false, reason: `skills matched ${found.length}/${cfg.minSkillMatch} (${found.join(', ') || 'none'})` };
    }
  }
  return { ok: true };
}

// ---------- Recommended-jobs run ----------
export async function runRecommended(context, page) {
  log('\n🎯 Recommended jobs — apply across all tabs');
  log(`   filter:      ${cfg.recommendedFilter
    ? `role title + >=${cfg.minSkillMatch} skill(s) of [${cfg.skills.join(', ')}] + ${cfg.minExp}-${cfg.maxExp} yrs`
    : 'none (apply to all)'}`);
  log(`   cap per tab: ${cfg.recommendedMaxPerTab || 'none'}`);
  log(`   dry-run:     ${cfg.dryRun}`);

  const applied = loadApplied();
  const seenThisRun = new Set();
  const stats = { applied: 0, alreadyApplied: 0, would: 0, skipped: 0, irrelevant: 0, errors: 0, seen: 0 };

  await openRecommendedPage(page);

  for (const tab of TABS) {
    const label = await openTab(page, tab);
    if (!label) {
      log(`\n   ⚠️  tab "${tab.id}" not found — skipping`);
      continue;
    }
    const cards = await collectCards(page);
    log(`\n📑 Tab: ${label} — ${cards.length} card(s)`);
    if (!cards.length) await screenshot(page, `recommended-empty-${tab.id}`);

    let attempts = 0;
    for (const card of cards) {
      if (cfg.recommendedMaxPerTab && attempts >= cfg.recommendedMaxPerTab) {
        log(`   reached RECOMMENDED_MAX_PER_TAB (${cfg.recommendedMaxPerTab}) — next tab.`);
        break;
      }
      // Same job often shows up in several tabs — skip ones already handled
      // in past runs (applied.json) or in an earlier tab this run.
      if (applied.has(card.id) || seenThisRun.has(card.id)) continue;
      seenThisRun.add(card.id);
      stats.seen++;

      let needsPage = [];
      if (cfg.recommendedFilter) {
        const c = checkCard(card);
        if (!c.ok) {
          log(`   🚫 filtered out: "${card.title}" — ${c.reason}`);
          stats.irrelevant++;
          continue;
        }
        needsPage = c.needsPage;
      }

      const label = `${card.title.slice(0, 55).padEnd(55)}  @  ${(card.company || '?').slice(0, 30)}`;
      log(`  → ${label}`);

      let r;
      try {
        const jobPage = await openCardJob(page, context, card.id);
        const pageCheck = jobPage && needsPage.length ? await checkJobPage(jobPage, needsPage) : { ok: true };
        if (!jobPage) {
          attempts++;
          r = { ...card, url: '', status: 'error', reason: 'card-did-not-open-job-page' };
          await screenshot(page, `recommended-noopen-${card.id}`);
        } else if (!pageCheck.ok) {
          // Remember it so later runs don't reopen the same irrelevant job.
          log(`     🚫 filtered out on job page — ${pageCheck.reason}`);
          await jobPage.close().catch(() => {});
          stats.irrelevant++;
          applied.add(card.id);
          if (!cfg.dryRun) saveApplied(applied);
          await page.bringToFront().catch(() => {});
          await jitter(1500, 3000);
          continue;
        } else {
          attempts++;
          r = await applyToJob(context, { id: card.id, url: jobPage.url(), title: card.title, company: card.company }, jobPage);
        }
      } catch (e) {
        r = { ...card, url: '', status: 'error', reason: e.message.slice(0, 200) };
      }
      delete r.cardText;
      appendResult({ ...r, reason: `[recommended:${tab.id}] ${r.reason || ''}`.trim() });

      const icon =
        r.status === 'applied'         ? '✅' :
        r.status === 'already-applied' ? '☑️' :
        r.status === 'would-apply'     ? '📝' :
        r.status === 'skipped'         ? '⏭️' :
        r.status === 'error'           ? '❌' : '❓';
      log(`     ${icon} ${r.status}${r.reason ? '  (' + r.reason + ')' : ''}`);

      if (r.status === 'applied')             { stats.applied++;        applied.add(card.id); }
      else if (r.status === 'already-applied'){ stats.alreadyApplied++; applied.add(card.id); }
      else if (r.status === 'would-apply')    { stats.would++; }
      else if (r.status === 'skipped')        { stats.skipped++;        applied.add(card.id); }
      else if (r.status === 'error')          { stats.errors++; }

      // Dry runs must not persist ids, or the next real run would skip them.
      if (!cfg.dryRun) saveApplied(applied);
      await page.bringToFront().catch(() => {});
      await jitter(3000, 5500);
    }
  }

  log('\n📊 Recommended jobs summary');
  log(`   ✅ applied:         ${stats.applied}`);
  log(`   ☑️ already applied: ${stats.alreadyApplied}`);
  if (cfg.dryRun) log(`   📝 would-apply:     ${stats.would}`);
  log(`   ⏭️ skipped:         ${stats.skipped}`);
  if (cfg.recommendedFilter) log(`   🚫 filtered out:    ${stats.irrelevant}`);
  log(`   ❌ errors:          ${stats.errors}`);
  log(`   👀 total seen:      ${stats.seen}`);
  return stats;
}

// ---------- Standalone entry point ----------
if (isMainModule(import.meta.url)) {
  (async () => {
    requireCreds();
    const { browser, context } = await launchContext();
    try {
      const page = await ensureLoggedIn(context);
      await runRecommended(context, page);
      await context.storageState({ path: STORAGE_STATE });
    } finally {
      await browser.close();
    }
  })().catch(err => {
    console.error('FATAL', err);
    process.exit(1);
  });
}
