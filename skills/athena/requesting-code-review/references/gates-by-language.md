# Finding and running the gates

Commands are the same in PowerShell and a POSIX shell unless marked. Checked in November 2026: run against Vitest 5.1,
TypeScript 7.0, Ruff 0.12, Go 1.27 and Cargo 1.96; read in the current docs of the rest (Jest 30, ESLint 10,
golangci-lint 2, gitleaks 8.30).

## The repo's own commands come first

Look in this order, and prefer the repo's command and flags to the generic ones below:

- **CI**: `.github/workflows/*.yml` (the `run:` lines), `.gitlab-ci.yml`, `azure-pipelines.yml`,
  `.circleci/config.yml`, `Jenkinsfile`. What CI runs is what decides whether the change gets in.
- **Task files**: the `"scripts"` in `package.json`; `Makefile`, `justfile`, `Taskfile.yml`; `pyproject.toml`,
  `tox.ini`, `noxfile.py`; `pom.xml`, `build.gradle` or `build.gradle.kts`; then `CONTRIBUTING.md` and the README.
- **Hooks**: `.pre-commit-config.yaml` runs on given files with `pre-commit run --files <files>`; `.husky/` hooks
  usually call `lint-staged`, set up in `package.json`.

`make` is rarely installed on Windows: read the target and run its lines. The lock file names the package manager:
`package-lock.json` npm, `pnpm-lock.yaml` pnpm, `yarn.lock` yarn, `bun.lock` or `bun.lockb` bun; for Python, `uv.lock`
means `uv run <command>`.

## Running them cheaply

- Every command here only checks. The `--write` and `--fix` forms rewrite files, and over the whole project they reach
  files the change never touched.
- Lint and format-check the changed files first: `git diff --name-only --diff-filter=d HEAD` lists them without the
  deleted ones, and `git ls-files --others --exclude-standard` the new ones. Typecheck the whole project, since a
  changed type breaks files the change didn't touch.
- Run the tests nearest the change first (`npx vitest related --run <files>`, `npx jest --findRelatedTests <files>`,
  `go test ./<package>/...`, one pytest file), then the full suite before calling the change ready.
- A long suite may need more than the shell's 300 seconds: raise the limit for that call, or run it in the background
  with its output in a log in the scratch folder.

## The usual commands

| | Tests | Lint | Types | Format check |
|---|---|---|---|---|
| JavaScript, TypeScript | `npm test`, `npx vitest run`, `npx jest --ci` | `npx eslint .` | `npx tsc --noEmit` | `npx prettier --check .` |
| Python | `python -m pytest -q` | `ruff check .` | `python -m mypy .` or `pyright` | `ruff format --check .` or `black --check .` |
| Go | `go test ./...` | `go vet ./...`, `golangci-lint run` | part of the build | `gofmt -l .` |
| Rust | `cargo test` | `cargo clippy --all-targets` | `cargo check` | `cargo fmt --check` |
| .NET | `dotnet test` | warnings from `dotnet build` | `dotnet build` | `dotnet format --verify-no-changes` |
| Java, Maven | `mvn -B test` | `mvn -B verify` runs the checks `pom.xml` sets up | `mvn -B compile` | the formatter plugin's check goal, if set up |
| Java, Gradle | `gradle test` | `gradle check` runs tests and the set-up linters | `gradle compileJava` | the formatter plugin's check task, if set up |

- **Windows PowerShell 5.1**: `npm` and `npx` can stop with "running scripts is disabled on this system", because
  they're `.ps1` shims; `npm.cmd` and `npx.cmd` run the same programs. Use `py -m pytest` when `python` isn't found.
- **Wrappers** pin the build tool's version, so use them when the repo has them: `./gradlew` and `./mvnw` in a POSIX
  shell, `.\gradlew.bat` and `.\mvnw.cmd` in PowerShell.
- A repo on Biome checks with `npx biome ci .`, which reports without changing files.
- `vitest` on its own may stay running to watch for changes; `vitest run` runs once.
- `gofmt -l` exits 0 even when it lists files: the list is the result, and an empty one is a pass. A repo that formats
  through golangci-lint checks with `golangci-lint fmt --diff`.
- `cargo clippy --all-targets -- -D warnings` turns warnings into failures; use it when the repo's CI does.

## When nothing ran

A gate that ran no tests isn't a pass. Read the count of tests run, not only the exit code.

- pytest exits 5 when it collects no tests.
- Vitest and Jest exit 1 when they find no tests, and so do `vitest related` and `jest --findRelatedTests` when nothing
  is related, unless `--passWithNoTests` is set: a repo script with that flag reports green on nothing.
- `go test -run <name>` that matches nothing passes, with `no tests to run`.
- `cargo test <filter>` that matches nothing passes, with `0 passed` and the rest `filtered out`.
- `dotnet test --filter` that matches nothing passes with a warning on the classic runner; on Microsoft.Testing.Platform
  it exits 8.

## Running a gate on the copy of the old code

The copy from `git archive` has the code but none of the installed packages.

- **Python**: run the project's own interpreter (its virtual environment's `python`) from the copy's folder. If the
  project is installed in editable mode, imports can still come from the repo: from the copy,
  `python -c "import <package>; print(<package>.__file__)"` should print a path inside it.
- **JavaScript**: the copy needs its own packages, installed from the lock file (`npm ci`, `pnpm install
  --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`). That downloads them; ask first.
- **Go**: `go test` takes modules from the shared cache, so the copy usually runs without downloading.
- **Rust, .NET, Java**: packages come from the shared caches (`~/.cargo`, `~/.nuget/packages`, `~/.m2`, `~/.gradle`),
  but the copy builds from scratch, as slowly as a clean build.

## Optional scanners

Installing any of these is the user's call. They exit non-zero when they find something, unless noted.

- **gitleaks** (secrets): `gitleaks git --pre-commit --staged --redact --verbose` scans what's staged,
  `gitleaks dir --redact <path>` files on disk, and `gitleaks git --redact` the history. `--redact` keeps the secrets
  it finds out of your log. `detect` and `protect` are the old names.
- **semgrep** (risky code): `semgrep scan --config p/default --metrics off --error`. Adding `--baseline-commit HEAD`
  reports only findings new since HEAD, but it refuses to run while there are unstaged changes. `--config auto` needs
  metrics turned on. On Windows it runs natively, as a beta.
- **bandit** (Python): `bandit -ll <files>` for the changed files, `bandit -r .` for the project; `-ll` shows medium
  severity and up.
- **Dependency audits**, worth a run when a lock file or dependency list changed. They send the package list, not the
  code, to an advisory database, so they need the network: `npm audit` (`--omit=dev` for what ships), `pip-audit` (the
  current environment), `govulncheck ./...`, `cargo audit` (`cargo install cargo-audit`), and
  `dotnet list package --vulnerable --include-transitive` (read its output, not its exit code). `pip-audit -r <file>`
  resolves the list as `pip install -r` would, which can run packages' build code: only on the project's own files.
