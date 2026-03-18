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

const OUTPUT_DIR = "output";
const METADATA_FILE = `${OUTPUT_DIR}/scrape_metadata.json`;

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

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

type ProxyConfig = { server: string; username?: string; password?: string };

// Parse a URL-format proxy (http://user:pass@host:port or https://...)
function parseProxyUrl(proxy: string): ProxyConfig | null {
  try {
    const url = new URL(proxy);
    // Normalize https: -> http: (proxy connection is plain HTTP even when proxying HTTPS traffic)
    const protocol = url.protocol === 'https:' ? 'http:' : url.protocol;
    return {
      server: `${protocol}//${url.host}`,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined,
    };
  } catch {
    return null;
  }
}

// Parse a file-format proxy line: host:port:user:pass or host:port
function parseProxyLine(line: string): ProxyConfig | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const parts = trimmed.split(':');
  if (parts.length >= 4) {
    const [host, port, username, password] = parts;
    return { server: `http://${host}:${port}`, username, password };
  }
  if (parts.length === 2) {
    return { server: `http://${parts[0]}:${parts[1]}` };
  }
  return null;
}

// Load all proxies from web-proxies.txt
function loadProxiesFromFile(): ProxyConfig[] {
  const filePath = 'web-proxies.txt';
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map(parseProxyLine)
    .filter((p): p is ProxyConfig => p !== null);
}

// Build full proxy list: env/CLI proxy first, then all file proxies
function buildProxyList(): ProxyConfig[] {
  const cliProxy = process.env.PROXY_URL ||
    process.argv.find(arg => arg.startsWith('--proxy='))?.split('=')[1];
  const list: ProxyConfig[] = [];
  if (cliProxy) {
    const p = parseProxyUrl(cliProxy);
    if (p) list.push(p);
    else console.warn(`⚠️ Invalid proxy URL from env/args: ${cliProxy}`);
  }
  list.push(...loadProxiesFromFile());
  return list;
}

