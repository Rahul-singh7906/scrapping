/// <reference lib="dom" />
import { chromium, Page } from "playwright";
import * as fs from "fs";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

interface Reply {
  author: string;
  time: string;
  content: string;
  likes: number;
}

interface DiscussionDetail {
  title: string;
  url: string;
  author: string;
  authorRole?: string;
  time: string;
  content: string;
  views: number;
  likes: number;
  comments: number;
  replies: Reply[];
}

interface TopicMetadata {
  lastScrapedAt: string;
  totalDiscussions: number;
}

interface ScrapeMetadata {
  [topicPath: string]: TopicMetadata;
}

const METADATA_FILE = "scrape_metadata.json";

function readMetadata(): ScrapeMetadata {
  if (fs.existsSync(METADATA_FILE)) {
    const raw = fs.readFileSync(METADATA_FILE, "utf-8");
    return JSON.parse(raw) as ScrapeMetadata;
  }
  return {};
}

function writeMetadata(metadata: ScrapeMetadata): void {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

function loadExistingDiscussions(outputFilename: string): DiscussionDetail[] {
  if (fs.existsSync(outputFilename)) {
    const raw = fs.readFileSync(outputFilename, "utf-8");
    return JSON.parse(raw) as DiscussionDetail[];
  }
  return [];
}

async function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Random user agents to rotate
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];

