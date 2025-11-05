# Jobber Community Scraper (Playwright + TypeScript)

Scrapes Jobber Community category "All topics" pages and exports full discussions (main post + all replies) to a single JSON file.

- Handles pagination across listing pages.
- Expands "Show more" / "Read more" / "Load more replies" to capture full text.
- Supports HTTP/HTTPS proxies (with or without auth).
- Includes anti-detection tweaks (UA rotation, random delays).

## Prerequisites
- Node.js >= 18
- Git (optional, for cloning/pushing)

## Install
```bash
npm i
```

## Run (no proxy)
```bash
npx ts-node scrape.ts
```
The script will open a browser. If you see "Sign In", complete login manually then press Resume in the Playwright inspector. Output is saved to:
- `online_booking_full.json`

## Run with proxy
Two options:

- Environment variable (recommended)
```bash
# .env
PROXY_URL=http://username:password@proxy.host:port

# run
npx ts-node scrape.ts
```

- Command line
```bash
npx ts-node scrape.ts --proxy=http://username:password@proxy.host:port
```

Supported formats:
- `http://proxy:port`
- `http://user:pass@proxy:port`
- `https://proxy:port`

## What gets exported
- title, url, author, time
- content (full text, multi-paragraph)
- views, likes, comments
- replies: [{ author, time, content, likes }]

## Changing the category URL
Edit `scrape.ts`, update `targetUrl` to any Jobber Community "All topics" listing URL.

## Notes
- If a thread is very long, the scraper repeatedly scrolls and clicks any visible "Show more" to reveal hidden parts before extraction.
- Random delays are added between page visits to reduce the chance of being blocked.

## Troubleshooting
- If the number of exported items is less than the page's "Posts" count, run again; you may have been rate-limited. Also consider using a proxy.
- If sign-in is required frequently, keep the browser open and finish multiple runs in the same session.

## License
MIT
