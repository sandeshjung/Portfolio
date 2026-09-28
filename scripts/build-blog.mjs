#!/usr/bin/env node
/**
 * build-blog.mjs — mirror Medium posts into static pages on this site.
 *
 *   node scripts/build-blog.mjs                 # fetch the live Medium feed
 *   node scripts/build-blog.mjs --feed feed.xml # build from a saved feed
 *
 * Writes:
 *   blog/posts.json          — every post seen so far (Medium's feed only
 *                              carries the latest 10, so posts are merged
 *                              here and never dropped)
 *   blog/index.html          — the blog index
 *   blog/<slug>/index.html   — one readable page per post
 *   index.html               — the "Writing" list between the blog:latest markers
 *   sitemap.xml              — home + blog URLs
 *
 * No dependencies; needs Node 18+ (global fetch).
 */

import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOG_DIR = join(ROOT, 'blog');
const STORE = join(BLOG_DIR, 'posts.json');

const SITE = 'https://sandeshjung.com.np';
const MEDIUM_USER = 'sandeshjung';
const FEED_URL = `https://medium.com/feed/@${MEDIUM_USER}`;
const AUTHOR = 'Sandesh Jung Kunwar';
const HOME_LATEST = 6;

const TAG_LABELS = {
  'ai': 'AI',
  'artificial-intelligence': 'AI',
  'ai-agent': 'AI Agents',
  'llm': 'LLMs',
  'gdpr': 'GDPR',
  'chatgpt': 'ChatGPT',
  'chatbots': 'Chatbots',
  'generative-ai-tools': 'Generative AI',
  'machine-learning': 'Machine Learning',
  'javascript': 'JavaScript',
  'functions-in-javascript': 'JavaScript',
  'hoisting-in-javascript': 'JavaScript',
  'rag': 'RAG',
};



/**
 * helpers
 */

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const decode = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&amp;/g, '&');

const stripTags = (html) => decode(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

const pad = (n) => String(n).padStart(2, '0');

const fmtMonth = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

const tagLabels = (categories) => {
  const labels = categories.map((c) => TAG_LABELS[c] ?? c.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '));
  // the generic "AI" label says little on an AI engineer's blog — list it last
  return [...new Set(labels)].sort((a, b) => (a === 'AI') - (b === 'AI'));
};

const truncate = (text, max) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s—-]+$/, '') + '…';
};



/**
 * feed parsing
 */

const field = (xml, tag) => {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
  return m ? m[1].trim() : '';
};

function parseFeed(xml) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);

  return items.map((item) => {
    const link = decode(field(item, 'link')).split('?')[0];
    const guid = field(item, 'guid');
    const categories = [...item.matchAll(/<category><!\[CDATA\[([^\]]*)\]\]><\/category>/g)].map((m) => m[1]);
    let title = decode(field(item, 'title'));
    let raw = field(item, 'content:encoded');

    // Medium sometimes opens the body with the full headline as an <h3>, and
    // truncates the RSS <title>; use the full one and drop the duplicate.
    const lead = raw.match(/^\s*<h[34]>([\s\S]*?)<\/h[34]>/);
    if (lead && norm(stripTags(lead[1])).startsWith(norm(title))) {
      title = stripTags(lead[1]);
      raw = raw.slice(lead[0].length);
    }

    const content = sanitize(raw);
    const text = stripTags(content);
    const firstPara = stripTags((content.match(/<p>([\s\S]*?)<\/p>/) || ['', ''])[1]);
    const cover = (content.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
    const slug = link.split('/').pop().replace(/-[0-9a-f]{8,}$/, '');

    return {
      id: guid.split('/').pop(),
      slug,
      title,
      excerpt: truncate(firstPara || text, 200),
      url: link,
      published: new Date(field(item, 'pubDate')).toISOString(),
      updated: field(item, 'atom:updated') || new Date(field(item, 'pubDate')).toISOString(),
      categories,
      cover,
      readingMinutes: Math.max(1, Math.round(text.split(' ').length / 230)),
      content,
    };
  });
}



