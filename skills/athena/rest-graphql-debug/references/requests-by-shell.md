# Probes, three ways

Each probe for curl, for `Invoke-RestMethod` in Windows PowerShell 5.1 (the dashboard's shell) and for Python's
`requests`. Checked in November 2026 against curl's manual (8.x), Microsoft's Invoke-RestMethod pages for 5.1 and 7.6
and requests 2.34; the curl and Python lines were run against a test server.

## Ground rules

- Make the `api-debug` folder in the workspace first (curl's `-o` doesn't create folders); delete it at the end.
- Commands are written for PowerShell. In bash or zsh type `curl` for `curl.exe`, `$API_TOKEN` for `$env:API_TOKEN`
  and `/dev/null` for `NUL`.
- Write JSON bodies and Python probes as UTF-8 files with your file tools: Windows PowerShell 5.1 strips the double
  quotes inside arguments to programs, and its `>` and `Set-Content` write UTF-16 or ANSI. Quote
  `'@api-debug/body.json'`, since a bare leading `@` means something else to PowerShell.
- The time limits (in seconds) are examples: set them a little above what's normal for the API.

## Status, response headers and body

```
curl.exe -sS -D - -o api-debug/body.txt --max-time 30 -H "Authorization: Bearer $env:API_TOKEN" https://api.example.com/v1/me
```

`-D -` prints the status line and response headers, `-o` keeps the body byte for byte, `-sS` hides the progress meter
but not errors. curl exits 0 for a 4xx or 5xx answer too; other codes mean no answer: 6 name not resolved, 7 no
connection, 28 time limit, 35 TLS handshake failed, 52 empty reply, 60 certificate not trusted.

```powershell
try {
  Invoke-RestMethod -Uri https://api.example.com/v1/me -Headers @{ Authorization = "Bearer $env:API_TOKEN" } -TimeoutSec 30 -UseBasicParsing | ConvertTo-Json -Depth 10
} catch {
  $r = $_.Exception.Response
  if ($r) { "HTTP $([int]$r.StatusCode)"; $r.Headers.ToString() }
  if ($_.ErrorDetails.Message) { $_.ErrorDetails.Message }
  elseif ($r) { (New-Object System.IO.StreamReader($r.GetResponseStream())).ReadToEnd() }
  else { $_.Exception.Message }
}
```

On success it returns only the parsed body (`ConvertTo-Json` shows two levels without `-Depth`); a 4xx or 5xx throws,
and the `catch` prints the status, headers and error body. `-TimeoutSec` defaults to 0, which waits forever.
PowerShell 7 can drop the `catch` with `-SkipHttpErrorCheck -StatusCodeVariable code -ResponseHeadersVariable hdrs`.
If 5.1 says "Could not create SSL/TLS secure channel" to a server that works elsewhere, its .NET settings offer only
old TLS versions: begin the same command with this line (it lasts for that one process), or use curl.exe.

```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
```

```python
import os, requests

r = requests.get("https://api.example.com/v1/me", timeout=(5, 30),  # (connect, read) in seconds
                 headers={"Authorization": f"Bearer {os.environ['API_TOKEN']}"})
print(r.status_code, r.reason, "headers after", r.elapsed.total_seconds(), "s")
for name in ("content-type", "www-authenticate", "retry-after", "location", "x-request-id"):
    if name in r.headers:
        print(f"{name}: {r.headers[name]}")
print(r.text[:2000])
```

Save it as `api-debug/probe.py` and run `python api-debug/probe.py`. Without `timeout=` it can wait forever;
`requests.exceptions.ConnectTimeout` means no connection was made, `ReadTimeout` that the server never answered.

## Where the time goes

```
curl.exe -sS -o NUL --max-time 60 -w 'dns %{time_namelookup}  connect %{time_connect}  tls %{time_appconnect}  first byte %{time_starttransfer}  total %{time_total}  HTTP %{http_code}\n' https://api.example.com/v1/health
```

Each figure counts from the start: connect minus dns is the network, tls minus connect the handshake (0 on plain
http), first byte minus tls mostly the server's work, total minus first byte the download. Run it a few times; one
sample is noise. Invoke-RestMethod has no breakdown, only a total from `Measure-Command { … }`.

## A JSON body

```
curl.exe -sS -D - --max-time 30 -H "Content-Type: application/json" -H "Authorization: Bearer $env:API_TOKEN" --data-binary '@api-debug/body.json' https://api.example.com/v1/orders
```

`--data-binary` sends the file's bytes unchanged (`-d @file` drops line breaks) as a POST; add `-X PUT` or `-X PATCH`
for those. Without the Content-Type header curl labels the body as a form.

```powershell
Invoke-RestMethod -Method Post -Uri https://api.example.com/v1/orders -InFile api-debug/body.json -ContentType 'application/json; charset=utf-8' -Headers @{ Authorization = "Bearer $env:API_TOKEN" } -TimeoutSec 30 -UseBasicParsing
```

`-InFile` sends the file as it is. Without `-ContentType`, 5.1 sends a POST as a form; a string `-Body` isn't sent as
UTF-8 unless the content type says `charset=utf-8` (PowerShell 7.4 and later default to UTF-8).

In Python, `json=payload` serializes the body and labels it. `data=` with a dict sends a form (`a=1&b=2`) even under
a JSON header, and `data=` with a string sends no Content-Type. `r.request.headers` and `r.request.body` show what went.

For GraphQL the body file holds the operation and its values, such as
`{"query": "query User($id: ID!) { user(id: $id) { name } }", "variables": {"id": "42"}}`.

## Is it the certificate?

Saved as `api-debug/tls_check.py` and run as `python api-debug/tls_check.py api.example.com`, this prints the TLS
version, expiry and issuer, or why the certificate was refused ("certificate has expired", "Hostname mismatch",
"self-signed certificate", "unable to get local issuer certificate"), the same on every system.

```python
import socket, ssl, sys

host = sys.argv[1]
try:
    with socket.create_connection((host, 443), timeout=10) as sock:
        with ssl.create_default_context().wrap_socket(sock, server_hostname=host) as tls:
            cert = tls.getpeercert()
            issuer = dict(item[0] for item in cert["issuer"])
            print(tls.version(), "| valid until", cert["notAfter"], "| issued by", issuer.get("organizationName"))
except ssl.SSLCertVerificationError as e:
    print("certificate refused:", e.verify_message)
except OSError as e:
    print("no TLS connection:", e)
```

"Unable to get local issuer certificate" while a browser is happy has two usual causes. The server doesn't send its
intermediate certificate (browsers fetch it themselves; the API's owner has to fix it). Or a company proxy re-signs
traffic with its own root, which Windows trusts and `requests` doesn't: Python's `ssl` reads Windows' store, but
`requests` uses its own bundle (certifi). Point `REQUESTS_CA_BUNDLE` at a file that includes that root, or install
`truststore` (the user's call) and call `truststore.inject_into_ssl()` before any request.

## A JWT's claims

Decoding shows the claims without checking the signature, and the token stays on the machine:

```python
import base64, json, os, time

part = os.environ["API_TOKEN"].split(".")[1]
claims = json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))
print({k: claims[k] for k in ("iss", "aud", "scope", "scp", "exp", "nbf") if k in claims})
if "exp" in claims:  # seconds since 1970, UTC; a wrong clock on this machine skews the answer
    left = round(claims["exp"] - time.time())
    print(f"expires in {left} s" if left > 0 else f"expired {-left} s ago")
```

## Every page

In `requests`, `r.links["next"]["url"]` reads a `Link: <…>; rel="next"` header, and `r.links` is empty when there is
none. A cursor in the body goes back as a query parameter, under the names the API's docs give.