// Returns true when the error is a proxy/network connection failure
function isProxyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  return (
    msg.includes('ERR_PROXY_CONNECTION_FAILED') ||
    msg.includes('ERR_TIMED_OUT') ||
    msg.includes('ERR_HTTP_RESPONSE_CODE_FAILURE') ||
    msg.includes('ERR_CONNECTION_REFUSED') ||
    msg.includes('ERR_CONNECTION_TIMED_OUT') ||
    name === 'TimeoutError' ||
    msg.includes('Timeout') && msg.includes('exceeded')
  );
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
  await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
  // Random delay to avoid pattern detection
  await delay(Math.random() * 2000 + 1000);
  await page.waitForSelector("article, [data-testid='MessageSubject']", { timeout: 30000 });

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
          await el.click({ timeout: 5000 }).catch(() => {});
          clickedAny = true;
          // Wait for network to settle after clicking (replies load via AJAX)
          await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await delay(3000); // extra buffer for DOM rendering
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
    await delay(2000);

    // Click any expand buttons
    const clicked = await clickExpandButtons();

    // Scroll again after clicking (new buttons may appear below)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2000);

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
// When existingUrls is provided, uses incremental mode:
//   - Continues past existing discussions (they may have moved up due to new replies)
//   - Only stops when an ENTIRE page is all existing (stable zone)
//   - Re-scrapes existing discussions that appear above the stable zone (they have new activity)
// Saves progress incrementally to outputFilename after each discussion (if provided)
async function scrapeDiscussionList(
  page: Page,
  topicUrl: string,
  existingUrls: Set<string> = new Set(),
  existingDiscussions: DiscussionDetail[] = [],
  outputFilename?: string
): Promise<DiscussionDetail[]> {
  type DiscussionSummary = { title: string; url: string; author: string; time: string; views: number; likes: number; comments: number };
  const collected = new Map<string, DiscussionSummary>();        // brand new discussions
  const toRescrape = new Map<string, DiscussionSummary>();       // existing discussions with new activity
  const visitedPages = new Set<string>();
  let hitFullPageExisting = false;

  // Returns true if we hit a full page of previously-scraped discussions (stable zone)
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
      if (!s.url) continue;
      if (collected.has(s.url) || toRescrape.has(s.url)) continue; // already tracked

      if (existingUrls.has(s.url)) {
        existingOnThisPage++;
        // Existing discussion appeared above the stable zone — it has new activity, re-scrape it
        toRescrape.set(s.url, s);
      } else {
        collected.set(s.url, s);
        newOnThisPage++;
      }
    }

    if (existingUrls.size > 0) {
      console.log(`→ Page yielded ${newOnThisPage} new, ${existingOnThisPage} already-scraped (will re-scrape)`);
    }
    console.log(`→ Collected ${collected.size} new + ${toRescrape.size} to-rescrape discussion(s) so far`);

    // Only stop when the ENTIRE page is all existing discussions (stable zone)
    // This means we've passed all discussions with new activity
    if (summaries.length > 0 && existingOnThisPage === summaries.length) {
      hitFullPageExisting = true;
    }

    return hitFullPageExisting;
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
      if (hitFullPageExisting) return;
    }
    // Infinite scroll until height stops growing
    for (let i = 0; i < 20; i++) {
      const prev = await page.evaluate(() => document.body.scrollHeight);
      await page.mouse.wheel(0, 2000);
      await delay(500);
      const next = await page.evaluate(() => document.body.scrollHeight);
      await collectFromCurrentPage();
      if (hitFullPageExisting) return;
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
      console.log("→ Hit full page of existing discussions (stable zone). Stopping pagination.");
      break;
    }

    await tryLoadMoreAndScroll();
    if (hitFullPageExisting) {
      console.log("→ Hit full page of existing discussions after scroll (stable zone). Stopping.");
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

  // Combine new + to-rescrape discussions for scraping
  const newArray = Array.from(collected.values());
  const rescrapeArray = Array.from(toRescrape.values());
  const allToScrape = [...newArray, ...rescrapeArray];
  const rescrapeUrls = new Set(toRescrape.keys());

  if (rescrapeArray.length > 0) {
    console.log(`🔄 Will re-scrape ${rescrapeArray.length} existing discussion(s) with new activity`);
  }

  // Open each discussion and collect full details
  // Save incrementally after each discussion to avoid data loss
  const allDetails: DiscussionDetail[] = [];
  for (let i = 0; i < allToScrape.length; i++) {
    const d = allToScrape[i];
    const isRescrape = rescrapeUrls.has(d.url);
    console.log(`🧩 [${i + 1}/${allToScrape.length}] ${isRescrape ? '🔄 Re-scraping' : 'Opening'} discussion: ${d.title}`);
    // Random delay between requests (1-4 seconds)
    await delay(Math.random() * 3000 + 1000);
    try {
      const fullDetail = await scrapeDiscussionDetail(page, d.url);
      fullDetail.views = d.views;
      fullDetail.likes = d.likes;
      allDetails.push(fullDetail);

      // Save progress incrementally after each discussion
      if (outputFilename) {
        // Remove old versions of re-scraped discussions from existing
        const scrapedSoFar = new Set(allDetails.map(dd => dd.url));
        const remainingExisting = existingDiscussions.filter(dd => !scrapedSoFar.has(dd.url));
        const merged = [...allDetails, ...remainingExisting];
        fs.writeFileSync(outputFilename, JSON.stringify(merged, null, 2));
        console.log(`💾 Saved progress: ${allDetails.length} scraped + ${remainingExisting.length} existing = ${merged.length} total`);
      }
    } catch (err) {
      console.error(`❌ Failed to scrape ${d.url}:`, err);
      // Longer delay on error to avoid being flagged
      await delay(5000);
    }
  }
  return allDetails;
}

async function launchBrowser(proxyConfig?: ProxyConfig) {
  if (proxyConfig) {
    console.log(`🌐 Using proxy: ${proxyConfig.server}`);
  } else {
    console.log(`🌐 No proxy — connecting directly`);
  }
  const browser = await chromium.launch({
    headless: false,
    proxy: proxyConfig,
  });
  const context = await browser.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, page };
}