/**
 * sanitize Medium's HTML down to a small, known-safe subset
 */

const ALLOWED = {
  p: [], br: [], strong: [], em: [], a: ['href'], img: ['src', 'alt'],
  figure: [], figcaption: [], h3: [], h4: [], blockquote: [], pre: [], code: [],
  ul: [], ol: [], li: [], hr: [], sub: [], sup: [],
};
const RENAME = { b: 'strong', i: 'em', h3: 'h2', h4: 'h3' }; // page title is the h1
const VOID = new Set(['br', 'img', 'hr']);

function sanitize(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<iframe[^>]*src="([^"]*)"[^>]*>[\s\S]*?<\/iframe>/gi, (_, src) =>
      /^https:\/\//.test(decode(src))
        ? `<p class="post-embed"><a href="${esc(decode(src))}">View embedded content ↗</a></p>`
        : '')
    .replace(/<img[^>]*medium\.com\/_\/stat[^>]*>/gi, '') // Medium's tracking pixel
    .replace(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g, (_, close, rawTag, attrStr) => {
      const tag = rawTag.toLowerCase();
      const canonical = { b: 'strong', i: 'em' }[tag] ?? tag;
      if (!(canonical in ALLOWED)) return '';
      const out = RENAME[tag] ?? tag;
      if (close) return VOID.has(out) ? '' : `</${out}>`;

      const attrs = {};
      for (const [, name, value] of attrStr.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
        if (ALLOWED[canonical].includes(name.toLowerCase())) attrs[name.toLowerCase()] = decode(value);
      }

      let extra = '';
      if (out === 'a') {
        if (!/^(https?:|mailto:)/i.test(attrs.href || '')) delete attrs.href;
        else extra = ' target="_blank" rel="noopener noreferrer"';
      }
      if (out === 'img') {
        if (!/^https:\/\//i.test(attrs.src || '')) return '';
        attrs.alt ??= '';
        extra = ' loading="lazy" decoding="async"';
      }

      const attrOut = Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
      return `<${out}${attrOut}${extra}>`;
    });
}



/**
 * shared page chrome — mirrors index.html's header, icons and footer
 */

const SVG_SYMBOLS = `
  <svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
    <defs>
      <symbol id="mark" viewBox="0 0 32 32">
        <clipPath id="mark-clip">
          <circle cx="16" cy="16" r="14.4"/>
        </clipPath>
        <circle cx="16" cy="16" r="14.4" fill="none" stroke="currentColor" stroke-width="1.6"/>
        <path class="mark-tide" clip-path="url(#mark-clip)"
          d="M0 18.6C4.6 13.6 8.4 13.6 12.8 16.8 17.6 20.3 22 20.6 26.4 17.2 29 15.2 30.6 14 32 13.4V32H0Z"
          fill="currentColor"/>
      </symbol>
      <symbol id="arrow-up-right" viewBox="0 0 24 24">
        <path d="M7 17L17 7M17 7H7m10 0v10" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
      </symbol>
      <symbol id="arrow-right" viewBox="0 0 24 24">
        <path d="M5 12h14m0 0l-6-6m6 6l-6 6" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
      </symbol>
      <symbol id="arrow-left" viewBox="0 0 24 24">
        <path d="M19 12H5m0 0l6-6m-6 6l6 6" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
      </symbol>
      <symbol id="arrow-top" viewBox="0 0 24 24">
        <path d="M12 19V5m0 0l-6 6m6-6l6 6" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round"/>
      </symbol>
      <symbol id="close" viewBox="0 0 24 24">
        <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </symbol>
    </defs>
  </svg>`;

