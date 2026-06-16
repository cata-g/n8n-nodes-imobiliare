# Test fixtures

Real imobiliare.ro snapshots, **trimmed** to keep the repo small.

| File | Source | Notes |
| --- | --- | --- |
| `search-cluj.html` | `imobiliare.ro/vanzare-apartamente/cluj-napoca` | The first 12 server-rendered listing cards only (the live page is ~2.7 MB). Includes a card with a price drop (`Preț vechi`). |
| `detail-275453001.html` | a listing `/oferta/...` page | Reduced to the page's schema.org JSON-LD block (the live page is ~1.4 MB). |

The search cards are parsed from rendered HTML; the detail page is parsed from its
JSON-LD `@graph` (more robust). Numbers use Romanian formatting and some JSON-LD strings
carry HTML entities (`M&#259;r&#259;&#537;ti` → `Mărăști`).
