How to write a Dockerfile, or review one, so it builds fast, ships small and runs safely. Checked in November 2026:
Node 26 is the LTS line (Node 20 reached end of life in April 2026), Python 3.15 is the newest release, and
PostgreSQL 18 the newest stable major. Look up an image's current tags on Docker Hub, or in `library/<image>` of the
`docker-library/official-images` repository, before you pin one.

## The review, biggest payoff first

1. **A `.dockerignore`.** Without one, `COPY . .` sends `.git`, dependency folders, logs and `.env` to the builder,
   bakes the secrets into the image, and any change to those files throws away the cache.
2. **Dependencies before source.** Copy only the manifest and lock file (`package.json` and `package-lock.json`,
   `requirements.txt`, `pyproject.toml` and its lock, `go.mod` and `go.sum`), install, then copy the rest. A step's
   cache holds until something it copies changes, so an edit to the code no longer reinstalls every package.
3. **Several stages.** Compilers, dev dependencies and source stay in a build stage; the final stage gets only what
   runs (built files, a virtual environment, a binary).
4. **A pinned, supported base.** A version, not `latest`: `node:26-slim` rather than `node`. Prefer `-slim` (Debian)
   to `-alpine` unless the project is known to work there: Alpine's C library is musl, so Python wheels and Node
   native modules built for glibc fail or compile from source. To make builds repeat exactly, pin the digest as well
   (`node:26-slim@sha256:…`) and let Renovate or Dependabot move it forward.
5. **A non-root `USER`** in the final stage. Node's official images have a `node` user; Python's run as root, so
   create one. A folder the app writes to belongs to that user (`COPY --chown`) or is a volume.
6. **`CMD` and `ENTRYPOINT` in JSON form**, `CMD ["node", "server.js"]`. The plain form runs the program under
   `/bin/sh -c`, which doesn't pass signals on, so `docker stop` waits out its grace period (10 seconds for Linux
   containers) and then kills it. Start the program itself, not through `npm start`. One that leaves zombie child
   processes behind gets `--init` (`init: true` in Compose).
7. **No secrets in `ARG`, `ENV` or copied files.** They stay in the image's layers and in `docker history --no-trunc`
   even when a later step deletes them. Build-time secrets use a secret mount (below); run-time ones come from the
   environment or Compose when the container starts.
8. **Package installs in one `RUN`**: `apt-get update`, `apt-get install -y --no-install-recommends …` and
   `rm -rf /var/lib/apt/lists/*` together. A separate `update` step is cached, so a later install reads a stale
   index; why the clean-up shares the step is under "What makes an image big".
9. **`docker build --check .`** runs Docker's own lint rules (plain-form `CMD`, secrets in `ARG` or `ENV`, copying an
   ignored file, undefined variables) without building. It needs the engine running.

Report findings with their line numbers, biggest first, each with the fix and why. Change the file only as far as the
user asked (one outside Git gets a backup copy first), and leave the project's own choices (entry file, port, build
script) as they are: read them from `package.json`, `pyproject.toml` or the README rather than guessing.

## Node

```dockerfile
# syntax=docker/dockerfile:1
FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

One install serves both stages: the build stage installs everything, builds, then drops the dev dependencies before
the final stage copies `node_modules`. `dist/server.js` and port 3000 stand in for the project's own.

## Python

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.14-slim AS build
WORKDIR /src
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
COPY requirements.txt .
RUN --mount=type=cache,target=/root/.cache/pip pip install -r requirements.txt

FROM python:3.14-slim
ENV PATH="/opt/venv/bin:$PATH" PYTHONUNBUFFERED=1
RUN useradd --create-home app
COPY --from=build /opt/venv /opt/venv
WORKDIR /app
COPY . .
USER app
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Use the Python version the project already runs on (`requires-python` in `pyproject.toml`, or `.python-version`); both
stages must use the same image, since the virtual environment points at its Python. Packages that compile get their
compilers installed in the build stage only.

## A starting `.dockerignore`

```
.git
.env
*.log
node_modules
.venv
__pycache__
dist
docker-work
docker-backup
```

`dist` belongs here when the image builds it, as above; leave it out when the image copies a build made outside.
`docker-work` and `docker-backup` are the skill's own scratch and backup folders.

## Cache and secret mounts

BuildKit has been Docker's default builder since Engine 23, so `DOCKER_BUILDKIT=1` is old advice. Its cache mounts
(`RUN --mount=type=cache,target=…`, as in both files above) keep the package manager's download cache between builds
without putting it in the image. A secret mount gives one step a file that never reaches a layer, such as an `.npmrc`
with a private registry token:

```dockerfile
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

```
docker build --secret id=npmrc,src=.npmrc -t <name> .
```

Without `target` the secret is at `/run/secrets/<id>`; `env=<VARIABLE>` instead hands it over as a variable for that
one step.

## Healthchecks without curl

Slim images have no `curl` or `wget`. Use the runtime that's already there, aimed at a page the app really serves
(one `HEALTHCHECK` per image):

```dockerfile
HEALTHCHECK CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3)"]
HEALTHCHECK CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
```

`urlopen` raises on an error status or a refused connection, so the check fails when it should.

## Scripts from Windows

- **Line endings.** Git on Windows can check shell scripts out with Windows line endings, which Linux can't run. A
  `.gitattributes` line `*.sh text eol=lf` stops that for future checkouts; the file already on disk is converted in
  the editor (its line-ending setting) or by a fresh checkout, with the user's agreement.
- **The executable bit** doesn't survive a Windows checkout: `COPY --chmod=755 entrypoint.sh /usr/local/bin/` sets it
  in the image.

## Another CPU

An image built on Apple Silicon is arm64, and most servers are amd64. `docker build --platform linux/amd64 -t <name> .`
builds for them under emulation, which is slower. `docker image inspect --format "{{.Os}}/{{.Architecture}}" <image>`
says which one an image is.

## What makes an image big

`docker history <image>` lists every layer with its size and the step that made it; the big one says what to move into
a build stage or add to `.dockerignore`. A file deleted in a later step still weighs what it did in the layer that
added it, so clean up in the same `RUN`, or leave the mess in a build stage.
