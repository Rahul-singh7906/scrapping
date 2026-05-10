import { chromium, Browser, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'https://productupdates.getjobber.com';
const TOTAL_PAGES = 15;
const OUTPUT_FILE = path.join(__dirname, 'jobber-product-updates.md');

interface Post {
  tags: string[];
  title: string;
  url: string;
  author: string;
  date: string;
  body: string;
}

const CF_PHRASES = [
  'Performing security verification',
  'Verification successful',
  'Just a moment',
];

async function waitForCfClear(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction(
      (phrases: string[]) => {
        // Any h1 means we're on real content (CF only uses h2 for challenges)
        if (document.querySelectorAll('h1').length > 0) return true;
        const h2s = Array.from(document.querySelectorAll('h2'));
        if (h2s.length === 0) return false;
        return !h2s.some((h) => phrases.some((p) => h.textContent?.includes(p)));
      },
      CF_PHRASES,
      { timeout: timeoutMs },
    );
  } catch {
    // timed out — proceed with whatever is on the page
  }
}

async function scrapePage(page: Page, pageNum: number): Promise<string> {
  const url = page.url() || BASE_URL;
  console.log(`  → Scraping: ${url}`);

  // Wait for h1 or h2 (post titles use h1 on some pages, h2 on others)
  try {
    await page.waitForSelector('h1, h2', { timeout: 30000, state: 'visible' });
  } catch {
    console.log(`  ⚠ waitForSelector('h1, h2') timed out on page ${pageNum}, using 5s fallback delay...`);
    await page.waitForTimeout(5000);
  }

  // Extra buffer for any remaining lazy-loaded JS
  await page.waitForTimeout(2000);

  // Wait for Cloudflare challenge to clear (up to 30s)
  await waitForCfClear(page, 30000);

  // Extract all structured post data from the page
  const posts: Post[] = await page.evaluate((): Post[] => {
    const results: Post[] = [];
    const knownTags = [
      'Feature Update',
      'New Feature',
      'Desktop App',
      'Mobile App',
      'Integrations',
      'Integration',
      'Product Bulletin',
    ];

    const h2Elements = Array.from(document.querySelectorAll('h1, h2'));

    for (const h2 of h2Elements) {
      const title = h2.textContent?.trim() ?? '';
      if (!title) continue;

      // URL: h2 is often wrapped inside an <a>
      const parentA = h2.closest('a') as HTMLAnchorElement | null;
      const postUrl = parentA?.href ?? '';

      // Walk up ~6 levels to find the card container
      let card: Element | null = h2;
      for (let i = 0; i < 6; i++) {
        if (card?.parentElement) {
          card = card.parentElement;
        } else {
          break;
        }
      }

      const cardEl = card as HTMLElement;
      const cardText = cardEl?.innerText ?? '';

      // Extract tags by matching known tag labels in span elements
      const tags: string[] = [];
      const spans = Array.from(cardEl?.querySelectorAll('span') ?? []);
      for (const span of spans) {
        const t = span.textContent?.trim() ?? '';
        if (knownTags.includes(t) && !tags.includes(t)) {
          tags.push(t);
        }
      }

      // Extract author & date from "Shared by X • Date" pattern
      let author = '';
      let date = '';
      const authorMatch = cardText.match(/Shared by ([^\n•]+)•\s*([^\n]+)/);
      if (authorMatch) {
        author = authorMatch[1].trim();
        date = authorMatch[2].trim();
      }

      // Extract body: everything after the "Shared by..." line
      let body = '';
      const sharedByIdx = cardText.indexOf('Shared by');
      if (sharedByIdx !== -1) {
        const afterSharedBy = cardText.substring(sharedByIdx);
        const firstNewline = afterSharedBy.indexOf('\n');
        if (firstNewline !== -1) {
          body = afterSharedBy.substring(firstNewline + 1).trim();
        }
      }

      // Strip pagination footer text from the body
      const paginationIdx = body.search(/‹ Prev|Next ›|\d+ of \d+/);
      if (paginationIdx !== -1) {
        body = body.substring(0, paginationIdx).trim();
      }

      results.push({ tags, title, url: postUrl, author, date, body });
    }

    return results;
  });

  const currentUrl = page.url();

  // Build the markdown string for this page
  let md = `\n\n---\n\n<!-- ========== PAGE ${pageNum} of ${TOTAL_PAGES} ========== -->\n\n`;
  md += `# Page ${pageNum} of ${TOTAL_PAGES}\n\n`;
  md += `**Source:** ${currentUrl}\n\n`;
  md += `---\n\n`;

  for (const post of posts) {
    if (post.tags.length > 0) {
      md += `**Tags:** ${post.tags.join(' | ')}\n\n`;
    }
    md += `## ${post.title}\n\n`;
    if (post.url) md += `**URL:** ${post.url}\n\n`;
    if (post.author) md += `**Shared by:** ${post.author}\n\n`;
    if (post.date) md += `**Date:** ${post.date}\n\n`;
    if (post.body) md += `${post.body}\n\n`;
    md += `---\n\n`;
  }

  return md;
}

