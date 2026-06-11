/**
 * Vivaldi Changelog Expander
 * Detects Vivaldi update forum posts (snapshots, stable, mobile) and injects
 * the full changelog from the corresponding blog post inline.
 */

(async function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────────────────

  // Any vivaldi.com blog post link
  const BLOG_LINK_RE = /^https?:\/\/vivaldi\.com\/blog\//i;

  // Ticket ID patterns across all platforms: VB-, VAB-, VIB-, etc.
  const TICKET_RE_STR = 'V[A-Z]*B-\\d+';

  // Headings that mean "these list items are downloads, not changelog"
  const DOWNLOAD_HEADING_RE = /download/i;

  // List items that look like changelog entries:
  // Start with [Category] or contain a ticket ID
  const CHANGELOG_ITEM_RE = /^\s*\[|V[A-Z]*B-\d+/;

  // Store / app distribution links
  const STORE_PATTERNS = [
    { re: /play\.google\.com/,      label: 'Google Play',  icon: '▶' },
    { re: /testflight\.apple\.com/, label: 'TestFlight',   icon: '' },
    { re: /apps\.apple\.com/,       label: 'App Store',    icon: '' },
    { re: /uptodown\.com/,          label: 'Uptodown',     icon: '⬇' },
    { re: /downloads\.vivaldi\.com/,label: null,           icon: '⬇' },
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function platformFromUrl (url) {
    if (/\/blog\/android\//i.test(url)) return { label: 'Android', emoji: '🤖' };
    if (/\/blog\/ios\//i.test(url))     return { label: 'iOS',     emoji: '🍎' };
    return                                     { label: 'Desktop', emoji: '🖥' };
  }

  function releaseTypeFromUrl (url) {
    if (/snapshot|rc[\-_]?\d|\brc\b/i.test(url)) return 'Snapshot';
    if (/minor.update/i.test(url))                return 'Stable Update';
    return 'Update';
  }

  function absHref (el, base) {
    try { return new URL(el.getAttribute('href'), base).href; } catch { return null; }
  }

  function cloneLi (li, blogUrl) {
    const c = li.cloneNode(true);
    for (const a of c.querySelectorAll('a[href]')) {
      const abs = absHref(a, blogUrl);
      if (abs) a.href = abs;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return c;
  }

  // ── Entry point ───────────────────────────────────────────────────────────

  processExistingPosts();
  observeNewPosts();

  function processExistingPosts () {
    const p = document.querySelector('[component="post"][data-index="0"]');
    if (p) tryExpandPost(p);
  }

  function observeNewPosts () {
    new MutationObserver((mutations) => {
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches('[component="post"][data-index="0"]')) tryExpandPost(node);
          const n = node.querySelector('[component="post"][data-index="0"]');
          if (n) tryExpandPost(n);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  async function tryExpandPost (postEl) {
    if (postEl.dataset.clExpandDone) return;
    postEl.dataset.clExpandDone = '1';

    const contentEl = postEl.querySelector('[component="post/content"]');
    if (!contentEl) return;

    let blogUrl = null;
    for (const a of contentEl.querySelectorAll('a[href]')) {
      if (BLOG_LINK_RE.test(a.href)) { blogUrl = a.href; break; }
    }
    if (!blogUrl) return;

    const loader = buildLoader();
    contentEl.appendChild(loader);
    try {
      const data = await fetchChangelog(blogUrl);
      loader.remove();
      injectChangelog(contentEl, data);
    } catch (err) {
      loader.remove();
      injectError(contentEl, err, blogUrl);
    }
  }

  // ── Fetch & parse ─────────────────────────────────────────────────────────

  async function fetchChangelog (blogUrl) {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'FETCH_URL', url: blogUrl }, (r) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (r?.error)            reject(new Error(r.error));
        else                          resolve(r);
      });
    });

    const doc = new DOMParser().parseFromString(resp.html, 'text/html');
    const entry = doc.querySelector('.entry-content');
    if (!entry) throw new Error('Could not find blog post content.');

    const platform    = platformFromUrl(blogUrl);
    const releaseType = releaseTypeFromUrl(blogUrl);

    // Version: prefer a 4-part build number, fall back to 2-part x.x
    const versionMatch =
      blogUrl.match(/\b(\d+\.\d+\.\d+[\.\d]*)\b/) ||
      doc.title.match(/\b(\d+\.\d+[\.\d]*)\b/);
    const version = versionMatch
      ? versionMatch[1].replace(/-/g, '.')
      : null;

    // ── Section walker ───────────────────────────────────────────────────────
    // Walk every direct child of .entry-content in document order.
    // Accumulate <li> items under the nearest preceding heading.
    // A null heading means "no heading seen yet" — those items go into a
    // synthetic 'Changelog' group if they look like changelog entries.

    const groups = [];   // { heading: string|null, items: li[] }
    let heading  = null;
    let items    = [];

    const flush = () => {
      if (items.length) { groups.push({ heading, items }); items = []; }
    };

    for (const el of entry.children) {
      const tag = el.tagName;

      if (tag === 'H2' || tag === 'H3' || tag === 'H4') {
        flush();
        heading = el.textContent.trim();
        continue;
      }

      if (tag === 'UL' || tag === 'OL') {
        for (const li of el.querySelectorAll(':scope > li')) {
          items.push(cloneLi(li, blogUrl));
        }
        continue;
      }
      // Other elements (p, div, img…) don't break the current group.
    }
    flush();

    // ── Classify groups ──────────────────────────────────────────────────────

    const changelogGroups = [];
    const downloadGroups  = [];

    for (const g of groups) {
      if (g.heading && DOWNLOAD_HEADING_RE.test(g.heading)) {
        downloadGroups.push(g);
        continue;
      }

      // Keep items that look like changelog entries; drop obvious nav/store items
      const clItems = g.items.filter(li => CHANGELOG_ITEM_RE.test(li.textContent));

      if (clItems.length > 0) {
        changelogGroups.push({ heading: g.heading, items: clItems });
      } else if (g.items.length > 0 && !g.heading) {
        // Items under no heading that aren't changelog — ignore (likely store blurb)
      } else if (g.items.length > 0) {
        // Named non-download group with no changelog items — pass through as-is
        // (e.g. "Known Issues", "Release candidate feedback")
        changelogGroups.push(g);
      }
    }

    // Synthesise a heading for headingless changelog groups
    for (const g of changelogGroups) {
      if (!g.heading) g.heading = 'Changelog';
    }

    // ── Store links (mobile) ─────────────────────────────────────────────────
    const storeLinks = extractStoreLinks(entry, blogUrl);

    if (changelogGroups.length === 0 && storeLinks.length === 0) {
      throw new Error('No changelog content found in blog post.');
    }

    return { changelogGroups, downloadGroups, storeLinks, version, platform, releaseType, blogUrl };
  }

  function extractStoreLinks (entry, blogUrl) {
    const links = [];
    const seen  = new Set();

    for (const a of entry.querySelectorAll('a[href]')) {
      const href = absHref(a, blogUrl);
      if (!href || seen.has(href)) continue;

      for (const { re, label, icon } of STORE_PATTERNS) {
        if (re.test(href)) {
          seen.add(href);
          let text = label
            || a.textContent.trim()
            || (href.match(/\.(\w+)(?:\?|$)/) || [])[1]?.toUpperCase()
            || href;
          if (text.length > 40) text = text.slice(0, 38) + '…';
          links.push({ href, label: text, icon });
          break;
        }
      }
    }
    return links;
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  function injectChangelog (contentEl, { changelogGroups, downloadGroups, storeLinks, version, platform, releaseType, blogUrl }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'vcl-changelog';

    // Header
    const header = document.createElement('div');
    header.className = 'vcl-header';

    const badgeWrap = document.createElement('span');
    badgeWrap.className = 'vcl-badge-wrap';
    badgeWrap.innerHTML = `
      <span class="vcl-badge vcl-badge-platform">${platform.emoji} ${platform.label}</span>
      <span class="vcl-badge vcl-badge-type">${releaseType}</span>
    `;

    const versionSpan = document.createElement('span');
    versionSpan.className = 'vcl-version';
    versionSpan.textContent = version ? `v${version}` : '';

    const sourceLink = document.createElement('a');
    sourceLink.className = 'vcl-source-link';
    sourceLink.href = blogUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = 'View blog post ↗';

    header.append(badgeWrap, versionSpan, sourceLink);
    wrapper.appendChild(header);

    // Changelog sections
    for (const { heading, items } of changelogGroups) {
      wrapper.appendChild(buildChangelogSection(heading, items));
    }

    // Desktop download sections
    for (const { heading, items } of downloadGroups) {
      wrapper.appendChild(buildDownloadSection(heading, items));
    }

    // Mobile store links
    if (storeLinks.length > 0) {
      wrapper.appendChild(buildStoreSection(storeLinks));
    }

    const sep = document.createElement('hr');
    sep.className = 'vcl-sep';
    contentEl.appendChild(sep);
    contentEl.appendChild(wrapper);
  }

  function buildChangelogSection (heading, items) {
    const section = document.createElement('div');
    section.className = 'vcl-section';

    if (heading) {
      const h = document.createElement('h4');
      h.className = 'vcl-section-heading';
      h.textContent = heading;
      section.appendChild(h);
    }

    const ul = document.createElement('ul');
    ul.className = 'vcl-list';
    for (const li of items) {
      highlightTickets(li);
      ul.appendChild(li);
    }
    section.appendChild(ul);
    return section;
  }

  function buildDownloadSection (heading, items) {
    const section = document.createElement('div');
    section.className = 'vcl-section vcl-downloads';

    const h = document.createElement('h4');
    h.className = 'vcl-section-heading';
    h.textContent = heading || 'Download';
    section.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'vcl-dl-grid';

    for (const li of items) {
      const anchors = [...li.querySelectorAll('a[href]')];
      if (!anchors.length) continue;

      const row = document.createElement('div');
      row.className = 'vcl-dl-platform';

      const labelEl = document.createElement('span');
      labelEl.className = 'vcl-dl-label';
      // Text before the first colon, or the full text node before first link
      labelEl.textContent = li.textContent.split(':')[0].trim();
      row.appendChild(labelEl);

      const pills = document.createElement('span');
      pills.className = 'vcl-dl-pills';
      for (const a of anchors) {
        const pill = document.createElement('a');
        pill.className = 'vcl-dl-pill';
        pill.href = a.href;
        pill.target = '_blank';
        pill.rel = 'noopener noreferrer';
        const ext = (a.href.match(/\.(\w+)(?:\?|$)/) || [])[1]?.toUpperCase()
                 || a.textContent.trim();
        pill.textContent = ext;
        pill.title = a.href;
        pills.appendChild(pill);
      }
      row.appendChild(pills);
      grid.appendChild(row);
    }
    section.appendChild(grid);
    return section;
  }

  function buildStoreSection (storeLinks) {
    const section = document.createElement('div');
    section.className = 'vcl-section vcl-downloads';

    const h = document.createElement('h4');
    h.className = 'vcl-section-heading';
    h.textContent = 'Download';
    section.appendChild(h);

    const row = document.createElement('div');
    row.className = 'vcl-store-row';
    for (const { href, label, icon } of storeLinks) {
      const btn = document.createElement('a');
      btn.className = 'vcl-store-btn';
      btn.href = href;
      btn.target = '_blank';
      btn.rel = 'noopener noreferrer';
      btn.innerHTML = `<span class="vcl-store-icon">${icon}</span><span class="vcl-store-label">${label}</span>`;
      row.appendChild(btn);
    }
    section.appendChild(row);
    return section;
  }

  // ── Ticket highlighting ───────────────────────────────────────────────────

  function highlightTickets (el) {
    const re = new RegExp(TICKET_RE_STR, 'g');
    walkText(el, (node) => {
      const text = node.textContent;
      re.lastIndex = 0;
      if (!re.test(text)) return;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(new RegExp(TICKET_RE_STR, 'g'))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const tag = document.createElement('span');
        tag.className = 'vcl-ticket';
        tag.textContent = m[0];
        frag.appendChild(tag);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
  }

  function walkText (node, fn) {
    if (node.nodeType === Node.TEXT_NODE) { fn(node); return; }
    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A') return;
    for (const child of [...node.childNodes]) walkText(child, fn);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  function buildLoader () {
    const el = document.createElement('div');
    el.className = 'vcl-loader';
    el.innerHTML = `
      <span class="vcl-loader-dot"></span>
      <span class="vcl-loader-dot"></span>
      <span class="vcl-loader-dot"></span>
      <span class="vcl-loader-text">Fetching full changelog…</span>
    `;
    return el;
  }

  function injectError (contentEl, err, blogUrl) {
    const el = document.createElement('div');
    el.className = 'vcl-error';
    el.innerHTML = `
      <span class="vcl-error-icon">⚠</span>
      <span>Could not load changelog.</span>
      <a href="${blogUrl}" target="_blank" rel="noopener noreferrer">Open blog post ↗</a>
    `;
    contentEl.appendChild(el);
    console.warn('[Vivaldi Changelog Expander]', err);
  }
})();
