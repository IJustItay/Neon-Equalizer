# Code Reference: `src/components/squiglinkDB.js`

This module is responsible for bridging Neon Equalizer with the vast `squig.link` ecosystem, allowing users to search for and import headphone frequency response measurements directly from over 100 independent audio reviewers.

## Architecture & Data Flow

Squiglink does not have a single, monolithic API server. Instead, it is a collection of static Github Pages repositories hosted by individual reviewers (e.g., `crinacle.com`, `vsg.squig.link`).

To build a unified database without hardcoding every reviewer, this module performs a multi-stage data ingestion process:

### 1. The Master Registry (`loadSquigSites`)
It fetches `https://squig.link/squigsites.json`. This is the authoritative, centrally-maintained list of every known Squiglink-compatible reviewer site.
It parses the JSON and builds an array of `SQUIG_SOURCES`. If the user is offline or the registry is down, it falls back to a small hardcoded list of popular reviewers.

### 2. The Unified DB (`loadAllSources`)
For every source in the registry, the module concurrently fetches that reviewer's `data/phone_book.json` file.
This file contains the list of IEMs/Headphones measured by that reviewer, along with filenames for the raw measurement `.txt` files.
Simultaneously, it fetches the `MRSallee/squiglist` database, which contains community-curated metadata (prices, sound signatures, review scores, shop links).

It merges these datasets: mapping the reviewer's phone entry with the MRSallee metadata via fuzzy string matching (`findFuzzyMatch`), and deduplicating the list (keeping one entry *per reviewer*).

### 3. Caching Strategy
Fetching 100+ JSON files from Github Pages takes several seconds and burns network bandwidth. To solve this, `squiglinkDB.js` caches both the registry (`SITES_CACHE_KEY`) and the assembled unified DB (`DB_CACHE_KEY`) in `localStorage` with a 24-hour TTL (Time-To-Live).
Subsequent app launches load the DB instantly from the cache.

## Fetching Measurements (`fetchMeasurement`)

When a user clicks on an IEM in the UI, the app must fetch the raw `.txt` file containing the frequency response data. This is surprisingly complex because reviewers use different conventions:
*   Some upload a single file: `Moondrop Chu.txt`
*   Some upload Left/Right pairs: `Moondrop Chu L.txt` and `Moondrop Chu R.txt` (the module fetches both and averages them via `averageLR`).
*   Some prefix their files (e.g., `[HBB] Moondrop Chu.txt`) or append suffixes (e.g., `Moondrop Chu S2.txt`).
*   Some organize files in subdirectories, defined by a `DIR` variable inside a `config.js` or `assets/js/config.js` file.

`fetchMeasurement(phone)` acts as an intelligent crawler. It generates an array of candidate URLs (stems) based on the phone's properties and the reviewer's config, and attempts `tryFetchTxt` on them concurrently until it gets a valid 200 OK response with parseable frequency/SPL data.

## Text Parsing (`parseMeasurementText`)
The raw `.txt` files from Audio Precision or REW are simple two-column text files (Frequency and SPL). The parser handles different delimiters (tabs, commas, spaces) and ignores comment lines (starting with `*` or `#`).