async function main(): Promise<void> {
  console.log('🚀 Starting Jobber Product Updates scraper...');
  console.log(`📁 Output file: ${OUTPUT_FILE}\n`);

  // Write the file header (creates or overwrites the file)
  const header =
    `# Jobber Product Updates\n\n` +
    `Scraped from: ${BASE_URL}\n` +
    `Date: ${new Date().toISOString().split('T')[0]}\n` +
    `Total Pages: ${TOTAL_PAGES}\n`;
  fs.writeFileSync(OUTPUT_FILE, header, 'utf-8');

  const browser: Browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // Single context for the whole session — CF clearance is preserved across pages
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = await context.newPage();
  page.on('dialog', async (dialog) => { await dialog.dismiss().catch(() => {}); });

  // Selectors to try for the "Next page" link, in priority order
  const NEXT_SELECTORS = [
    'a[aria-label="Next page"]',
    'a[aria-label="Next"]',
    'a[rel="next"]',
    'a:has-text("Next ›")',
    'a:has-text("Next")',
    'a:has-text("›")',
    '.pagination a[href*="page="]',
  ];

  try {
    // Navigate to page 1 and clear the initial CF challenge
    console.log(`\n📄 Loading page 1 of ${TOTAL_PAGES}...`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForCfClear(page, 30000);

    for (let pageNum = 1; pageNum <= TOTAL_PAGES; pageNum++) {
      console.log(`\n📄 Processing page ${pageNum} of ${TOTAL_PAGES}...`);

      const pageContent = await scrapePage(page, pageNum);

      fs.appendFileSync(OUTPUT_FILE, pageContent, 'utf-8');
      console.log(`  ✓ Page ${pageNum} written to file`);

      if (pageNum >= TOTAL_PAGES) break;

      // Navigate to next page by clicking the Next link (keeps CF session alive)
      let navigated = false;
      for (const sel of NEXT_SELECTORS) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log(`  → Clicking next page link (${sel})...`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
            loc.click(),
          ]);
          await waitForCfClear(page, 20000);
          await page.waitForTimeout(1500);
          navigated = true;
          break;
        }
      }

      if (!navigated) {
        // Fallback: direct URL (may hit CF but worth trying)
        console.log(`  ⚠ No Next link found — falling back to direct URL for page ${pageNum + 1}`);
        await page.goto(`${BASE_URL}/?page=${pageNum + 1}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await waitForCfClear(page, 30000);
        await page.waitForTimeout(1500);
      }
    }

    console.log(`\n✅ Done! All ${TOTAL_PAGES} pages written to:\n   ${OUTPUT_FILE}`);
  } catch (error) {
    console.error('\n❌ Fatal error:', error);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
