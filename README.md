# Vivaldi Changelog Expander

A Chromium extension for `forum.vivaldi.net` that inlines changelog data from Vivaldi blog posts into forum announcement threads.

![Image](https://i.imgur.com/334BJTj.png)

## What it does

1. Monitors the first post of a thread for links matching `vivaldi.com/blog/`.
2. Fetches the blog post HTML via a background service worker to bypass CORS restrictions.
3. Parses changelog entries and download links from the fetched HTML.
4. Injects a styled block into the forum post content containing the parsed data.

## Features

- **Inline Rendering:** Displays changelog sections, version info, and platform badges.
- **Ticket Highlighting:** Detects and badges Vivaldi bug tracker IDs (e.g., VB-XXXXX, VAB-XXXXX).
- **Download Management:** Organizes architecture-specific links into grids and deduplicates store links.
- **Theme Support:** Automatically synchronizes with the Vivaldi Forum theme settings.
- **SPA Support:** Uses `MutationObserver` to handle NodeBB's client-side navigation.

## Installation

This extension is not distributed through the Chrome Web Store. It must be installed as an unpacked extension:

1. Navigate to `vivaldi://extensions` or `chrome://extensions`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the directory containing the extension files.
