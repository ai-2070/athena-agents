---
name: Docker
description: Use for Docker and Docker Compose work, such as "my container keeps exiting", "port is already allocated", "free up Docker disk space", "write a Dockerfile", a compose.yaml that won't start, or images, volumes and logs. Looks first, asks before deleting data, checks every change.
---

Most Docker trouble shows itself quickly once you look in the right place: a container's exit code and the last lines
of its log, what already holds a port, which volume a database really writes to. Good work reads those first and shows
the user what it found **before changing anything**. It deletes nothing that holds data unless the user said yes to
that exact thing, because a volume or a container can hold the only copy of a database. And it checks each change the
way the user will meet it: the container stays up, the log is clean, the port answers. To write or review a
Dockerfile, read `references/dockerfile-review.md` first.

## What deletes data

Cleanup in Docker is quick, quiet and final. Before any of these, list what would go, tell the user what it holds as
far as you can tell, and wait for a yes to that list:

| What goes for good | Commands | See it first with |
|---|---|---|
| Named volumes: databases, uploads | `docker volume rm`, `docker volume prune -a`, `docker compose down -v` | `docker volume ls`, `docker volume ls --filter dangling=true` |
| Anonymous volumes | `docker volume prune`, `docker system prune --volumes` | the same |
| Files a container wrote outside any volume | `docker rm -f`, `docker compose down`, `docker container prune`, `docker system prune` | `docker ps -a`, `docker diff <container>` |
| Images and build cache (they come back by download or rebuild) | `docker image prune -a`, `docker system prune -a`, `docker builder prune` | `docker system df -v` |

- Since Engine 23 a plain `volume prune` (and `system prune --volumes`) takes only anonymous volumes; `-a` adds every
  named volume no container uses, such as the database of a stack someone took down with `compose down`.
- `system prune` takes every stopped container, not only old ones. `compose down` deletes a stack's containers, and
  `up` after a change to the file recreates them: either way, the files they kept outside a volume are gone.
- Only the `prune` commands ask "y/N", and here the question reads nothing, so they cancel and still exit 0: once the
  user has agreed, add `-f` and check with the listing that it ran. `rm`, `volume rm` and `down -v` don't ask at all.
