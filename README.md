# Vivaldi Changelog Expander

A Chromium browser extension that automatically fetches and injects the **full changelog** from Vivaldi's blog directly into release announcement threads on the Vivaldi forum.

![Image](https://i.imgur.com/laVfIGL.png)

## What it does

When you open a Vivaldi release announcement thread on `forum.vivaldi.net`, the extension:

1. Detects that the first post contains a link to a Vivaldi blog release announcement post.
2. Fetches that blog post in the background.
3. Parses the changelog and download sections.
4. Injects the full changelog inline inside the forum post — no need to open a second tab.

This works for most release announcement posts.

## Features

- ✅ Full changelog rendered inline with styled sections
- ✅ VB-XXXXXX ticket numbers highlighted as badges
- ✅ Download links presented as clean pill buttons
- ✅ Loading state while fetching
- ✅ Graceful error fallback with direct blog link
- ✅ Dark mode support
- ✅ No tracking, no external services — just fetches the public blog post

## Installation (Developer / Unpacked)

Since this extension is not on the Chrome Web Store, install it as an unpacked extension:

1. Open Chrome/Vivaldi and go to `chrome://extensions` (or `vivaldi://extensions`).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `vivaldi-changelog-ext` folder.
5. Done! Navigate to any Vivaldi release forum thread.

## How it works

The content script (`content.js`) runs on `forum.vivaldi.net`. It watches for the first post of each thread and checks whether it contains a link to a Vivaldi blog release post. If found, it fetches that page, parses the `<h3>` + `<ul>` structure that Vivaldi consistently uses for changelogs, and injects the result as a styled block at the bottom of the post content.

A `MutationObserver` handles cases where the page is navigated without a full reload (NodeBB's SPA routing).
