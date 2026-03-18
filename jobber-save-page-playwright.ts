import { chromium, Browser, Page } from 'playwright';
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type ProxyConfig = {
  server: string;
  username: string;
  password: string;
};

type RunnerConfig = {
  maxProxyAttempts: number;
  minExpectedTextLength: number;
  runDirectAttemptAfterProxies: boolean;
  consecutiveChallengeThreshold: number;
  manualMode: boolean;
  debugDir: string;
};

const articleListPath = 'jobber-helper-articles.txt';
const outputDir = 'jobber-helper-pdfs';
const proxyFilePath = 'web-proxies.txt';

async function loadProxies(filePath: string): Promise<ProxyConfig[]> {
  const content = await readFile(filePath, 'utf-8');

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [host, port, username, password] = line.split(':');

      if (!host || !port || !username || !password) {
        throw new Error(`Invalid proxy format: ${line}`);
      }

      return {
        server: `http://${host}:${port}`,
        username,
        password,
      };
    });
}

async function loadArticleUrls(filePath: string): Promise<string[]> {
  const content = await readFile(filePath, 'utf-8');

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function shuffleArray<T>(items: T[]): T[] {
  const copy = [...items];

  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }

  return copy;
}

async function getPageHealth(page: Page): Promise<{
  title: string;
  textLength: number;
  htmlSnippet: string;
}> {
  return page.evaluate(() => ({
    title: document.title,
    textLength: (document.body?.innerText ?? '').trim().length,
    htmlSnippet: document.documentElement?.outerHTML?.slice(0, 4000) ?? '',
  }));
}

function isChallengePage(title: string, htmlSnippet: string): boolean {
  const titleLower = title.toLowerCase();
  const htmlLower = htmlSnippet.toLowerCase();

  return (
    titleLower.includes('just a moment') ||
    htmlLower.includes('cloudflare') ||
    htmlLower.includes('cf-turnstile') ||
    htmlLower.includes('performing security verification')
  );
}

async function clearDebugDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
  const entries = await readdir(dirPath);

  await Promise.all(entries.map((entry) => unlink(`${dirPath}/${entry}`)));
}

function buildArticleSlug(url: string, fallbackIndex: number): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter((segment) => segment.length > 0);
    const lastSegment = segments[segments.length - 1] ?? `article-${fallbackIndex + 1}`;

    const withoutNumericPrefix = lastSegment.replace(/^\d+-/, '');
    const normalized = withoutNumericPrefix
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    return normalized || `article-${fallbackIndex + 1}`;
  } catch {
    return `article-${fallbackIndex + 1}`;
  }
}

function buildOutputPdfPath(url: string, index: number): string {
  const slug = buildArticleSlug(url, index);
  return `${outputDir}/${slug}.pdf`;
}

async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    await rl.question(`${message}\nPress Enter to continue... `);
  } finally {
    rl.close();
  }
}

async function runManualVerificationAttempt(
  page: Page,
  url: string,
  outputPath: string,
  minExpectedTextLength: number,
): Promise<void> {
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
    console.log('Manual mode network idle wait timed out, continuing...');
  });

  await page.waitForTimeout(2000);

  let health = await getPageHealth(page);
  console.log(`Manual mode page title: ${health.title || '[empty]'}`);
  console.log(`Manual mode text length: ${health.textLength}`);

  if (isChallengePage(health.title, health.htmlSnippet)) {
    await waitForEnter(
      'Complete verification in the opened browser and wait for the article to load.',
    );

    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
      console.log('Manual mode post-verification network idle wait timed out, continuing...');
    });

    await page.waitForTimeout(2000);
    health = await getPageHealth(page);
    console.log(`Manual mode page title after verification: ${health.title || '[empty]'}`);
    console.log(`Manual mode text length after verification: ${health.textLength}`);
  }

  if (isChallengePage(health.title, health.htmlSnippet)) {
    throw new Error('Still on security challenge page after manual step.');
  }

  if (health.textLength < minExpectedTextLength) {
    throw new Error(
      `Manual mode page content too small (${health.textLength} chars). Open the article page fully before continuing.`,
    );
  }

  await page.emulateMedia({ media: 'screen' });
  await page.pdf({
    path: outputPath,
    format: 'A4',
    printBackground: true,
    margin: {
      top: '20mm',
      right: '10mm',
      bottom: '20mm',
      left: '10mm',
    },
  });

  console.log(`Saved PDF to ${outputPath} (manual mode)`);
}

