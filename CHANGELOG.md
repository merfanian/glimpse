# Changelog

All notable changes to Glimpse. The release workflow publishes the section matching each
version tag as that release's notes, so add a section **before** bumping the version.

## [1.2.0] - 2026-11-23

A big reliability and design update: previews now work across Chrome, Edge and Firefox, find
the right paper far more often, and look new from icon to panel.

### Highlights

- **Finds the cited paper far more reliably.** Glimpse now searches Semantic Scholar, arXiv,
  Crossref and OpenAlex together and retries when a service is busy. Previously many lookups
  failed once Semantic Scholar rate-limited.
- **Reads more bibliographies correctly.** Better support for two-column layouts, entries
  that continue in the next column, ACM / IEEE / ACL / NeurIPS styles, review copies with
  line numbers, and years like "2018a".
- **Works with the browser's own PDF viewer.** When you open a PDF, Glimpse offers to open it
  where previews work, or does it automatically if you choose "Always" in the popup.
- **A new look.** New icon, a redesigned panel, popup and settings page, and automatic dark
  mode.

### Improvements

- Full PDFs open page by page, so the first page appears in under a second.
- When no paper clearly matches, Glimpse says so and lists possible matches and a Google
  Scholar search, instead of showing a wrong paper.
- The panel can be resized from either bottom corner, remembers its position, stays on
  screen, and closes with Esc.
- The viewer adds a **Download** button and **Open in browser's viewer**, opens at 100% zoom,
  accepts PDFs dragged into the window, and shows each paper's real title.
- The popup recognises PDF links without ".pdf" in the address (for example
  `arxiv.org/pdf/…`).
- Settings save automatically.

### Fixes

- Moving between adjacent citations, such as the two in "[1, 2]", now previews the one you
  chose.
- The "Full PDF" default setting now works.
- Clicking Preview shows progress immediately instead of appearing to do nothing.
- Error messages describe what actually went wrong.
- Glimpse no longer slows down ordinary websites. It only loads where there is a PDF to
  read; before, it loaded on every page.