function getRandomUserAgent() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// Parse proxy configuration
function getProxyConfig() {
  const proxy = process.env.PROXY_URL || process.argv.find(arg => arg.startsWith('--proxy='))?.split('=')[1];
  if (!proxy) return undefined;
  
  try {
    const url = new URL(proxy);
    return {
      server: `${url.protocol}//${url.host}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch (err) {
    console.warn(`Invalid proxy URL: ${proxy}`);
    return undefined;
  }
}

// Text cleanup utilities
function normalizeWhitespace(s: string) {
  return s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function cleanLines(raw: string, ctx: { title?: string; author?: string; time?: string }) {
  const forbidden = new Set([
    'tag',
    'like',
    'reply',
    'copy link',
    'follow',
    'report',
    'marked as solution',
    'solved',
  ]);
  const roleTokens = ['contributor', 'ambassador', 'support team'];
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const cleaned: string[] = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (ctx.title && line === ctx.title) continue;
    if (ctx.author && line === ctx.author) continue;
    if (ctx.time && line === ctx.time) continue;
    if (forbidden.has(lower)) continue;
    if (/^\d{1,4}$/.test(line)) continue; // stray counts like 2, 30, etc.
    if (roleTokens.some((t) => lower.includes(t))) continue; // roles shouldn't be inside content
    
    // Skip reply count and sorting UI elements
    if (/^\d+\s+Repl/i.test(line)) continue; // "23 Replies", "9 Reply"
    if (/Replies?\s+sorted\s+by/i.test(line)) continue; // "Replies sorted by Most"
    if (/sorted\s+by\s+(most|newest|oldest)/i.test(line)) continue; // "sorted by Most Liked"
    if (/^(most|newest|oldest)\s+(liked|recent)/i.test(line)) continue; // "Most Liked"
    
    cleaned.push(line);
  }
  let out = cleaned.join(' ');
  // remove combined like/reply junk like "LikeLike0ReplyReply"
  out = out.replace(/\bLike\b(?:\s*\d+)?/gi, ' ').replace(/\bReply\b/gi, ' ');
  // remove reply count patterns that might be inline
  out = out.replace(/\b\d+\s+Repl(?:y|ies)?\b/gi, ' ');
  out = out.replace(/\bReplies?\s+sorted\s+by\s+\w+/gi, ' ');
  out = out.replace(/\bsorted\s+by\s+(most|newest|oldest)\s+\w*/gi, ' ');
  out = out.replace(/\s{2,}/g, ' ');
  return normalizeWhitespace(out);
}

// Infer author from beginning of content when selector fails, and strip it from content
function extractAuthorFromContent(content: string): { author?: string; content: string } {
  // Author is often the first token before the actual message
  // Pattern: start of string, a word-like token (allows letters, digits, underscore, hyphen), then space or punctuation
  const m = content.match(/^([A-Za-z][A-Za-z0-9_\-]{2,})\b[\s,:-]+(.*)$/);
  if (m) {
    const [, candidate, rest] = m;
    // Avoid common words that are not usernames
    const blacklist = new Set(['Hi', 'Has', 'I', 'We', 'Thanks', 'Hey', 'Hello']);
    if (!blacklist.has(candidate)) {
      return { author: candidate, content: rest.trim() };
    }
  }
  return { content };
}

// Convert relative date strings ("2 months ago", "yesterday", etc.) to absolute YYYY-MM-DD
function parseRelativeDate(relativeText: string, referenceDate?: Date): string {
  const text = (relativeText || "").trim().toLowerCase();
  if (!text) return relativeText;

  const ref = referenceDate || new Date();

  // Already an absolute date (YYYY-MM-DD or similar)
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return relativeText.trim();

  // "just now", "a moment ago"
  if (/^(just now|a moment ago|moments ago)$/.test(text)) {
    return ref.toISOString().slice(0, 10);
  }

  // "yesterday"
  if (text === "yesterday") {
    const d = new Date(ref);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }

  // Pattern: "(a|an|<number>) <unit>(s) ago"
  const match = text.match(/^(\d+|a|an)\s+(minute|hour|day|week|month|year)s?\s+ago$/);
  if (match) {
    const amount = (match[1] === "a" || match[1] === "an") ? 1 : parseInt(match[1], 10);
    const unit = match[2];
    const d = new Date(ref);

    switch (unit) {
      case "minute":
        d.setMinutes(d.getMinutes() - amount);
        break;
      case "hour":
        d.setHours(d.getHours() - amount);
        break;
      case "day":
        d.setDate(d.getDate() - amount);
        break;
      case "week":
        d.setDate(d.getDate() - amount * 7);
        break;
      case "month":
        d.setMonth(d.getMonth() - amount);
        break;
      case "year":
        d.setFullYear(d.getFullYear() - amount);
        break;
    }
    return d.toISOString().slice(0, 10);
  }

  // Fallback: return original text unchanged
  return relativeText.trim();
}

// ✅ Scrape replies and main content from an open discussion page
async function scrapeDiscussionDetail(page: Page, url: string): Promise<DiscussionDetail> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Random delay to avoid pattern detection
  await delay(Math.random() * 2000 + 1000);
  await page.waitForSelector("article, [data-testid='MessageSubject']", { timeout: 15000 });

  // Count current leaf articles on page
  async function countArticles(): Promise<number> {
    return page.locator("article:not(:has(article))").count();
  }

  // Click any visible "Load more" / "Show more" buttons
  async function clickExpandButtons(): Promise<boolean> {
    let clickedAny = false;
    const selectors = [
      "[data-testid*='LoadMore']",
      "[data-testid*='load-more']",
      "[data-testid*='show-more']",
      "[data-testid*='ShowMore']",
      "button:has-text('Load more replies')",
      "a:has-text('Load more replies')",
      "button:has-text('Show More')",
      "a:has-text('Show More')",
      "button:has-text('Show more')",
      "a:has-text('Show more')",
      "button:has-text('Read More')",
      "a:has-text('Read More')",
      "button:has-text('Read more')",
      "a:has-text('Read more')",
      "button:has-text('View more')",
      "a:has-text('View more')",
      "button:has-text('more replies')",
      "a:has-text('more replies')",
    ];
    for (const sel of selectors) {
      const loc = page.locator(sel);
      const count = await loc.count();
      for (let i = 0; i < count; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 3000 }).catch(() => {});
          clickedAny = true;
          await delay(2000); // wait for new content to load
        }
      }
    }
    return clickedAny;
  }

  // Scroll + click loop until no more content loads
  let noChangeRounds = 0;
  for (let round = 0; round < 200; round++) {
    const beforeCount = await countArticles();

    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1000);

    // Click any expand buttons
    const clicked = await clickExpandButtons();

    // Scroll again after clicking (new buttons may appear below)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1000);

    const afterCount = await countArticles();

    if (afterCount > beforeCount) {
      noChangeRounds = 0; // reset counter, we're still loading
    } else if (clicked) {
      // Clicked but no growth yet - content may still be loading, only count as half
      noChangeRounds += 0.5;
    } else {
      noChangeRounds++;
    }

    // Only stop after 5 consecutive no-change rounds with nothing to click
    if (noChangeRounds >= 5) break;

    if (round % 5 === 0) {
      console.log(`  ↳ Expanding replies... ${afterCount} articles loaded so far (round ${round})`);
    }
  }

  const title = await page.locator("h1, h2[data-testid='MessageSubject']").first().textContent().catch(() => "");
  const mainAuthor = await page.locator("a[data-testid='userLink']").first().textContent().catch(() => "");
  const mainTime = await page.locator("[data-testid='messageTime']").first().textContent().catch(() => "");
  const mainRole = await page.locator("[data-testid*='rank'], [data-testid*='role'], [class*='badge'], [class*='Rank'], [class*='Title']").first().textContent().catch(() => "");
  // Get full innerText of main body container to preserve paragraphs and line breaks
  const mainContentRaw = await page.evaluate(() => {
    const body = document.querySelector(
      ".MessageViewBody_lia-message-body-content__kHe3r, .lia-message-body-content, article .lia-message-body-content, article .MessageViewBody_lia-message-body-content__kHe3r, article"
    ) as HTMLElement | null;
    return body ? body.innerText.trim() : "";
  });
  let mainContent = cleanLines(mainContentRaw || '', { title: title?.trim(), author: mainAuthor?.trim(), time: mainTime?.trim() });
  // Fallback: if author not found via selector, try to infer from content prefix
  let author = (mainAuthor || '').trim();
  if (!author && mainContent) {
    const inferred = extractAuthorFromContent(mainContent);
    if (inferred.author) author = inferred.author;
    if (inferred.content) mainContent = inferred.content;
  }

  // Collect replies: try multiple selectors for reply containers
  let repliesRaw: any[] = [];
  const replySelectors = [
    "article:not(:has(article))",  // leaf articles only, skip wrapper articles
    "li[data-testid^='message']",
    "[data-testid='message-view']",
    ".lia-message-view",
  ];
  
  for (const selector of replySelectors) {
    try {
      repliesRaw = await page.$$eval(
        selector,
        (elements) =>
          elements.slice(1).map((el) => {
            const body = (el.querySelector(
              ".MessageViewBody_lia-message-body-content__kHe3r, .lia-message-body-content, .topic-body, .comment-body"
            ) as HTMLElement | null);
            let author = (el.querySelector("a[data-testid='userLink']") as HTMLElement | null)?.textContent?.trim() || "";
            // Guard: "Liked"/"Like" comes from kudos button, not a real username
            if (author.toLowerCase() === "liked" || author.toLowerCase() === "like") {
              author = "";
            }
            const time = (el.querySelector("[data-testid='messageTime'] span, [data-testid='messageTime']") as HTMLElement | null)?.textContent?.trim() || "";
            const role = (el.querySelector("[data-testid*='rank'], [data-testid*='role'], [class*='badge'], [class*='Rank'], [class*='Title']") as HTMLElement | null)?.textContent?.trim() || '';
            let content = body ? body.innerText.trim() : ((el as HTMLElement).innerText || "").trim();
            // Pre-filter obvious UI noise before processing
            content = content.replace(/^\d+\s+Repl(?:y|ies)?\s*/i, '');
            content = content.replace(/Replies?\s+sorted\s+by\s+\w+\s*/gi, '');
            content = content.replace(/sorted\s+by\s+(most|newest|oldest)\s+\w*\s*/gi, '');
            const likeText = (el.querySelector("button[data-testid='kudosButton'], [data-testid='kudosCount']") as HTMLElement | null)?.textContent?.trim() || "";
            const likes = parseInt(likeText.replace(/\D/g, "")) || 0;
            return { author, role, time, content, likes };
          })
      );
      console.log(`→ Found ${repliesRaw.length} replies using selector: ${selector}`);
      if (repliesRaw.length > 0) break;
    } catch (err) {
      console.log(`→ Selector ${selector} failed, trying next...`);
    }
  }

  // Get expected replies count from the page label, e.g., "2 Replies"
  const expectedReplies = await page.locator("text=/\\d+\\s+Repl/i").first().textContent().then(t => {
    const m = t?.match(/(\d+)/); return m ? parseInt(m[1], 10) : undefined;
  }).catch(() => {
    // Fallback: try other common reply count patterns
    return page.evaluate(() => {
      const patterns = [
        /(\d+)\s+Repl/i,
        /Repl.*?(\d+)/i,
        /(\d+)\s+comment/i,
        /comment.*?(\d+)/i
      ];
      for (const pattern of patterns) {
        const match = document.body.textContent?.match(pattern);
        if (match) return parseInt(match[1], 10);
      }
      return undefined;
    }).catch(() => undefined);
  });
  
  console.log(`→ Expected replies from page: ${expectedReplies}, Found raw replies: ${repliesRaw.length}`);

  const replies: DiscussionDetail['replies'] = repliesRaw
    .map((r: any) => {
      // Clean content and infer author if missing
      let cleaned = cleanLines(r.content || '', { author: r.author, time: r.time });
      let replyAuthor = (r.author || '').trim();
      if (!replyAuthor && cleaned) {
        const inf = extractAuthorFromContent(cleaned);
        if (inf.author) replyAuthor = inf.author;
        if (inf.content) cleaned = inf.content;
      }
      return {
        author: replyAuthor,
        time: parseRelativeDate(r.time),
        content: cleaned,
        likes: r.likes,
      };
    })
    // drop empties
    .filter(r => (r.author && r.author.trim().length > 0) || (r.content && r.content.trim().length > 0));
  
  // Deduplicate replies by content fingerprint
  const seen = new Set<string>();
  const dedupedReplies = replies.filter(r => {
    const fp = `${r.author}::${r.content.substring(0, 100)}`;
    if (seen.has(fp)) return false;
    seen.add(fp);
    return true;
  });

  console.log(`→ After cleanup: ${dedupedReplies.length} valid replies`);

  // Log reply count comparison (informational only, never truncate scraped data)
  if (typeof expectedReplies === 'number' && expectedReplies >= 0 && dedupedReplies.length !== expectedReplies) {
    console.log(`⚠️ Reply count mismatch: page says ${expectedReplies}, extracted ${dedupedReplies.length}`);
  }
  const limitedReplies = dedupedReplies;

  // Grab counters if visible
  const viewCount = await page.locator("svg use[href*='views']").evaluateAll(
    (nodes) => nodes.length
  ).catch(() => 0);

  return {
    title: title?.trim() || "",
    url,
    author: author || "",
    authorRole: normalizeWhitespace(mainRole || ''),
    time: parseRelativeDate(mainTime?.trim() || ""),
    content: mainContent?.trim() || "",
    views: viewCount || 0,
    likes: 0,
    comments: limitedReplies.length,
    replies: limitedReplies,
  };
}

// ✅ Scrape the list of discussions across ALL pages (pagination + load more + infinite scroll)
// When existingUrls is provided, stops pagination once it hits already-scraped discussions (incremental mode)
// Saves progress incrementally to outputFilename after each discussion (if provided)
async function scrapeDiscussionList(
  page: Page,
  topicUrl: string,
  existingUrls: Set<string> = new Set(),
  existingDiscussions: DiscussionDetail[] = [],
  outputFilename?: string
): Promise<DiscussionDetail[]> {
  const collected = new Map<string, { title: string; url: string; author: string; time: string; views: number; likes: number; comments: number }>();
  const visitedPages = new Set<string>();
  let hitExisting = false;

  // Returns true if we hit previously-scraped discussions and should stop
  async function collectFromCurrentPage(): Promise<boolean> {
    const summaries = await page.$$eval(
      "li.PaneledItemList_lia-panel-list-item__bV87f",
      (items) =>
        items.map((el) => {
          const titleEl = el.querySelector("h4 a[data-testid='MessageLink']");
          const title = titleEl?.textContent?.trim() || "";
          const url = titleEl ? (titleEl as HTMLAnchorElement).href : "";
          const author = el.querySelector("a[data-testid='userLink']")?.textContent?.trim() || "";
          const time = el.querySelector("[data-testid='messageTime'] span")?.textContent?.trim() || "";
          const views = parseInt(
            el.querySelector("[data-testid='ViewCount']")?.textContent?.replace(/\D/g, "") || "0"
          );
          const likes = parseInt(
            el.querySelector("[data-testid='kudosCount']")?.textContent?.replace(/\D/g, "") || "0"
          );
          const comments = parseInt(
            el.querySelector("[data-testid='messageRepliesCount']")?.textContent?.replace(/\D/g, "") || "0"
          );
          return { title, url, author, time, views, likes, comments };
        })
    );

    let newOnThisPage = 0;
    let existingOnThisPage = 0;

    for (const s of summaries) {
      if (s.url && !collected.has(s.url)) {
        if (existingUrls.has(s.url)) {
          existingOnThisPage++;
        } else {
          collected.set(s.url, s);
          newOnThisPage++;
        }
      }
    }

    if (existingUrls.size > 0) {
      console.log(`→ Page yielded ${newOnThisPage} new, ${existingOnThisPage} already-scraped`);
    }
    console.log(`→ Collected ${collected.size} new discussion(s) so far`);

    // If we found any existing URL, we've reached old content
    // Since listing is sorted most-recent-first, all subsequent pages are also old
    if (existingOnThisPage > 0) {
      hitExisting = true;
    }

    return hitExisting;
  }

  async function tryLoadMoreAndScroll() {
    // Click in-page load/show more buttons if any
    for (let i = 0; i < 20; i++) {
      const btn = page.locator("button:has-text('Load more'), button:has-text('Show more'), [data-testid*='load-more']").first();
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) break;
      await Promise.all([
        page.waitForLoadState('domcontentloaded'),
        btn.click().catch(() => {}),
      ]);
      await delay(500);
      await collectFromCurrentPage();
      if (hitExisting) return;
    }
    // Infinite scroll until height stops growing
    for (let i = 0; i < 20; i++) {
      const prev = await page.evaluate(() => document.body.scrollHeight);
      await page.mouse.wheel(0, 2000);
      await delay(500);
      const next = await page.evaluate(() => document.body.scrollHeight);
      await collectFromCurrentPage();
      if (hitExisting) return;
      if (next <= prev) break;
    }
  }

  let current: string | null = topicUrl;
  while (current) {
    if (visitedPages.has(current)) break;
    await page.goto(current, { waitUntil: 'networkidle' });
    visitedPages.add(current);
    // Wait for list items
    await page.waitForSelector("li.PaneledItemList_lia-panel-list-item__bV87f", { timeout: 15000 }).catch(() => {});

    const shouldStop = await collectFromCurrentPage();
    if (shouldStop) {
      console.log("→ Hit previously-scraped discussions. Stopping pagination.");
      break;
    }

    await tryLoadMoreAndScroll();
    if (hitExisting) {
      console.log("→ Hit previously-scraped discussions after scroll. Stopping.");
      break;
    }

    // Find explicit Next link - try multiple selectors for different Khoros pagination styles
    let nextHref: string | null = null;
    const nextSelectors = [
      ".pagination a[rel='next']",
      "a[aria-label='Next Page']",
      "a[aria-label='Next']",
      "a:has-text('Next')",
      // Khoros Aurora cursor-based pagination: links with ?after= parameter
      "a[href*='?after=']",
      "a[href*='&after=']",
      // PagerPreviousNextLinkable component
      "[data-testid*='pager'] a",
      "[data-testid*='Pager'] a",
      "[class*='Pager'] a:not(:has-text('Previous')):not(:has-text('first'))",
      "[class*='pager'] a:not(:has-text('Previous')):not(:has-text('first'))",
    ];
    for (const sel of nextSelectors) {
      nextHref = await page.locator(sel).first().getAttribute('href').catch(() => null);
      if (nextHref) break;
    }
    if (nextHref) {
      const nextUrl = new URL(nextHref, current).toString();
      // Don't revisit already-seen pages
      if (visitedPages.has(nextUrl)) {
        current = null;
      } else {
        console.log(`→ Found next page: ${nextUrl.substring(nextUrl.indexOf('?'))}`);
        current = nextUrl;
      }
    } else {
      current = null;
    }
  }

  // Open each NEW discussion and collect full details
  // Save incrementally after each discussion to avoid data loss
  const allDetails: DiscussionDetail[] = [];
  const collectedArray = Array.from(collected.values());
  for (let i = 0; i < collectedArray.length; i++) {
    const d = collectedArray[i];
    console.log(`🧩 [${i + 1}/${collectedArray.length}] Opening discussion: ${d.title}`);
    // Random delay between requests (1-4 seconds)
    await delay(Math.random() * 3000 + 1000);
    try {
      const fullDetail = await scrapeDiscussionDetail(page, d.url);
      fullDetail.views = d.views;
      fullDetail.likes = d.likes;
      allDetails.push(fullDetail);

      // Save progress incrementally after each discussion
      if (outputFilename) {
        const merged = [...allDetails, ...existingDiscussions];
        fs.writeFileSync(outputFilename, JSON.stringify(merged, null, 2));
        console.log(`💾 Saved progress: ${allDetails.length} new + ${existingDiscussions.length} existing = ${merged.length} total`);
      }
    } catch (err) {
      console.error(`❌ Failed to scrape ${d.url}:`, err);
      // Longer delay on error to avoid being flagged
      await delay(5000);
    }
  }
  return allDetails;
}

(async () => {
  const proxyConfig = getProxyConfig();
  if (proxyConfig) {
    console.log(`🌐 Using proxy: ${proxyConfig.server}`);
  }

  const browser = await chromium.launch({ 
    headless: false,
    proxy: proxyConfig,
  });
  
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1366, height: 768 },
    // Additional stealth settings
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  
  const page = await context.newPage();
  
  // Set random timezone and hide webdriver
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

// List of target URLs to scrape
  const targetUrls = [
    "https://community.getjobber.com/category/using-jobber/discussions/online-booking-requests/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/marketing-tools/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/quoting/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/job-details-scheduling/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/invoicing-getting-paid/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/insights-reporting/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/team-management/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/integrations/all-topics",
    "https://community.getjobber.com/category/using-jobber/discussions/customer-management-and-self-serve/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/marketing-forum/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/operations-forum/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/finances-forum/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/hiring--team-forum/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/equipment--tools-forum/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/entrepreneurship-forum/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/electrical-mastermind-group/all-topics",
    "https://community.getjobber.com/category/ask-the-community/discussions/announcements/all-topics",
  ];

  // Check for login only once at the beginning
  await page.goto(targetUrls[0], { waitUntil: "domcontentloaded" });

  const needsLogin = await page.isVisible('text="Sign In"');
  if (needsLogin && !process.env.SKIP_LOGIN) {
    console.log("➡️ Please click 'Sign In' and complete login manually, then press Resume.");
    console.log("   (Set SKIP_LOGIN=1 to skip this prompt and scrape without logging in)");
    await page.pause();
  } else if (needsLogin) {
    console.log("⚠️ Sign In detected but SKIP_LOGIN is set — continuing without login.");
  }

  console.log(`🤖 Using User-Agent: ${await page.evaluate(() => navigator.userAgent)}`);

  // Load scrape metadata for incremental mode
  const metadata = readMetadata();
  console.log(`📊 Loaded scrape metadata for ${Object.keys(metadata).length} topic(s)`);
  console.log(`\n📋 Processing ${targetUrls.length} URL(s) synchronously...\n`);

  // Process each URL synchronously (one at a time)
  for (let i = 0; i < targetUrls.length; i++) {
    const targetUrl = targetUrls[i];
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🔄 [${i + 1}/${targetUrls.length}] Processing: ${targetUrl}`);
    console.log('='.repeat(80));

    try {
      // Extract topic path from URL for filename
      const topicPathMatch = targetUrl.match(/\/discussions\/([^\/]+)/);
      if (!topicPathMatch) {
        console.error("❌ Invalid target URL format. Skipping...");
        continue;
      }

      const topicPath = topicPathMatch[1];
      console.log(`📂 Topic path identified: ${topicPath}`);
      const outputFilename = `${topicPath.replace(/\//g, "_")}_full.json`;
      console.log(`💾 Output filename: ${outputFilename}`);

      // Load existing data for incremental scraping
      const existingDiscussions = loadExistingDiscussions(outputFilename);
      const existingUrls = new Set(existingDiscussions.map(d => d.url));
      console.log(`📂 Found ${existingDiscussions.length} existing discussions in ${outputFilename}`);

      // Scrape only NEW discussions (incremental mode)
      // Saves progress after each discussion so data isn't lost if interrupted
      console.log("🔍 Scraping new discussions (incremental mode with auto-save)...");
      const newDiscussions = await scrapeDiscussionList(page, targetUrl, existingUrls, existingDiscussions, outputFilename);
      console.log(`🆕 Completed ${newDiscussions.length} new discussion(s)`);

      // Final merge and save (in case no new discussions or to ensure final state)
      const mergedDiscussions = [...newDiscussions, ...existingDiscussions];
      fs.writeFileSync(outputFilename, JSON.stringify(mergedDiscussions, null, 2));
      console.log(`✅ Final save: ${mergedDiscussions.length} total discussion(s) to ${outputFilename}`);

      // Update metadata
      metadata[topicPath] = {
        lastScrapedAt: new Date().toISOString(),
        totalDiscussions: mergedDiscussions.length,
      };
      writeMetadata(metadata);
      console.log(`📊 Updated metadata for ${topicPath}`);

      // Add delay between URLs to avoid rate limiting (except for the last URL)
      if (i < targetUrls.length - 1) {
        const delaySeconds = Math.random() * 3 + 2; // 2-5 seconds
        console.log(`⏳ Waiting ${delaySeconds.toFixed(1)}s before next URL...`);
        await delay(delaySeconds * 1000);
      }
    } catch (err) {
      console.error(`❌ Error processing ${targetUrl}:`, err);
      console.log("⏩ Continuing to next URL...");
      // Add longer delay after error
      if (i < targetUrls.length - 1) {
        await delay(5000);
      }
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`🎉 Completed processing all ${targetUrls.length} URL(s)`);
  console.log('='.repeat(80));

  // Print final metadata summary
  console.log(`\n📊 Scrape metadata summary:`);
  for (const [topic, meta] of Object.entries(metadata)) {
    console.log(`   ${topic}: ${meta.totalDiscussions} discussions, last scraped ${meta.lastScrapedAt}`);
  }

  await browser.close();
})();