async function saveSinglePageAsPDF(
  url: string,
  outputPath: string,
  proxies: ProxyConfig[],
  config: RunnerConfig,
  debugPrefix: string,
): Promise<void> {
  const {
    maxProxyAttempts,
    minExpectedTextLength,
    runDirectAttemptAfterProxies,
    consecutiveChallengeThreshold,
    manualMode,
    debugDir,
  } = config;

  console.log('----------------------------------------');
  console.log(`Target URL: ${url}`);
  console.log(`Output file: ${outputPath}`);

  if (proxies.length === 0) {
    throw new Error('No proxies loaded.');
  }

  const shuffledProxies = shuffleArray(proxies);
  const attempts = Math.min(maxProxyAttempts, shuffledProxies.length);

  console.log(`Trying up to ${attempts} proxy attempts...`);

  let lastError: unknown = null;
  let consecutiveChallengeFailures = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const selectedProxy = shuffledProxies[attempt];
    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
      console.log(`Attempt ${attempt + 1}/${attempts} using proxy: ${selectedProxy.server}`);

      browser = await chromium.launch({
        headless: true,
        proxy: {
          server: selectedProxy.server,
          username: selectedProxy.username,
          password: selectedProxy.password,
        },
      });

      page = await browser.newPage({
        viewport: { width: 1440, height: 2200 },
      });

      console.log('Navigating to page...');
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });

      const status = response?.status() ?? 0;
      console.log(`HTTP status: ${status || 'unknown'}`);

      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
        console.log('Network idle wait timed out, continuing...');
      });

      console.log('Waiting 3 seconds for late-loading content...');
      await page.waitForTimeout(3000);

      const health = await getPageHealth(page);
      console.log(`Page title: ${health.title || '[empty]'}`);
      console.log(`Page text length: ${health.textLength}`);

      if (status === 403 || isChallengePage(health.title, health.htmlSnippet)) {
        consecutiveChallengeFailures += 1;
        throw new Error('Blocked by security challenge (Cloudflare/403) for this proxy.');
      }

      consecutiveChallengeFailures = 0;

      if (health.textLength < minExpectedTextLength) {
        throw new Error(
          `Page content too small (${health.textLength} chars). Likely blocked/empty response via proxy.`,
        );
      }

      await page.emulateMedia({ media: 'screen' });

      console.log('Generating PDF...');
      await page.pdf({
        path: outputPath,
        format: 'A4',
        printBackground: true,
        margin: {
          top: '20mm',
          right: '10mm',
          bottom: '20mm',
          left: '10mm',
        },
      });

      console.log(`Saved PDF to ${outputPath}`);
      return;
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt + 1} failed:`, error);

      if (
        error instanceof Error &&
        error.message.includes('Blocked by security challenge') &&
        consecutiveChallengeFailures >= consecutiveChallengeThreshold
      ) {
        console.log(
          `Detected ${consecutiveChallengeFailures} consecutive challenge pages. ` +
            'Stopping proxy attempts early and switching to direct attempt.',
        );
        break;
      }

      if (page && !page.isClosed()) {
        const screenshotPath = `${debugDir}/${debugPrefix}-attempt-${attempt + 1}.png`;
        const htmlPath = `${debugDir}/${debugPrefix}-attempt-${attempt + 1}.html`;

        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          await writeFile(htmlPath, await page.content(), 'utf-8');
          console.log(`Saved debug screenshot: ${screenshotPath}`);
          console.log(`Saved debug HTML: ${htmlPath}`);
        } catch (debugError) {
          console.error('Failed to save debug artifacts:', debugError);
        }
      }
    } finally {
      if (browser) {
        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed.');
      }
    }
  }

  if (runDirectAttemptAfterProxies) {
    console.log('All proxy attempts failed. Trying one direct (no-proxy) attempt...');

    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1440, height: 2200 } });

      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });

      const status = response?.status() ?? 0;
      console.log(`Direct attempt HTTP status: ${status || 'unknown'}`);

      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
        console.log('Direct attempt network idle wait timed out, continuing...');
      });

      await page.waitForTimeout(3000);

      const health = await getPageHealth(page);
      console.log(`Direct attempt page title: ${health.title || '[empty]'}`);
      console.log(`Direct attempt text length: ${health.textLength}`);

      if (status === 403 || isChallengePage(health.title, health.htmlSnippet)) {
        throw new Error('Direct attempt also blocked by security challenge.');
      }

      if (health.textLength < minExpectedTextLength) {
        throw new Error(`Direct attempt content too small (${health.textLength} chars).`);
      }

      await page.emulateMedia({ media: 'screen' });
      await page.pdf({
        path: outputPath,
        format: 'A4',
        printBackground: true,
        margin: {
          top: '20mm',
          right: '10mm',
          bottom: '20mm',
          left: '10mm',
        },
      });

      console.log(`Saved PDF to ${outputPath} (direct attempt)`);
      return;
    } catch (error) {
      lastError = error;
      console.error('Direct attempt failed:', error);

      if (page && !page.isClosed()) {
        const screenshotPath = `${debugDir}/${debugPrefix}-attempt-direct.png`;
        const htmlPath = `${debugDir}/${debugPrefix}-attempt-direct.html`;

        try {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          await writeFile(htmlPath, await page.content(), 'utf-8');
          console.log(`Saved debug screenshot: ${screenshotPath}`);
          console.log(`Saved debug HTML: ${htmlPath}`);
        } catch (debugError) {
          console.error('Failed to save direct-attempt debug artifacts:', debugError);
        }
      }
    } finally {
      if (browser) {
        console.log('Closing browser...');
        await browser.close();
        console.log('Browser closed.');
      }
    }
  }

  throw new Error(
    `All proxy/direct attempts failed for ${url}. Last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function savePageAsPDF(): Promise<void> {
  const debugDir = 'pdf-debug';
  const config: RunnerConfig = {
    maxProxyAttempts: 10,
    minExpectedTextLength: 500,
    runDirectAttemptAfterProxies: true,
    consecutiveChallengeThreshold: 3,
    manualMode:
      process.argv.includes('--manual') ||
      process.argv.includes('--headed') ||
      process.env.MANUAL_VERIFY === '1',
    debugDir,
  };

  const manualMode =
    process.argv.includes('--manual') ||
    process.argv.includes('--headed') ||
    process.env.MANUAL_VERIFY === '1';

  try {
    console.log('Starting PDF batch job...');
    console.log(`Article list file: ${articleListPath}`);
    console.log(`Output folder: ${outputDir}`);
    console.log(`Proxy file: ${proxyFilePath}`);
    console.log(`Debug output dir: ${debugDir}`);
    console.log(`Manual mode: ${manualMode ? 'enabled' : 'disabled'}`);

    await mkdir(outputDir, { recursive: true });

    await clearDebugDirectory(debugDir);
    console.log('Cleared old debug artifacts.');

    const urls = await loadArticleUrls(articleListPath);
    if (urls.length === 0) {
      throw new Error('No article URLs found in jobber-helper-articles.txt');
    }

    console.log(`Loaded ${urls.length} article URL(s).`);

    let proxies: ProxyConfig[] = [];
    if (!manualMode) {
      console.log('Loading proxies...');
      proxies = await loadProxies(proxyFilePath);

      if (proxies.length === 0) {
        throw new Error('No proxies found in web-proxies.txt');
      }

      console.log(`Loaded ${proxies.length} proxies.`);
    }

    let successCount = 0;
    const failedUrls: string[] = [];

    let manualBrowser: Browser | null = null;
    let manualPage: Page | null = null;

    if (manualMode) {
      console.log('Starting manual verification mode (headed browser)...');
      manualBrowser = await chromium.launch({ headless: false, slowMo: 100 });
      manualPage = await manualBrowser.newPage({ viewport: { width: 1440, height: 2200 } });
      console.log('Manual browser session started and will be reused for all articles.');
    }

    try {
      for (let index = 0; index < urls.length; index += 1) {
        const url = urls[index];
        const pdfPath = buildOutputPdfPath(url, index);
        const debugPrefix = `${index + 1}-${buildArticleSlug(url, index)}`;

        console.log(`Processing ${index + 1}/${urls.length}...`);

        try {
          if (manualMode) {
            if (!manualPage) {
              throw new Error('Manual browser page is not available.');
            }

            await runManualVerificationAttempt(
              manualPage,
              url,
              pdfPath,
              config.minExpectedTextLength,
            );
          } else {
            await saveSinglePageAsPDF(url, pdfPath, proxies, config, debugPrefix);
          }

          successCount += 1;
        } catch (error) {
          failedUrls.push(url);
          console.error(`Failed for URL: ${url}`);
          console.error(error);
        }
      }
    } finally {
      if (manualBrowser) {
        console.log('Closing manual browser session...');
        await manualBrowser.close();
        console.log('Manual browser closed.');
      }
    }

    console.log('----------------------------------------');
    console.log(`Batch complete. Success: ${successCount}, Failed: ${failedUrls.length}`);

    if (failedUrls.length > 0) {
      console.log('Failed URLs:');
      for (const failedUrl of failedUrls) {
        console.log(`- ${failedUrl}`);
      }
    }

  } catch (error) {
    console.error('Failed to save page as PDF:', error);
  } finally {
    console.log('PDF batch job finished.');
  }
}

savePageAsPDF().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
