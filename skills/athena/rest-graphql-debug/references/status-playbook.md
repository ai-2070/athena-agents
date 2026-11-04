# What a status code points to

Read the body before the code: most APIs name the problem. Some use `application/problem+json` (RFC 9457), with
`type`, `title`, `status`, `detail` and sometimes `instance`; others have their own `error` or `message` fields. An
HTML body came from something in front of the API (a gateway, a CDN, a login page), so its status may say nothing
about the API itself. Headers that explain: `WWW-Authenticate` on 401, `Allow` on 405, `Retry-After` on 429 and 503,
`Location` on a redirect, and the request id.

## The request or your rights (4xx)

- **400 Bad Request**: the server couldn't read it. JSON that doesn't parse (quotes lost to PowerShell, a trailing
  comma), a missing or misspelt parameter, an unencoded `&` or space in the query. Compare the bytes sent with the
  docs' example.
- **401 Unauthorized**: no valid credentials. The server has to name the scheme it wants in `WWW-Authenticate`, often
  with a reason (`error="invalid_token"`). Check that the header really went and survived any redirect, the scheme
  (`Bearer`, `Basic`, `Token` or a key header), expiry (a JWT's `exp`), that the key is for this environment (test or
  live, staging or production) and this account, and the clock, for signed requests.
- **403 Forbidden**: the server knows who you are and refuses. Scopes or role, a plan without the feature, a resource
  owned by another account or organisation, an IP allow-list. An HTML 403 is often a firewall or bot check: don't try
  to get round it; tell the user. The same credentials won't do better on a second try.
- **404 Not Found**: a typo in the path, a missing version prefix, a trailing slash, the wrong base URL, an id from
  another environment. Or a resource that exists but these credentials may not see: HTTP lets a server answer 404
  instead of 403 to hide that it exists, so when the id is right, check permissions too.
- **405 Method Not Allowed**: the `Allow` header lists the methods that work. A POST that a redirect turned into a GET
  ends up here.
- **406 Not Acceptable, 415 Unsupported Media Type**: the server can't produce what `Accept` asks for, or can't read
  the body's `Content-Type` (JSON labelled as a form or the reverse, or no label).
- **409 Conflict**: the resource's state blocks the change: a duplicate of a unique field, an edit racing another, or
  an idempotency key reused while the first request is still running. Fetch the current state before deciding.
- **412 Precondition Failed, 428 Precondition Required**: the `If-Match` version is stale, or the server wants one.
  Fetch again, reapply the change and send it with the new `ETag`.
- **413 Content Too Large**: the body is over the server's limit. The docs give it; big uploads often have their own
  endpoint.
- **422 Unprocessable Content**: the body parsed but the values are wrong, and the error usually names the fields.
  Check types (`"42"` against `42`), formats (dates, time zones, amounts in cents or units), allowed values and
  required fields; or an idempotency key reused with a different body.
- **429 Too Many Requests**: wait and retry (below). Some APIs also send `X-RateLimit-*` headers, or `RateLimit` and
  `RateLimit-Policy` (an IETF draft); whether "reset" is a clock time or a number of seconds, their docs say.

## The server or something in front of it (5xx)

- **500 Internal Server Error**: a fault on the server, often set off by one input it didn't check. Shrink the request
  a field at a time to find it. If the server is the user's own, its log for that request id has the stack trace.
- **502 Bad Gateway, 504 Gateway Timeout**: a proxy, load balancer or CDN got a bad answer, or none in time, from the
  app behind it, and the body is the proxy's page. For a 504 on heavy work, ask for smaller pages or use the API's
  background-job endpoint if it has one.
- **503 Service Unavailable**: overloaded or under maintenance. Check the provider's status page and `Retry-After`.
- Retry a 5xx only for requests that are safe to repeat (GET and HEAD) or carry an idempotency key.

## Waiting and retrying

`Retry-After` is either a number of seconds or an HTTP date (RFC 9110), so read both. Without it, back off
exponentially with random jitter, so many clients don't return at the same moment. This retries a GET; the 1-second
start and 60-second cap are common defaults, and the provider's docs may ask for others.

```python
import random, time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests


def retry_after_seconds(value):
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def get_with_backoff(url, attempts=5, base=1.0, cap=60.0, **kwargs):
    for attempt in range(attempts):
        r = requests.get(url, timeout=(5, 30), **kwargs)
        if r.status_code not in (429, 503) or attempt == attempts - 1:
            return r
        wait = retry_after_seconds(r.headers.get("Retry-After"))
        if wait is None:
            wait = random.uniform(0, min(cap, base * 2 ** attempt))  # exponential, full jitter
        else:
            wait += random.uniform(0, base)
        time.sleep(wait)
```

## Request ids and the report to the provider

Answers often carry an id for the request: `X-Request-Id`, `Request-Id`, `CF-Ray` (Cloudflare's) or a header the
provider's docs name. With it, the provider can find the request in their logs. A report to them has the method and
endpoint, the time in UTC, the request id, the status and body received against what was expected, and a minimal
reproduction with `<API_TOKEN>` where the credentials were.

## When the API is yours

- Error bodies hold no stack traces, file paths, SQL, internal host names, or the caller's token echoed back.
- "Doesn't exist" and "not yours" both answer 404, so nobody can find out which ids exist by trying them.
- A 401 carries `WWW-Authenticate`, a 429 or 503 carries `Retry-After`, and every error uses one format
  (`application/problem+json` fits).
- Every answer carries a request id that's also in the log.