function page({ root, title, description, canonical, ogType, ogImage, jsonLd, body }) {
  return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">

  <!-- generated by scripts/build-blog.mjs — edit the script, not this file -->

  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="author" content="${AUTHOR}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <meta name="theme-color" content="#f3ede0">
  <link rel="canonical" href="${esc(canonical)}">

  <meta property="og:type" content="${ogType}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:site_name" content="${AUTHOR}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(title)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(ogImage)}">

  <link rel="icon" href="${root}favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="${root}assets/images/apple-touch-icon.png">
  <link rel="manifest" href="${root}site.webmanifest">
  <link rel="alternate" type="application/rss+xml" title="${AUTHOR} on Medium" href="${FEED_URL}">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="${root}assets/css/style.css">

  <script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2).replace(/</g, '\\u003c').replace(/^/gm, '  ')}
  </script>
</head>

<body id="top" class="blog-page">
${SVG_SYMBOLS}

  <header class="header" data-header>
    <div class="container">

      <a href="${root}" class="logo" aria-label="${AUTHOR} — home">
        <svg class="logo-mark" aria-hidden="true"><use href="#mark"></use></svg>
        <span class="logo-type">SJK</span>
      </a>

      <nav class="navbar" data-navbar>

        <div class="navbar-top">
          <a href="${root}" class="logo" aria-label="${AUTHOR} — home">
            <svg class="logo-mark" aria-hidden="true"><use href="#mark"></use></svg>
            <span class="logo-type">SJK</span>
          </a>

          <button class="nav-close-btn" aria-label="close menu" data-nav-toggler>
            <svg width="16" height="16" aria-hidden="true"><use href="#close"></use></svg>
          </button>
        </div>

        <ul class="navbar-list">
          <li><a href="${root}#home" class="navbar-link" data-nav-link>Index</a></li>
          <li><a href="${root}#about" class="navbar-link" data-nav-link>About</a></li>
          <li><a href="${root}#experience" class="navbar-link" data-nav-link>Experience</a></li>
          <li><a href="${root}#projects" class="navbar-link" data-nav-link>Projects</a></li>
          <li><a href="${root}blog/" class="navbar-link active" data-nav-link aria-current="page">Blog</a></li>
          <li><a href="${root}#contact" class="navbar-link" data-nav-link>Contact</a></li>
        </ul>

      </nav>

      <div class="header-actions">
        <a href="${root}Sandesh_Jung_Kunwar_Resume.pdf" class="btn btn-primary" target="_blank" rel="noopener noreferrer">
          <span>Résumé</span>
          <svg class="btn-icon" aria-hidden="true"><use href="#arrow-up-right"></use></svg>
        </a>

        <button class="nav-open-btn" aria-label="open menu" data-nav-toggler>
          <span class="line"></span>
        </button>
      </div>

      <div class="overlay" data-overlay data-nav-toggler></div>

    </div>
  </header>


  <main>
${body}
  </main>


  <footer class="footer">
    <div class="container">

      <span class="footer-mark">
        <svg class="logo-mark" aria-hidden="true"><use href="#mark"></use></svg>
        © ${new Date().getUTCFullYear()} ${AUTHOR}
      </span>

      <a href="#top" class="back-top-btn">
        <span>Back to top</span>
        <svg class="btn-icon" aria-hidden="true"><use href="#arrow-top"></use></svg>
      </a>

    </div>
  </footer>

  <script src="${root}assets/js/script.js"></script>

</body>

</html>
`;
}



/**
 * blog index
 */

function writingItem(post, i, href) {
  return `
            <a class="writing-item" href="${href}">
              <span class="writing-no">${pad(i + 1)}</span>
              <div class="writing-body">
                <h3 class="writing-title">${esc(post.title)}</h3>
                <p class="writing-tag">${esc(tagLabels(post.categories).slice(0, 2).join(' · '))}</p>
              </div>
              <span class="writing-date">${fmtMonth(post.published)}</span>
              <svg class="writing-arrow" aria-hidden="true"><use href="#arrow-right"></use></svg>
            </a>
