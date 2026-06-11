/**
 * Vivaldi Changelog Expander — Background Service Worker
 *
 * Content scripts cannot fetch cross-origin URLs directly (vivaldi.com
 * from forum.vivaldi.net). This service worker receives fetch requests
 * from the content script, performs the actual fetch with full extension
 * privileges, and returns the raw HTML text.
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'FETCH_URL') return false;

  const url = message.url;

  // Basic allowlist — only fetch vivaldi.com blog posts or dedicated changelog pages (including hyphenated ones)
  if (!/^https:\/\/vivaldi\.com\/(blog|changelog)/i.test(url)) {
    sendResponse({ error: 'URL not allowed: ' + url });
    return false;
  }

  fetch(url, {
    credentials: 'omit',
    headers: { 'Accept': 'text/html' }
  })
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      return resp.text();
    })
    .then(html => sendResponse({ html }))
    .catch(err => sendResponse({ error: err.message }));

  // Return true to keep the message channel open for the async response
  return true;
});
