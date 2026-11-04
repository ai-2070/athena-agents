# Reading Reddit

Checked in November 2026: Reddit's `.rss` addresses answered without an account, and its `.json` ones were refused
(HTTP 403) from the same machine.

## Which route

- **An account is connected** (Settings › Connections › Reddit accounts): use the dashboard's own Reddit tools. They
  read a subreddit (hot, new, top this week, rising), search the last month, and read a post with its top comments,
  with scores and comment counts, under the account's more generous limits.
- **No account, or the tools don't cover it**: `feeds.py reddit`, through Reddit's public feeds. No scores and no
  reply structure, but the full text of posts and comments, any time period for search and top posts, a user's posts
  and comments, and up to 100 items a call. Without an account the dashboard's tools try Reddit's public JSON, which
  Reddit now refuses from many addresses; when they fail that way, switch to the feeds rather than retrying.
- **Connecting an account** is the user's decision and takes their own Reddit app. Since November 2025 Reddit reviews
  new apps before they can use its API, which can take days (the Connections page says so), so don't suggest it for
  a one-off question. Never ask for a Reddit password or browser cookies, and don't sign in to Reddit in a browser.

## The limit, and planning calls

Without an account Reddit allows about one request a minute from one address: after a single request its
`x-ratelimit-remaining` header drops to 0, and `x-ratelimit-reset` gives the seconds until the next is allowed. Each
`feeds.py reddit` command makes one request. On a 429 it waits the seconds Reddit names (up to 90) and tries once
more; a second refusal stops it with exit 2. When the limit is used up, the result's `next_call_waits` says for how
long, and `waited_seconds` shows a wait that already happened.

So plan before calling. Most questions need three to five calls: one search in the right subreddit instead of
several listings, then the two or three threads that matter, rather than every title. If a task needs many more
(watching several subreddits all day, say), tell the user what it costs and ask whether they'd like to connect an
account. Never retry in a loop, run calls in parallel, go through a proxy or another service, or change the user
agent to get past the limit: that is getting around Reddit's protections.

## Commands

Every command takes `--chars N` (text kept per item: 500 by default, 4000 in a thread; 0 for none) and `--timeout`.

```
python <skill folder>/scripts/feeds.py reddit sub LocalLLaMA --sort top --time week --limit 10
python <skill folder>/scripts/feeds.py reddit search 'quantized models' --sub LocalLLaMA --sort new
python <skill folder>/scripts/feeds.py reddit search 'standing desk' --sort top --time year --limit 15
python <skill folder>/scripts/feeds.py reddit thread 'https://www.reddit.com/r/LocalLLaMA/comments/1xn568h/some_title/'
python <skill folder>/scripts/feeds.py reddit user spez --only posts --limit 5
```

- `sub NAME`: `--sort hot|new|top|rising` (default hot), `--time hour|day|week|month|year|all` for top (default
  week), `--limit` up to 100 (default 25). `r/` in front of the name is fine, and `a+b` reads two at once.
- `search QUERY`: all of Reddit, or one subreddit with `--sub`. `--sort relevance|hot|top|new|comments` (default
  relevance), `--time` (default all), `--limit` up to 100. Site-wide results can include subreddits whose names match;
  they come apart as `subreddits_found`.
- `thread ADDRESS`: the post and its comments, from a full thread address, `redd.it/<id>`, or a comment's address
  (that comment and the replies under it). `--limit` comments (default 100); `--top-level` for only the replies to
  the post itself. A `/s/` share link has to be opened first: ask the user for the address it leads to.
- `user NAME`: `--only all|posts|comments` (default all), `--limit` up to 100.

Listings give `items`, each with `kind` (`post` or `comment`), `title` (or `on`, the post a comment is on), `link`
(the permalink), `date`, `author`, `subreddit`, `text`, `text_chars`, and `outside_link` when a post links somewhere
else. `thread` gives `post` and `comments`, in Reddit's order (a pinned moderator or bot comment can come first);
replies are included, but the feed doesn't say which comment each one answers. A misspelt, private or banned
subreddit or user is an HTTP 404 or 403.

A subreddit's feed can also go in a digest list (`https://www.reddit.com/r/<name>/new/.rss`), read by `feeds.py read`
like any other feed. Keep Reddit feeds in a list to one or two: each one after the first waits out the limit.

## Reading it well

- **Titles aren't the discussion.** For "what are people saying", read the threads, not just the listing. Balance the
  loudest with the recent: top of the month plus new, or more than one subreddit when the topic spans them.
- **Reddit shows what users report, not what is true.** Attribute ("one commenter who says they run it on two cards
  reports…"), say roughly how many agree and disagree, and mark claims that need checking against a better source
  before anyone relies on them. A few threads are not a survey; say how much you read. Skip AutoModerator and bot
  comments, and notice self-promotion.
- **Cite the permalink** of the post or comment you draw on (its `link`), and a link post's `outside_link` as the
  original source. `grounded-citations` keeps the sources of a report straight.
- **Quote sparingly** and only what people wrote publicly; leave out usernames when the point doesn't need them.

Posting and commenting are not part of this skill: the dashboard's Reddit drafts wait in the Outbox for the user's
approval.
