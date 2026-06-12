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

  // Simple in-memory cache to prevent redundant fetches during a session
  const changelogCache = new Map();

  // Ticket ID patterns across all platforms: VB-, VAB-, VIB-, etc.
  const TICKET_RE_STR = 'V[A-Z]*B-\\d+'; // Keep this for highlighting
  const TICKET_RE_G   = new RegExp(TICKET_RE_STR, 'g');

  // Headings that mean "these list items are downloads, not changelog"
  const DOWNLOAD_HEADING_RE = /download/i;

  // List items that look like changelog entries:
  // Start with [Category] or contain a ticket ID
  // Using \s covers both standard spaces and non-breaking spaces (\u00A0)
  const CHANGELOG_ITEM_RE = /^\s*\[|V[A-Z]*B-\d+/;

  // Store / app distribution links
  const STORE_PATTERNS = [
    { re: /play\.google\.com/,      label: 'Google Play',  icon: '▶' },
    { re: /testflight\.apple\.com/, label: 'TestFlight',   icon: '⬇' },
    { re: /apps\.apple\.com/,       label: 'App Store',    icon: '⬇' },
    { re: /uptodown\.com/,          label: 'Uptodown',     icon: '⬇' },
    { re: /downloads\.vivaldi\.com/,label: null,           icon: '⬇' },
    { re: /vivaldi\.com\/download/, label: 'Download Vivaldi', icon: '⬇' },
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

  function cloneLi (el, blogUrl) {
    let c;
    if (el.tagName === 'LI') {
      c = el.cloneNode(true);
    } else {
      c = document.createElement('li');
      const clone = el.cloneNode(true);
      while (clone.firstChild) c.appendChild(clone.firstChild);
    }
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
      const postsToProcess = new Set();
      for (const { addedNodes } of mutations) {
        for (const node of addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches('[component="post"][data-index="0"]')) postsToProcess.add(node);
          const n = node.querySelector('[component="post"][data-index="0"]');
          if (n) postsToProcess.add(n);
        }
      }
      postsToProcess.forEach(tryExpandPost);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // ── Theme management logic ────────────────────────────────────────────────

  async function updateTheme(el, forcedTheme) {
    let theme = forcedTheme;
    if (!theme) {
      const data = await chrome.storage.local.get('theme');
      theme = data.theme;
    }

    // Default to light if no manual preference is set
    const targetTheme = (theme === 'dark' || theme === 'light') ? theme : 'light';
    
    el.classList.remove('vcl-theme-light', 'vcl-theme-dark');
    el.classList.add(`vcl-theme-${targetTheme}`);
  }

  // Watch for manual settings changes in the popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.theme) {
      const newTheme = changes.theme.newValue;
      document.querySelectorAll('.vcl-changelog').forEach(el => updateTheme(el, newTheme));
    }
  });

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
      const data = await getChangelog(blogUrl);
      loader.remove();
      injectChangelog(contentEl, data);
    } catch (err) {
      loader.remove();
      injectError(contentEl, err, blogUrl);
    }
  }

  // ── Fetch & parse ─────────────────────────────────────────────────────────

  async function getChangelog (blogUrl) {
    if (changelogCache.has(blogUrl)) return changelogCache.get(blogUrl);
    const data = await fetchChangelog(blogUrl);
    changelogCache.set(blogUrl, data);
    return data;
  }

  async function fetchChangelog (blogUrl) {
    const fetchHtml = (urlToFetch) => new Promise((resolve, reject) => { // Renamed parameter for clarity
      chrome.runtime.sendMessage({ type: 'FETCH_URL', url: urlToFetch }, (r) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (r?.error)            reject(new Error(r.error));
        else                          resolve(r);
      });
    });

    // 1. Fetch and parse the original blog post
    const respBlog = await fetchHtml(blogUrl);
    const docBlog = new DOMParser().parseFromString(respBlog.html, 'text/html');

    // 2. Extract store links from the original blog post (these are usually only on the blog post)
    const blogEntry = docBlog.querySelector('.entry-content, .post-content, main, article, #content');
    const storeLinks = blogEntry ? extractStoreLinks(blogEntry, blogUrl) : [];

    // 3. Determine which document contains the main changelog content
    let changelogDoc = docBlog;
    let changelogSourceUrl = blogUrl; // The URL from which changelogDoc was fetched
    // Match links containing "vivaldi.com/changelog" to catch both /changelog/ and /changelog- slugs
    const fullLink = docBlog.querySelector('a[href*="vivaldi.com/changelog"]');

    if (fullLink) {
      // Prioritize the dedicated changelog page if a link is found
      const fullChangelogUrl = fullLink.href;
      const respFull = await fetchHtml(fullChangelogUrl);
      changelogDoc = new DOMParser().parseFromString(respFull.html, 'text/html');
      changelogSourceUrl = fullChangelogUrl;
    }

    // 4. Parse the changelog and download groups from the chosen document
    const { changelogGroups, downloadGroups, version, platform, releaseType } =
      parseChangelogAndDownloads(changelogDoc, changelogSourceUrl, blogUrl);

    // 5. Combine all data
    if (changelogGroups.length === 0 && downloadGroups.length === 0 && storeLinks.length === 0) {
      // If we parsed a dedicated changelog page and it was empty, or if the blog post was empty.
      // The error message now indicates which URL was ultimately parsed for content.
      throw new Error(`No changelog content found in ${changelogSourceUrl}.`);
    }

    return { changelogGroups, downloadGroups, storeLinks, version, platform, releaseType, blogUrl };
  }

  // This function now only parses changelog and download sections, not store links
  function parseChangelogAndDownloads (doc, contentSourceUrl, metadataSourceUrl) {
    const entry = doc.querySelector('.entry-content, .post-content, main, article, #content');
    if (!entry) return { changelogGroups: [], downloadGroups: [], storeLinks: [], version: null };

    const platform    = platformFromUrl(metadataSourceUrl);
    const releaseType = releaseTypeFromUrl(metadataSourceUrl);

    // Version: prefer a 4-part build number, fall back to 2-part x.x
    const versionMatch =
      metadataSourceUrl.match(/\b(\d+\.\d+\.\d+[\.\d]*)\b/) ||
      doc.title.match(/\b(\d+\.\d+[\.\d]*)\b/);
    const version = versionMatch
      ? versionMatch[1].replace(/-/g, '.')
      : null;

    // ── Section walker ───────────────────────────────────────────────────────
    // Walk relevant elements in .entry-content in document order.
    // Accumulate <li> items under the nearest preceding heading or summary.
    // A null heading means "no heading seen yet" — those items go into a
    // synthetic 'Changelog' group if they look like changelog entries.

    const groups = [];   // { heading: string|null, items: li[] }
    let heading  = null;
    let items    = [];

    const flush = () => {
      if (items.length) { groups.push({ heading, items }); items = []; }
    };

    const elements = entry.querySelectorAll('h1, h2, h3, h4, h5, h6, summary, details, ul, ol, p'); // Already includes p
    for (const el of elements) {
      const tag = el.tagName;

      if (/^H[1-6]$/.test(tag) || tag === 'SUMMARY') {
        flush();
        heading = el.textContent.trim();
        continue;
      }

      if (tag === 'DETAILS') {
        // Don't treat <details> as a heading, but allow its children to be processed
        continue;
      }
      if (tag === 'UL' || tag === 'OL') {
        // Skip nested lists to avoid double-processing items
        if (el.parentElement.closest('ul, ol')) continue;

        for (const li of el.querySelectorAll(':scope > li')) {
          items.push(cloneLi(li, contentSourceUrl));
        }
        continue;
      }

      if (tag === 'P') {
        // Skip paragraphs inside lists or summaries to avoid double-processing
        // Also skip if it's a direct child of a details element, as it might be part of a summary-like structure
        // or if it's empty (e.g., <p>&nbsp;</p>)
        if (el.closest('ul, ol, summary') || el.parentElement.tagName === 'DETAILS' || el.textContent.trim() === '') continue;

        if (CHANGELOG_ITEM_RE.test(el.textContent)) {
          items.push(cloneLi(el, contentSourceUrl));
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
        changelogGroups.push({ heading: g.heading, items: clItems }); // Found specific changelog items
      } else if (g.items.length > 0 && !g.heading) { // Items with no heading, not matching changelog regex
        // Items under no heading that aren't changelog — ignore (likely store blurb)
      } else if (g.items.length > 0 && g.heading) { // Named group with items, but no specific changelog items
        // Named non-download group with no changelog items — pass through as-is
        // (e.g. "Known Issues", "Release candidate feedback")
        changelogGroups.push(g);
      }
    }

    // Synthesise a heading for headingless changelog groups
    for (const g of changelogGroups) {
      if (!g.heading) g.heading = 'Changelog';
    }

    // Deduplicate downloads: If "Alternative Downloads" exists, prefer it over generic "Download"
    let finalDownloadGroups = downloadGroups;
    if (downloadGroups.length > 1) {
      // Identify if we have specific, high-detail sections (headings with version digits or "alternative")
      const detailedGroups = downloadGroups.filter(g => g.heading && (/\d/.test(g.heading) || /alternative/i.test(g.heading)));

      if (detailedGroups.length > 0) {
        finalDownloadGroups = downloadGroups.filter(g => {
          if (!g.heading) return false;
          // Keep it if it is a detailed section (contains version numbers or "alternative")
          if (/\d/.test(g.heading) || /alternative/i.test(g.heading)) return true;
          
          // Filter out generic headings if detailed ones exist (e.g., "DOWNLOAD", "Download Vivaldi")
          const isGeneric = /^\s*(downloads?|download vivaldi|download snapshot|download now)[\s:]*$/i.test(g.heading);
          return !isGeneric;
        });
      }
    }

    return { changelogGroups, downloadGroups: finalDownloadGroups, version, platform, releaseType };
  }

  function extractStoreLinks (entry, blogUrl) {
    const links = [];
    const seen  = new Set();

    for (const a of entry.querySelectorAll('a[href]')) {
      let href = absHref(a, blogUrl);
      if (!href) continue;

      // Ensure HTTPS for Vivaldi.com links
      if (href.startsWith('http://vivaldi.com/')) {
        href = href.replace('http://', 'https://');
      }

      // Normalize URL for deduplication.
      // Most store links work without query params, but Google Play requires the ?id= parameter.
      let normalized = href.split('#')[0].replace(/\/+$/, '');
      if (!normalized.includes('play.google.com')) {
        // Specific normalization for Uptodown to handle language subdomains (e.g., .en, .es)
        if (normalized.includes('uptodown.com')) {
          try {
            const urlObj = new URL(normalized);
            // Check if the hostname is like 'something.lang.uptodown.com'
            if (urlObj.hostname.split('.').length > 2 && urlObj.hostname.endsWith('uptodown.com')) {
              urlObj.hostname = urlObj.hostname.replace(/\.[a-z]{2}\.uptodown\.com$/, '.uptodown.com');
              normalized = urlObj.toString();
            }
          } catch (e) { /* Ignore URL parsing errors */ }
        }
        normalized = normalized.split('?')[0];
      }

      if (seen.has(normalized)) continue;

      for (const { re, label, icon } of STORE_PATTERNS) {
        if (re.test(normalized)) {
          seen.add(normalized);
          let text = label
            || a.textContent.trim()
            || (normalized.match(/\.(\w+)(?:\?|$)/) || [])[1]?.toUpperCase()
            || normalized;
          if (text.length > 40) text = text.slice(0, 38) + '…';
          links.push({ href: normalized, label: text, icon });
          break;
        }
      }
    }
    return links;
  }

  // ── DOM construction ──────────────────────────────────────────────────────

  async function injectChangelog (contentEl, { changelogGroups, downloadGroups, storeLinks, version, platform, releaseType, blogUrl }) {
    const wrapper = document.createElement('div');
    wrapper.className = 'vcl-changelog';

    // Detect navbar height dynamically (handles if user blocked/hid it)
    const navbar = document.getElementById('header-menu');
    const navHeight = (navbar && window.getComputedStyle(navbar).display !== 'none') 
      ? navbar.offsetHeight : 0;
    wrapper.style.setProperty('--vcl-offset', `${navHeight}px`);

    // Apply initial theme based on manual settings
    await updateTheme(wrapper);

    // Header
    const header = document.createElement('div');
    header.className = 'vcl-header';

    const badgeWrap = document.createElement('span');
    badgeWrap.className = 'vcl-badge-wrap';

    const platformBadge = document.createElement('span');
    platformBadge.className = 'vcl-badge vcl-badge-platform';
    platformBadge.textContent = `${platform.emoji} ${platform.label}`;

    const typeBadge = document.createElement('span');
    typeBadge.className = 'vcl-badge vcl-badge-type';
    typeBadge.textContent = releaseType;

    badgeWrap.append(platformBadge, typeBadge);

    const versionSpan = document.createElement('span');
    versionSpan.className = 'vcl-version';
    versionSpan.textContent = version ? `v${version}` : '';

    // Toggle Button
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'vcl-toggle-btn';
    toggleBtn.setAttribute('aria-label', 'Toggle changelog visibility');
    toggleBtn.textContent = 'Collapse';
    toggleBtn.onclick = () => {
      const isCollapsed = wrapper.classList.toggle('vcl-collapsed');
      toggleBtn.textContent = isCollapsed ? 'Expand' : 'Collapse';
    };

    // Navigation Buttons
    const navGroup = document.createElement('div');
    navGroup.className = 'vcl-nav-group';

    const btnUp = document.createElement('button');
    btnUp.className = 'vcl-nav-btn';
    btnUp.textContent = '↑';
    btnUp.setAttribute('aria-label', 'Scroll to top of page');
    btnUp.title = 'Scroll to top of page';
    btnUp.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });

    const btnDown = document.createElement('button');
    btnDown.className = 'vcl-nav-btn';
    btnDown.textContent = '↓';
    btnDown.setAttribute('aria-label', 'Scroll to bottom of changelog');
    btnDown.title = 'Scroll to bottom of changelog';
    btnDown.onclick = () => wrapper.scrollIntoView({ behavior: 'smooth', block: 'end' });

    navGroup.append(btnUp, btnDown);

    const sourceLink = document.createElement('a');
    sourceLink.className = 'vcl-source-link';
    sourceLink.href = blogUrl;
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = 'View blog post ↗';

    header.append(badgeWrap, versionSpan, toggleBtn, navGroup, sourceLink);
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
    const existingUrls = new Set();
    let hasAlternative = false;

    downloadGroups.forEach(g => {
      if (g.heading && /alternative/i.test(g.heading)) hasAlternative = true;
      g.items.forEach(li => {
        li.querySelectorAll('a[href]').forEach(a => existingUrls.add(a.href));
      });
    });

    const filteredStoreLinks = storeLinks.filter(link => {
      // 1. Remove exact URL duplicates (handles direct APK/EXE links already in the grid)
      if (existingUrls.has(link.href)) return false;

      // 2. If architecture-specific "Alternative Downloads" exist, hide generic store buttons
      if (hasAlternative) {
        // Keep Google Play link, as users might prefer Play Store even for snapshots
        if (link.label === 'Google Play') return true;

        // Filter out other generic store links (e.g., App Store, TestFlight, generic Vivaldi Download)
        // as they are often redundant or not applicable for Android snapshots with specific APKs.
        const otherGenericLabels = ['App Store', 'TestFlight', 'Uptodown', 'Download Vivaldi'];
        if (otherGenericLabels.includes(link.label)) return false;
      }
      return true;
    });

    if (filteredStoreLinks.length > 0) {
      wrapper.appendChild(buildStoreSection(filteredStoreLinks));
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

    const iconEl = document.createElement('span');
    iconEl.className = 'vcl-store-icon';
    iconEl.textContent = icon;
    const labelEl = document.createElement('span');
    labelEl.className = 'vcl-store-label';
    labelEl.textContent = label;

    btn.append(iconEl, labelEl);
      row.appendChild(btn);
    }
    section.appendChild(row);
    return section;
  }

  // ── Ticket highlighting ───────────────────────────────────────────────────

  function highlightTickets (el) {
    walkText(el, (node) => {
      const text = node.textContent;
      TICKET_RE_G.lastIndex = 0;
      if (!TICKET_RE_G.test(text)) return;
      
      TICKET_RE_G.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(TICKET_RE_G)) {
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
    if (node.nodeType === Node.ELEMENT_NODE) {
      // Skip links and already processed ticket badges to prevent double-wrapping
      if (node.tagName === 'A' || node.classList.contains('vcl-ticket')) return;
    }
    for (const child of [...node.childNodes]) walkText(child, fn);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  function buildLoader () {
    const el = document.createElement('div');
    el.className = 'vcl-loader';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'vcl-loader-dot';
      el.appendChild(dot);
    }

    const text = document.createElement('span');
    text.className = 'vcl-loader-text';
    text.textContent = 'Fetching full changelog…';
    el.appendChild(text);

    return el;
  }

  function injectError (contentEl, err, blogUrl) {
    const el = document.createElement('div');
    el.className = 'vcl-error';

    const icon = document.createElement('span');
    icon.className = 'vcl-error-icon';
    icon.textContent = '⚠';

    const text = document.createElement('span');
    text.textContent = 'Could not load changelog.';

    const link = document.createElement('a');
    link.href = blogUrl;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open blog post ↗';

    el.append(icon, text, link);
    contentEl.appendChild(el);
    console.warn('[Vivaldi Changelog Expander]', err);
  }
})();