(async () => {
  const proxyList = buildProxyList();
  let proxyIndex = 0;
  console.log(`📋 Loaded ${proxyList.length} proxy/proxies from env/file`);

  let { browser, page } = await launchBrowser(proxyList[proxyIndex]);

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

  // Login check — rotate proxy if connection fails
  {
    let loginDone = false;
    let loginAttempts = 0;
    while (!loginDone) {
      try {
        await page.goto(targetUrls[0], { waitUntil: "domcontentloaded" });
        const needsLogin = await page.isVisible('text="Sign In"');
        if (needsLogin && !process.env.SKIP_LOGIN) {
          console.log("➡️ Please click 'Sign In' and complete login manually, then press Resume.");
          console.log("   (Set SKIP_LOGIN=1 to skip this prompt and scrape without logging in)");
          await page.pause();
        } else if (needsLogin) {
          console.log("⚠️ Sign In detected but SKIP_LOGIN is set — continuing without login.");
        }
        loginDone = true;
      } catch (err) {
        loginAttempts++;
        if (isProxyError(err) && proxyList.length > 1 && loginAttempts < proxyList.length) {
          console.error(`❌ Proxy ${proxyList[proxyIndex]?.server} failed. Rotating to next proxy...`);
          await browser.close();
          proxyIndex = (proxyIndex + 1) % proxyList.length;
          ({ browser, page } = await launchBrowser(proxyList[proxyIndex]));
        } else {
          throw err;
        }
      }
    }
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

    // Extract topic path from URL for filename
    const topicPathMatch = targetUrl.match(/\/discussions\/([^\/]+)/);
    if (!topicPathMatch) {
      console.error("❌ Invalid target URL format. Skipping...");
      continue;
    }

    const topicPath = topicPathMatch[1];
    console.log(`📂 Topic path identified: ${topicPath}`);
    const outputFilename = `${OUTPUT_DIR}/${topicPath.replace(/\//g, "_")}_full.json`;
    console.log(`💾 Output filename: ${outputFilename}`);

    // Load existing data for incremental scraping
    const existingDiscussions = loadExistingDiscussions(outputFilename);
    const existingUrls = new Set(existingDiscussions.map(d => d.url));
    console.log(`📂 Found ${existingDiscussions.length} existing discussions in ${outputFilename}`);

    // Scrape with automatic proxy rotation on connection failure
    const maxProxyAttempts = Math.min(proxyList.length || 1, 5);
    let proxyAttemptsForUrl = 0;

    while (proxyAttemptsForUrl < maxProxyAttempts) {
      try {
        console.log("🔍 Scraping new + updated discussions (incremental mode with auto-save)...");
        const scrapedDiscussions = await scrapeDiscussionList(page, targetUrl, existingUrls, existingDiscussions, outputFilename);
        console.log(`🆕 Completed ${scrapedDiscussions.length} scraped discussion(s)`);

        // Final merge: replace old versions of re-scraped discussions with fresh ones
        const scrapedUrls = new Set(scrapedDiscussions.map(d => d.url));
        const remainingExisting = existingDiscussions.filter(d => !scrapedUrls.has(d.url));
        const mergedDiscussions = [...scrapedDiscussions, ...remainingExisting];
        fs.writeFileSync(outputFilename, JSON.stringify(mergedDiscussions, null, 2));
        console.log(`✅ Final save: ${mergedDiscussions.length} total discussion(s) to ${outputFilename}`);

        // Update metadata
        metadata[topicPath] = {
          lastScrapedAt: new Date().toISOString(),
          totalDiscussions: mergedDiscussions.length,
        };
        writeMetadata(metadata);
        console.log(`📊 Updated metadata for ${topicPath}`);

        break; // success — exit the proxy-retry loop

      } catch (err) {
        proxyAttemptsForUrl++;
        const canRotate = isProxyError(err) && proxyList.length > 1 && proxyAttemptsForUrl < maxProxyAttempts;

        if (canRotate) {
          console.error(`❌ Proxy ${proxyList[proxyIndex]?.server} failed on ${targetUrl}. Rotating (attempt ${proxyAttemptsForUrl}/${maxProxyAttempts})...`);
          await browser.close();
          proxyIndex = (proxyIndex + 1) % proxyList.length;
          ({ browser, page } = await launchBrowser(proxyList[proxyIndex]));
          await delay(2000);
        } else {
          console.error(`❌ Error processing ${targetUrl}:`, err);
          if (isProxyError(err)) {
            console.log(`⏩ Exhausted ${proxyAttemptsForUrl} proxy attempt(s). Skipping URL.`);
          } else {
            console.log("⏩ Continuing to next URL...");
          }
          await delay(5000);
          break;
        }
      }
    }

    // Delay between URLs to avoid rate limiting (except last)
    if (i < targetUrls.length - 1) {
      const delaySeconds = Math.random() * 3 + 2;
      console.log(`⏳ Waiting ${delaySeconds.toFixed(1)}s before next URL...`);
      await delay(delaySeconds * 1000);
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