`;
}

function renderIndex(posts) {
  const items = posts.map((post, i) => `
            <a class="blog-item" href="./${post.slug}/">
              <span class="writing-no">${pad(posts.length - i)}</span>
              <div class="blog-item-body">
                <p class="blog-item-meta">
                  <time datetime="${post.published}">${fmtDay(post.published)}</time>
                  <span aria-hidden="true">·</span>
                  <span>${post.readingMinutes} min read</span>
                </p>
                <h2 class="blog-item-title">${esc(post.title)}</h2>
                <p class="blog-item-excerpt">${esc(post.excerpt)}</p>
                <p class="writing-tag">${esc(tagLabels(post.categories).join(' · '))}</p>
              </div>
              <svg class="writing-arrow" aria-hidden="true"><use href="#arrow-right"></use></svg>
            </a>
`).join('');

  const body = `
    <section class="section blog-hero" aria-labelledby="blog-title">
      <div class="container">

        <span class="eyebrow">Field Notes — ${posts.length} ${posts.length === 1 ? 'entry' : 'entries'}</span>

        <div class="section-head blog-head">
          <h1 class="section-title blog-title" id="blog-title">Writing <em>&amp; Notes</em></h1>
          <p class="blog-intro">Essays and walkthroughs on LLMs, retrieval, AI agents and the engineering around them. Also published on <a href="https://medium.com/@${MEDIUM_USER}" target="_blank" rel="noopener noreferrer">Medium</a>.</p>
        </div>

        <div class="blog-list">
${items}
        </div>

      </div>
    </section>
`;

  return page({
    root: '../',
    title: `Writing & Notes | ${AUTHOR}`,
    description: `Essays and walkthroughs by ${AUTHOR}, AI/ML engineer, on LLMs, RAG, AI agents and production ML systems.`,
    canonical: `${SITE}/blog/`,
    ogType: 'website',
    ogImage: `${SITE}/assets/images/og-image.jpg`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: `Writing & Notes — ${AUTHOR}`,
      url: `${SITE}/blog/`,
      author: { '@id': `${SITE}/#person` },
      blogPost: posts.map((p) => ({
        '@type': 'BlogPosting',
        headline: p.title,
        url: `${SITE}/blog/${p.slug}/`,
        datePublished: p.published,
      })),
    },
    body,
  });
}



/**
 * single post
 */

function renderPost(post, newer, older) {
  const tags = tagLabels(post.categories);
  const neighbour = (p, dir) => p ? `
          <a class="post-nav-link post-nav-${dir}" href="../${p.slug}/">
            <span class="post-nav-label">
              ${dir === 'prev' ? '<svg class="btn-icon" aria-hidden="true"><use href="#arrow-left"></use></svg> Newer' : 'Older <svg class="btn-icon" aria-hidden="true"><use href="#arrow-right"></use></svg>'}
            </span>
            <span class="post-nav-title">${esc(p.title)}</span>
          </a>` : '<span></span>';

  const body = `
    <article class="post" aria-labelledby="post-title">
      <div class="container">

        <a href="../" class="post-back">
          <svg class="btn-icon" aria-hidden="true"><use href="#arrow-left"></use></svg>
          <span>All writing</span>
        </a>

        <header class="post-header">
          <p class="post-meta">
            <time datetime="${post.published}">${fmtDay(post.published)}</time>
            <span aria-hidden="true">·</span>
            <span>${post.readingMinutes} min read</span>
          </p>
          <h1 class="post-title" id="post-title">${esc(post.title)}</h1>
          <p class="writing-tag">${esc(tags.join(' · '))}</p>
        </header>

        <div class="post-body">
${post.content}
        </div>

        <aside class="post-origin">
          <p>Originally published on Medium. Claps, highlights and responses live there.</p>
          <a href="${esc(post.url)}" class="btn btn-ghost" target="_blank" rel="noopener noreferrer">
            <span>Read on Medium</span>
            <svg class="btn-icon" aria-hidden="true"><use href="#arrow-up-right"></use></svg>
          </a>
        </aside>

        <nav class="post-nav" aria-label="More writing">
${neighbour(newer, 'prev')}
${neighbour(older, 'next')}
        </nav>

      </div>
    </article>
`;

  return page({
    root: '../../',
    title: `${post.title} | ${AUTHOR}`,
    description: post.excerpt,
    // Medium is where these were first published; pointing canonical there
    // avoids a duplicate-content split between the two copies.
    canonical: post.url,
    ogType: 'article',
    ogImage: post.cover || `${SITE}/assets/images/og-image.jpg`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.excerpt,
      datePublished: post.published,
      dateModified: post.updated,
      url: `${SITE}/blog/${post.slug}/`,
      mainEntityOfPage: post.url,
      image: post.cover || undefined,
      keywords: tags.join(', '),
      author: { '@type': 'Person', '@id': `${SITE}/#person`, name: AUTHOR, url: `${SITE}/` },
    },
    body,
  });
}



