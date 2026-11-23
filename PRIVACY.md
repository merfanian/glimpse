# Glimpse privacy policy

_Last updated: November 23, 2026_

Glimpse is a browser extension that previews papers cited in a PDF. It has no servers of its
own, no accounts, no analytics, and no tracking. Everything runs in your browser.

## What leaves your browser

To find a cited paper, Glimpse sends the text of that **one bibliography entry** (for example
"A. Vaswani et al. Attention is all you need. NeurIPS, 2017"), or the title, DOI or arXiv ID
parsed from it, directly from your browser to these public scholarly databases:

- Semantic Scholar (api.semanticscholar.org)
- arXiv (export.arxiv.org)
- Crossref (api.crossref.org)
- OpenAlex (api.openalex.org)

This happens only when you click **Preview** on a citation, and only for sources enabled in
Glimpse's settings. When you open the full PDF of a cited paper, your browser downloads it
from the publisher or repository that hosts it (for example arxiv.org).

If you enter the optional **contact email** in settings, it is sent only to Crossref and
OpenAlex as their "polite pool" parameter, which gives requests more reliable rate limits.

Each of these services handles requests under its own privacy policy.

## What Glimpse stores

Only in your browser's extension storage, never sent anywhere:

- your settings (which may include the optional contact email),
- the preview panel's last position and size,
- PDFs you open from your computer, held temporarily so the viewer tab can display them.

Lookup results are cached in memory for up to 30 minutes and discarded when the browser
closes.

## What Glimpse does not do

- It does not collect, sell, or share browsing history or personal data.
- It does not read or transmit the content of the pages you visit, except the single
  bibliography entry of a citation you choose to preview, as described above.
- It does not load or run remotely hosted code.

## Contact

Questions or concerns: open an issue at https://github.com/merfanian/glimpse/issues.