- When the data matters, back it up first into a `docker-backup` folder you create in the workspace, and tell the
  user where. A volume nothing is writing to (its full name from `docker volume ls`; Compose adds the project's):
  `docker run --rm -v <volume>:/from:ro -v "${PWD}/docker-backup:/to" alpine tar -czf /to/<volume>.tgz -C /from .`
  A running database is dumped by its own tool inside the container, then copied out (PowerShell 5.1's `>` would
  write UTF-16): `docker exec <db> pg_dump -U <user> -d <db> -Fc -f /tmp/db.dump`, then
  `docker cp <db>:/tmp/db.dump docker-backup/`.
- Pushing an image publishes it, and a registry sign-in stores a credential: ask first for both.

## Before you start

- **Is the engine running?** `docker version` prints a Server section only when it is. On Windows (over WSL 2) and
  macOS that's Docker Desktop: `docker desktop start` in recent versions, or open the app, and tell the user, as it
  takes a lot of memory. On Linux, `sudo systemctl start docker` and joining the `docker` group (root-equivalent) are
  for the user to run. Compose is `docker compose`, built in.
- **The shell can't answer questions** and stops long commands. No `-it`, `exec -it`, `attach` or `logs -f`: read logs
  with `--tail` and `--since`, and `exec` without `-it` runs one command. Start servers with `-d`, stacks with
  `up -d`, and raise the time limit for the one call when a first build or a large pull needs it.
- **Registry sign-in** takes the token on stdin from a variable or file the user sets, never in the command:
  `$env:REGISTRY_TOKEN | docker login ghcr.io -u <user> --password-stdin` (PowerShell), or
  `printf '%s' "$REGISTRY_TOKEN" | docker login …` (POSIX).
- **Windows.** The current folder is `"${PWD}"`, which POSIX shells read too; `$(pwd)` is bash. There's no `grep`, so
  narrow with Docker's own `--filter` and `--format`. Compose files take relative paths (`./src`) on every system.
- **Scratch work** (a probe compose file, saved logs) goes in a `docker-work` folder in the workspace, deleted before
  you report. Ports, image names, registries and passwords the user hasn't given are asked for, not made up.

## Look first

```
docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
docker logs --tail 80 --timestamps <container>
docker inspect --format "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} restarts={{.RestartCount}}" <container>
docker compose logs --tail 80 --no-color <service>
docker system df -v
```

Exit codes: 0, the main process ended (a server that puts itself in the background ends the container); 1, the app
failed; 125, Docker couldn't create the container; 126, the command can't run; 127, it wasn't found; 137, killed
(`oom=true`: out of memory); 143, stopped by SIGTERM. For a fault in the app's own code, use `systematic-debugging`.

## Common problems

- **Exits at once.** After the log and exit code, look inside the image without starting the app:
  `docker run --rm --entrypoint sh <image> -c "ls -la /app; head -5 /app/entrypoint.sh"` (Compose:
  `docker compose run --rm --no-deps --entrypoint sh <service> -c "…"`). "exec …: no such file or directory" for a
  script that's there means Windows line endings or a shell the image lacks (`bash` on Alpine); "exec format error",
  an image built for another CPU (Apple Silicon is arm64, most servers amd64).
- **"Port is already allocated".** Find the holder: `docker ps --filter publish=8080`; on Windows
  `Get-NetTCPConnection -LocalPort 8080 -State Listen`, then `Get-Process -Id <OwningProcess>`; on macOS and Linux
  `lsof -nP -iTCP:8080 -sTCP:LISTEN`. Offer another host port (`-p 8081:80`) rather than stop the user's program. A
  Windows "access permissions" error is a reserved range: `netsh interface ipv4 show excludedportrange protocol=tcp`.
- **Published, but nothing answers.** The app listens on 127.0.0.1 inside the container, which only the container can
  reach; it needs 0.0.0.0 (`--host 0.0.0.0` for uvicorn and `flask run`, `--host` for Vite). Its start-up line in the
  log usually shows the address; `docker port <container>` shows the mapping.
- **Services can't reach each other.** In a container `localhost` is that container. Compose services find each other
  by service name (`db:5432`), no published port needed; a container reaches the host as `host.docker.internal` (on
  Linux, add `--add-host=host.docker.internal:host-gateway`).
- **Permission denied on a mounted folder** (mostly on Linux). Files keep their numeric owner: compare
  `docker exec <container> id` with `ls -ln <folder>`, then run as the host user (`--user "$(id -u):$(id -g)"`, or
  `user:` in Compose) or have the user change the owner. A named volume usually avoids it.
- **A Python app logs nothing**: without a terminal it buffers its output. Set `PYTHONUNBUFFERED=1`.
- **Code changes don't show**: an image keeps the code it was built with. `docker compose up -d --build`.
- **Disk full.** `docker system df -v` first: build cache is often the biggest share, and costs only rebuild time.

## A Compose stack

An API and Postgres, the API starting only once the database answers. The password sits in a `.env` file beside
`compose.yaml` (`POSTGRES_PASSWORD=…`) that `.gitignore` and `.dockerignore` list; `:?` stops Compose with that
message when it's missing, and `$$` leaves a variable for the container's shell, so each name is written once.

```yaml
services:
  api:
    build: .
    ports:
      - "127.0.0.1:3000:3000"        # reachable from this computer only
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD:?put POSTGRES_PASSWORD in .env}@db:5432/app
    depends_on:
      db:
        condition: service_healthy   # waits until Postgres answers, not only until it starts
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_DB: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?put POSTGRES_PASSWORD in .env}
    volumes:
      - pgdata:/var/lib/postgresql   # 18 and later; 17 and earlier mount /var/lib/postgresql/data
    healthcheck:                     # over TCP: the setup server on first start listens only on a socket
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      retries: 10
volumes:
  pgdata:
```

`docker compose config --quiet` checks the file and its variables (without `--quiet` it prints them, passwords too).
In the URL, a password with `@`, `:` or `/` must be percent-encoded.

## Done means

- `docker compose up -d --wait` returned 0 (every service running, and healthy where it has a check), or `docker ps`
  shows `Up`, `(healthy)` where there's a check, and a restart count that hasn't moved when you look again.
- The log since the change has no errors, and the app answers from the host:
  `curl.exe -sS -i http://localhost:3000/` in PowerShell, `curl -sS -i http://localhost:3000/` elsewhere.
- After a cleanup, `docker system df` again, with the space freed and what was removed in your report.
- Probe containers were run with `--rm` or removed, and `docker-work` is gone. Backups stay, and you say where.

## Watch out for

- Postgres 18 images keep data in `/var/lib/postgresql/18/docker` and declare the volume at `/var/lib/postgresql`. An
  old `…/data` mount makes 18 refuse to start, which protects the data: it's no reason to delete the volume. A major
  upgrade is a dump and restore (or `pg_upgrade`) into a new volume, and the old one stays until the restore checks
  out. Any volume mounted where the program doesn't write leaves the real data somewhere the next cleanup takes.
- Anything changed with `docker exec` (a package installed, a config edited) vanishes when the container is
  recreated. Put it in the Dockerfile, the Compose file or a volume.
- `-p 8080:80` listens on every network the machine is on, and on Linux Docker's own rules get past ufw. Publish on
  `127.0.0.1:8080:80` unless other machines should reach it.

## Files

- `references/dockerfile-review.md`: the review list, worked multi-stage files for Node and Python, `.dockerignore`,
  cache and secret mounts, healthchecks, line endings, CPU platforms, image size. Open it for any Dockerfile work.
