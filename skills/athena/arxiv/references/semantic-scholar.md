# Semantic Scholar

Semantic Scholar, from the Allen Institute for AI, keeps what arXiv doesn't: how often a paper is cited and by whom,
what it cites, papers like it, and its authors' records. It indexes journals and conferences as well as arXiv, so it
also finds the published version of a preprint and work that never went to arXiv. Checked in November 2026 against
its Graph API v1 and Recommendations API v1 documentation (`https://api.semanticscholar.org/api-docs/`).

## Access and limits

- Most of it needs no key. Requests without one share a single pool across every user (1000 requests a second in
  total, the documentation says, throttled further when busy). In practice that pool is often full and answers
  `429 Too Many Requests`: while this was written, every request without a key got a 429 for half an hour.
- A key starts at 1 request a second on every endpoint. The user requests one on
  `https://www.semanticscholar.org/product/api` and gets it by email. It travels in the `x-api-key` header; page
  fetching can't add headers, so with a key, use the script, which reads it from the environment variable
  `SEMANTIC_SCHOLAR_API_KEY`. The user sets that variable themselves (on Windows, "Edit environment variables for
  your account"; on macOS or Linux, their shell profile) and restarts the dashboard, whose shells inherit its
  environment. The key never goes into the chat, a command line or a file.
- After a 429, wait minutes rather than seconds and go on one request at a time. The script tries three more times,
  5, 10 and 20 seconds apart, then stops with one line saying so. Don't wrap it in a loop of your own.

## The ids it takes

| Form | Example |
|---|---|
| `ARXIV:<id>`, with no version: one record covers every version | `ARXIV:2106.15928`, `ARXIV:hep-th/0601001` |
| `DOI:<doi>` | `DOI:10.18653/v1/N18-3011` |
| `CorpusId:`, `ACL:`, `PMID:`, `PMCID:`, `MAG:` | `CorpusId:215416146`, `ACL:W12-3903`, `PMID:19872477` |
| `URL:<link>` to semanticscholar.org, arxiv.org, aclweb.org, acm.org or biorxiv.org | `URL:https://arxiv.org/abs/2106.15928v1` |
| its own `paperId`, 40 hexadecimal characters | `649def34f8be52c8b66281af98ae884c09aef38b` |

The script turns arXiv ids and links, bare DOIs and doi.org links into these forms and passes the prefixed ones
through.

## Reading it with page fetching

Every address below is a GET that answers JSON, after `https://api.semanticscholar.org`. Without `fields=` an answer
holds only `paperId` and `title`.

| To get | Address |
|---|---|
| One paper | `/graph/v1/paper/ARXIV:2402.03300?fields=title,year,venue,citationCount,influentialCitationCount,externalIds,openAccessPdf` |
| Who cites it | `/graph/v1/paper/ARXIV:2402.03300/citations?fields=title,year,citationCount,isInfluential,contexts&limit=100` |
| What it cites | `/graph/v1/paper/ARXIV:2402.03300/references?fields=title,year,externalIds,citationCount&limit=100` |
| Papers like it | `/recommendations/v1/papers/forpaper/ARXIV:2402.03300?fields=title,year,externalIds&limit=20&from=recent` |
| A paper from its title | `/graph/v1/paper/search/match?query=Attention+Is+All+You+Need&fields=title,year,externalIds` |
| A search beyond arXiv | `/graph/v1/paper/search?query=group+relative+policy+optimization&fields=title,year,venue,externalIds&limit=20&year=2024-` |
| Authors by name | `/graph/v1/author/search?query=Yann+LeCun&fields=name,affiliations,paperCount,citationCount,hIndex` |
| An author's papers | `/graph/v1/author/<authorId>/papers?fields=title,year,externalIds,citationCount&limit=100` |

- **Paging.** Citations, references, author search and an author's papers take `limit` up to 1000 and `offset`; the
  answer has `next` while there are more. Relevance search takes `limit` up to 100 and reaches only its first 1,000
  results. Recommendations go up to 500, from `recent` papers (the default) or `all-cs`. No answer is larger than
  10 MB.
- **Citations and references** wrap each paper: `data[].citingPaper` or `data[].citedPaper`, and the fields you ask
  for (title, year…) apply to that paper. Beside it come `isInfluential`, `contexts` (the sentences where the
  citation is made) and `intents` (Semantic Scholar's guess at why: background, method or result extension). Either
  can be empty: intents exist only where it has the citing paper's full text.
- **Search** takes plain words: no operators, and a hyphenated word matches nothing, so write `chain of thought`.
  Filters: `year=2019`, `2016-2020` or `2010-`; `publicationDateOrYear`, `venue`, `fieldsOfStudy`,
  `minCitationCount`, and `openAccessPdf` (no value) for papers with a free PDF. `/graph/v1/paper/search/bulk` takes
  `+` (and), `|` (or), `-` (not), quoted phrases and parentheses, returns up to 1,000 papers a call with a `token` for
  the next call, and sorts with `sort=citationCount:desc` or `sort=publicationDate:desc`. `search/match` returns the
  single closest title, or a 404 "Title match not found".
- **Only by POST**, so through the script: `/graph/v1/paper/batch` (up to 500 ids as `{"ids": [...]}`, answering
  `null` for each id it doesn't know) and `/recommendations/v1/papers` (`{"positivePaperIds": [...],
  "negativePaperIds": [...]}`).
- **Errors** are JSON: 404 `{"error": "Paper with id ... not found"}`, 400 `{"error": "Unrecognized or unsupported
  fields: [...]"}`, 429 `{"message": "Too Many Requests. ...", "code": "429"}`.

Fields worth asking for on a paper: `title`, `year`, `publicationDate`, `authors`, `venue`, `journal`,
`citationCount`, `influentialCitationCount`, `referenceCount`, `externalIds` (ArXiv, DOI, ACL, PubMed, DBLP…),
`isOpenAccess`, `openAccessPdf`, `fieldsOfStudy`, `abstract`, `tldr` (a one-sentence summary written by a model).

## The script's commands for it

All print JSON, take `--out FILE` (with `--overwrite`) and `--timeout SECONDS` (default 60), and exit 0 when done,
1 when a paper wasn't found (listed under `not_found`), 2 when they couldn't do the job (one line on stderr).

- `paper ID... [--file IDS]`: Semantic Scholar's record of each paper (citation counts, venue, date, open-access PDF),
  up to 500 ids a request. `--file` reads ids from a text file, one per line.
- `cites ID [--max N] [--sort citations|newest|as-given] [--contexts]`: the papers that cite it. `--max` from 1 to
  1000 (default 100); `--sort` orders the papers fetched, most cited first by default; `--contexts` adds the citing
  sentences and the intents.
- `refs ID`, with the same options: the papers it cites.
- `similar ID... [--not ID] [--pool recent|all-cs] [--max N]`: recommendations like the papers given and unlike any
  given with `--not` (repeatable). `--pool` works with one paper and no `--not`; `--max` from 1 to 500 (default 20).
- `author NAME [--max N]`: authors matching a name, with affiliations, paper and citation counts, h-index and
  authorId; `--max` from 1 to 100 (default 10).

```
python <skill folder>/scripts/arxiv_search.py paper 2402.03300 hep-th/0601001 10.18653/v1/N18-3011
python <skill folder>/scripts/arxiv_search.py cites 2402.03300 --max 300 --contexts --out arxiv-work/cites.json
python <skill folder>/scripts/arxiv_search.py similar 2402.03300 1706.03762 --not 2005.14165
python <skill folder>/scripts/arxiv_search.py author Yann LeCun
```

Results use Semantic Scholar's own field names (`paperId`, `citationCount`, `influentialCitationCount`…), with
`authors` as names (the first five in lists, plus `author_count` when there are more), `arxiv` and `doi` taken from
`externalIds`, and `openAccessPdf` as a link or null. `cites` and `refs` sort only the papers they fetched:
`more_available: true` means there are more than `--max`, so "the most cited of the first 100", not of all.

## Reading the numbers

- Counts lag. A paper from last month has few citations whatever it's worth; compare papers of the same field and
  age.
- `influentialCitationCount` and `isInfluential` come from a model that weighs how a paper is cited, not only whether.
  They're a better sign than the raw count of work that builds on a paper, and still a model's guess, missing
  citations in papers whose full text Semantic Scholar doesn't have.
- Semantic Scholar, Google Scholar and publishers count differently. Say which source and date a number comes from.
- One record covers every arXiv version and usually the published paper too, so its counts and venue aren't about
  the version you read.
- A name in author search can be several people, and one person can be split over two records. Check affiliations
  and papers before crediting work to someone or quoting an h-index.
- A paper it doesn't know may be too new, or filed under another id: try its title with `search/match`.
