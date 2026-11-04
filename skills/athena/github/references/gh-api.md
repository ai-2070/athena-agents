# gh api

For what gh has no command for. `gh api` adds the sign-in and handles pagination; you give it the path, the method and
the fields. GitHub's REST docs (docs.github.com/rest) list every endpoint with its fields.

## The shape of a call

```
gh api 'repos/{owner}/{repo}/pulls/123/comments' --paginate
gh api --method POST 'repos/{owner}/{repo}/issues/123/labels' -f 'labels[]=bug' -f 'labels[]=ui'
gh api --method PATCH 'repos/{owner}/{repo}/issues/123' --input gh-work/patch.json
gh api graphql -F query=@gh-work/query.graphql -F number=123
```

- **The path** is relative to the API (`repos/…`, `user`, `search/issues`). gh fills in `{owner}`, `{repo}` and
  `{branch}` from the clone you're in, or from the `GH_REPO` environment variable. Put the path in single quotes:
  PowerShell treats braces as code, and a query string's `?` and `&` need quoting in every shell. In a clone with
  several remotes, write the owner and repo out, since the placeholders follow gh's choice of default repo.
- **The method** is GET, or POST once you add a field; `--method` sets it. With `--method GET`, fields go into the
  query string.
- **`-f key=value`** sends text. **`-F key=value`** converts: `true`, `false`, `null` and whole numbers become JSON
  values, and `@file` reads the value from a file (`-F body=@gh-work/comment.md`). Numbers and true/false need `-F`:
  `-f line=42` sends the text "42", and an endpoint that wants a number refuses it (422).
- **Lists and nesting**: `-f 'labels[]=bug'` once per item, `key[sub]=value` for an object. Anything deeper, such as
  a list of objects (a review's comments), goes in a JSON file written with your file tools and sent with `--input`;
  fields given alongside `--input` go into the query string.
- **Headers**: `-H 'Accept: application/vnd.github.diff'` returns a PR as a diff, `application/vnd.github.raw` a
  file's plain content. Older examples send `…-preview` Accept headers for features that have since become standard
  (topics needed one once): check the endpoint's current docs before copying one.

## Reading what comes back

- `--jq '<filter>'` runs jq on the answer, with no separate jq needed: `--jq '.[].number'`. A filter with a quoted
  string in it breaks in Windows PowerShell 5.1 (SKILL.md, "Text goes in files").
- `--paginate` fetches every page; each page prints separately, and `--slurp` wraps them in one array. Add
  `per_page=100`, the most GitHub returns at once, to the query string to make fewer requests:
  `'repos/{owner}/{repo}/issues?state=all&per_page=100'`.
- `-i` adds the status line and headers; `--silent` drops the body.

## GraphQL

A few things exist only there, such as resolving a review thread. Keep the query in a file and pass the variables as
fields: `gh api graphql -F query=@gh-work/query.graphql -F owner=cli -F name=cli -F number=123`. Every field other than
`query` and `operationName` becomes a variable. For `--paginate`, the query takes an `$endCursor: String` variable and
asks for `pageInfo { hasNextPage endCursor }` on the list.

## Limits

- A signed-in user gets 5,000 REST requests an hour (60 without signing in). `gh api rate_limit` shows what's left
  without counting against the hour.
- Bursts have their own limits: at most 100 requests running at once, and requests that create content at about 80 a
  minute and 500 an hour. A 403 or 429 that mentions a rate limit means waiting until the time in the `retry-after`
  or `x-ratelimit-reset` header, not retrying in a loop.

## When it fails

gh exits non-zero, prints GitHub's JSON error on stdout and a one-line summary on stderr.

| Status | Usually |
|---|---|
| 401 | Not signed in, or the token expired (`references/auth.md`) |
| 403 | A missing permission or scope (the message names it), or a rate limit |
| 404 | A wrong path, or a private repo the account can't see: GitHub answers 404 rather than admit it exists |
| 409 | A conflict: the branch moved, a merge conflict, an empty repo |
| 422 | Understood but refused: a field of the wrong type, a name that doesn't exist, a review comment on a line outside the diff. The message says which field |
