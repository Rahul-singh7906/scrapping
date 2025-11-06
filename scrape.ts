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

// ✅ Scrape replies and main content from an open discussion page
async function scrapeDiscussionDetail(page: Page, url: string): Promise<DiscussionDetail> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // Random delay to avoid pattern detection
  await delay(Math.random() * 2000 + 1000);
  await page.waitForSelector("article, [data-testid='MessageSubject']", { timeout: 15000 });

  // Aggressively click all Show More / Read More / Load More controls across the thread
  async function expandAllContent() {
    for (let round = 0; round < 50; round++) {
      let clickedAny = false;
      const selectors = [
        // explicit labels (case-insensitive)
        "button:has-text('Show More')",
        "button:has-text('Show more')",
        "a:has-text('Show More')",
        "a:has-text('Show more')",
        "button:has-text('Read More')",
        "button:has-text('Read more')",
        "a:has-text('Read More')",
        "a:has-text('Read more')",
        "button:has-text('Load more replies')",
        "a:has-text('Load more replies')",
        // generic data-testids
        "[data-testid*='show-more']",
        "[data-testid*='load-more']",
        // aria/collapsible toggles that mention more
        "[aria-expanded='false']:has-text('Show More')",
        "[aria-expanded='false']:has-text('Show more')",
        "[aria-expanded='false']:has-text('more')",
      ];
      for (const sel of selectors) {
        const loc = page.locator(sel);
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false)) {
            await el.click({ timeout: 500 }).catch(() => {});
            clickedAny = true;
            await delay(150);
          }
        }
      }
      // small scroll to reveal more toggles
      await page.mouse.wheel(0, 1200);
      await delay(200);
      if (!clickedAny) break;
    }
  }
  await expandAllContent();

  // Scroll to load all replies
  await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      window.scrollBy(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
  // Try expanding again after scrolling (new toggles may appear)
  await expandAllContent();

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
    "article",
    "li[data-testid^='message']", 
    "[data-testid='message-view']",
    ".lia-message-view",
    "[class*='message']"
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
            const author = (el.querySelector("a[data-testid='userLink']") as HTMLElement | null)?.textContent?.trim() || "";
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
        time: r.time,
        content: cleaned,
        likes: r.likes,
      };
    })
    // drop empties
    .filter(r => (r.author && r.author.trim().length > 0) || (r.content && r.content.trim().length > 0));
  
  console.log(`→ After cleanup: ${replies.length} valid replies`);

  // If the page shows a Replies count, align to it
  const limitedReplies = (typeof expectedReplies === 'number' && expectedReplies >= 0)
    ? replies.slice(0, expectedReplies)
    : replies;

  // Grab counters if visible
  const viewCount = await page.locator("svg use[href*='views']").evaluateAll(
    (nodes) => nodes.length
  ).catch(() => 0);

  return {
    title: title?.trim() || "",
    url,
    author: author || "",
    authorRole: normalizeWhitespace(mainRole || ''),
    time: mainTime?.trim() || "",
    content: mainContent?.trim() || "",
    views: viewCount || 0,
    likes: 0,
    comments: limitedReplies.length,
    replies: limitedReplies,
  };
}

// ✅ Scrape the list of discussions across ALL pages (pagination + load more + infinite scroll)
async function scrapeDiscussionList(page: Page, topicUrl: string): Promise<DiscussionDetail[]> {
  const collected = new Map<string, { title: string; url: string; author: string; time: string; views: number; likes: number; comments: number }>();
  const visitedPages = new Set<string>();

  async function collectFromCurrentPage() {
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
    for (const s of summaries) {
      if (s.url && !collected.has(s.url)) collected.set(s.url, s);
    }
    console.log(`→ Collected ${collected.size} discussion(s) so far`);
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
    }
    // Infinite scroll until height stops growing
    for (let i = 0; i < 20; i++) {
      const prev = await page.evaluate(() => document.body.scrollHeight);
      await page.mouse.wheel(0, 2000);
      await delay(500);
      const next = await page.evaluate(() => document.body.scrollHeight);
      await collectFromCurrentPage();
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
    await collectFromCurrentPage();
    await tryLoadMoreAndScroll();

    // Find explicit Next link
    const nextHref = await page
      .locator(".pagination a[rel='next'], a[aria-label='Next Page'], a[aria-label='Next'], a:has-text('Next')")
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (nextHref) {
      current = new URL(nextHref, current).toString();
    } else {
      current = null;
    }
  }

  // Open each discussion and collect full details
  const allDetails: DiscussionDetail[] = [];
  for (const d of collected.values()) {
    console.log(`🧩 Opening discussion: ${d.title}`);
    // Random delay between requests (1-4 seconds)
    await delay(Math.random() * 3000 + 1000);
    try {
      const fullDetail = await scrapeDiscussionDetail(page, d.url);
      fullDetail.views = d.views;
      fullDetail.likes = d.likes;
      allDetails.push(fullDetail);
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

  const targetUrl =
    "https://community.getjobber.com/category/using-jobber/discussions/online-booking-requests/all-topics";

  await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

  if (await page.isVisible('text="Sign In"')) {
    console.log("➡️ Please click 'Sign In' and complete login manually, then press Resume.");
    await page.pause();
  }

  console.log(`🤖 Using User-Agent: ${await page.evaluate(() => navigator.userAgent)}`);
  console.log("🔍 Scraping topic discussions (with pagination) and full replies...");
  const allData = await scrapeDiscussionList(page, targetUrl);

  fs.writeFileSync("online_booking_full.json", JSON.stringify(allData, null, 2));
  console.log(`✅ Saved ${allData.length} discussions to online_booking_full.json`);

  await browser.close();
})();
