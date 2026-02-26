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

async function scrapePage(page: Page, pageNum: number): Promise<string> {
  const url = pageNum === 1 ? BASE_URL : `${BASE_URL}/?page=${pageNum}`;
  console.log(`  → Navigating to: ${url}`);

  // Use domcontentloaded instead of networkidle — more reliable for JS-rendered pages
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for h2 with a longer timeout; fall back to fixed delay if it times out
  try {
    await page.waitForSelector('h2', { timeout: 30000, state: 'visible' });
  } catch {
    console.log(`  ⚠ waitForSelector('h2') timed out on page ${pageNum}, using 5s fallback delay...`);
    await page.waitForTimeout(5000);
  }

  // Extra buffer for any remaining lazy-loaded JS
  await page.waitForTimeout(2000);

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

    const h2Elements = Array.from(document.querySelectorAll('h2'));

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

  // Build the markdown string for this page
  let md = `\n\n---\n\n<!-- ========== PAGE ${pageNum} of ${TOTAL_PAGES} ========== -->\n\n`;
  md += `# Page ${pageNum} of ${TOTAL_PAGES}\n\n`;
  md += `**Source:** ${url}\n\n`;
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
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });

  const page: Page = await context.newPage();

  // Auto-dismiss any browser dialogs
  page.on('dialog', async (dialog) => {
    await dialog.dismiss().catch(() => {});
  });

  try {
    for (let pageNum = 1; pageNum <= TOTAL_PAGES; pageNum++) {
      console.log(`\n📄 Processing page ${pageNum} of ${TOTAL_PAGES}...`);

      let pageContent = '';
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        try {
          pageContent = await scrapePage(page, pageNum);
          break; // success — exit retry loop
        } catch (err) {
          attempts++;
          console.log(`  ⚠ Attempt ${attempts} failed: ${(err as Error).message}`);
          if (attempts < maxAttempts) {
            console.log(`  ↺ Retrying in 3 seconds...`);
            await page.waitForTimeout(3000);
          } else {
            console.log(`  ✗ All ${maxAttempts} attempts failed. Skipping page ${pageNum}.`);
            pageContent = `\n\n<!-- PAGE ${pageNum} FAILED TO SCRAPE -->\n\n`;
          }
        }
      }

      // Append this page's markdown to the output file
      fs.appendFileSync(OUTPUT_FILE, pageContent, 'utf-8');
      console.log(`  ✓ Page ${pageNum} written to file`);

      // Polite delay between pages
      if (pageNum < TOTAL_PAGES) {
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