/**
 * home page + sitemap
 */

async function updateHome(posts) {
  const file = join(ROOT, 'index.html');
  const html = await readFile(file, 'utf8');
  const re = /(<!-- blog:latest:start[^>]*-->)[\s\S]*?(<!-- blog:latest:end -->)/;
  if (!re.test(html)) {
    console.warn('index.html: blog:latest markers not found — skipping home update');
    return;
  }
  const items = posts.slice(0, HOME_LATEST).map((p, i) => writingItem(p, i, `./blog/${p.slug}/`)).join('');
  await writeFile(file, html.replace(re, (_, start, end) => `${start}\n${items}\n            ${end}`));
}

async function writeSitemap(posts) {
  const url = (loc, lastmod, freq, priority) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${lastmod.slice(0, 10)}</lastmod>
    <changefreq>${freq}</changefreq>
    <priority>${priority}</priority>
  </url>`;

  const newest = posts[0]?.updated ?? new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${url(`${SITE}/`, newest, 'monthly', '1.0')}
${url(`${SITE}/blog/`, newest, 'weekly', '0.8')}
</urlset>
`;
  // Post pages canonicalise to Medium, so they are intentionally left out.
  await writeFile(join(ROOT, 'sitemap.xml'), xml);
}



/**
 * main
 */

async function main() {
  const feedArg = process.argv.indexOf('--feed');
  let xml;
  if (feedArg > -1) {
    xml = await readFile(process.argv[feedArg + 1], 'utf8');
  } else {
    const res = await fetch(FEED_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (portfolio blog sync)' } });
    if (!res.ok) throw new Error(`Medium feed returned ${res.status}`);
    xml = await res.text();
  }

  const fresh = parseFeed(xml);
  if (!fresh.length) throw new Error('No <item>s in the feed — refusing to overwrite the blog');

  const stored = existsSync(STORE) ? JSON.parse(await readFile(STORE, 'utf8')) : [];
  const byId = new Map(stored.map((p) => [p.id, p]));
  for (const p of fresh) byId.set(p.id, p);
  const posts = [...byId.values()].sort((a, b) => b.published.localeCompare(a.published));

  await mkdir(BLOG_DIR, { recursive: true });
  await writeFile(STORE, JSON.stringify(posts, null, 2) + '\n');
  await writeFile(join(BLOG_DIR, 'index.html'), renderIndex(posts));

  // clear post folders that no longer map to a post (e.g. a renamed slug)
  const slugs = new Set(posts.map((p) => p.slug));
  for (const entry of await readdir(BLOG_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !slugs.has(entry.name)) await rm(join(BLOG_DIR, entry.name), { recursive: true });
  }

  for (const [i, post] of posts.entries()) {
    const dir = join(BLOG_DIR, post.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'index.html'), renderPost(post, posts[i - 1], posts[i + 1]));
  }

  await updateHome(posts);
  await writeSitemap(posts);

  console.log(`Built ${posts.length} posts (${fresh.length} from feed).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
