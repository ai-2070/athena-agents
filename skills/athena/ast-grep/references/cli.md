# Commands, output and languages

Checked against the `--help` of ast-grep 0.51.1 and runs of it. `ast-grep --help` and `ast-grep <command> --help` show
what an installed version has.

## Commands

| Command            | For                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `ast-grep run`     | One pattern: search, or rewrite with `-r`. The default command: `ast-grep -p …` is the same                           |
| `ast-grep scan`    | Rule files: `--rule <file>`, or every rule of the project's `sgconfig.yml`                                            |
| `ast-grep test`    | The project's rule tests (`references/rules.md`)                                                                      |
| `ast-grep outline` | A map of files: functions, classes, members, imports, exports (0.44+). A quick look at a folder before searching      |
| `ast-grep new`     | Scaffolding for projects, rules and tests; it writes absolute paths into `sgconfig.yml`. Also `lsp` and `completions` |

## `run`

| Option                 | What it does                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `-p, --pattern <code>` | The pattern                                                                                               |
| `-r, --rewrite <code>` | The replacement; without `-U` it only prints the diff                                                     |
| `-U, --update-all`     | Write the rewrites. Ignored when `--json` is given                                                        |
| `-l, --lang <lang>`    | The pattern's language; needed with `--debug-query` and `--stdin`                                         |
| `--selector <kind>`    | Match only this node inside the parsed pattern (the pattern is then the context)                          |
| `-k, --kind <kind>`    | Match nodes of a kind with no pattern (0.43+); takes the CSS-like selectors in `rules.md`                 |
| `--strictness <level>` | `cst`, `smart` (default), `ast`, `relaxed`, `signature`, `template`                                       |
| `--debug-query=<view>` | Print how the pattern was read: `pattern` (the default), `ast`, `cst`, `sexp`. Write the `=`              |
| `--files-with-matches` | Only the paths that match (0.40.4+); not with `--json`, `-U` or `-i`                                      |
| `--json=<style>`       | `stream` (one match per line), `compact` (one line), `pretty` (the default). Write the `=`                |
| `--globs <glob>`       | Include, or exclude with a leading `!`; repeatable, the later one wins                                    |
| `--no-ignore <kind>`   | Also search what's normally skipped: `hidden`, `vcs` (`.gitignore`), `dot`, `exclude`, `global`, `parent` |
| `-A`, `-B`, `-C <n>`   | Lines of context after, before, around each match                                                         |
| `--inspect summary`    | On stderr: how many files were scanned and skipped (`entity` gives each file and why)                     |
| `-i`                   | Interactive review: it waits for a person at each change, so it hangs in a shell tool                     |
| `--stdin`              | Read the code from a pipe (needs `--lang`); a sample file in the work folder is easier to rerun           |

Paths default to the current folder. Files listed in `.gitignore` and hidden files are skipped; a path named on the
command line is searched anyway.

## `scan`

Takes the file options of `run` (`--globs`, `--no-ignore`, `-C`, `--json`, `-U`, `--files-with-matches`) plus:

| Option                                              | What it does                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `-r, --rule <file>`                                 | Run one rule file, no project needed                                                                                          |
| `--inline-rules <yaml>`                             | Rules as text, `---` between them; not with `--rule`                                                                          |
| `--filter <regex>`                                  | Only the project's rules whose id matches; not with `--rule`                                                                  |
| `--report-style <style>`                            | `rich` (default, with code and the fix's diff), `medium`, `short` (`file:line:col: severity[id]: message`); not with `--json` |
| `--format github` / `sarif`                         | GitHub Actions annotations, or a SARIF report                                                                                 |
| `--error`, `--warning`, `--info`, `--hint`, `--off` | Change rules' severity for this run: all of them, or one with `=<id>` (repeat for more)                                       |
| `--min-severity <level>`                            | Skip rules below this severity                                                                                                |
| `--max-results <n>`                                 | Stop after this many matches                                                                                                  |

## `test`

`--skip-snapshot-tests` (check valid and invalid cases only), `-U` (save snapshots), `-f, --filter <regex>` (some
rules), `-t, --test-dir`, `--snapshot-dir`, `--include-off` (also test rules with `severity: off`). `-i` is interactive.

## JSON output

Each match is an object with:

- `file`, `language`, `text` (the matched code) and `lines` (the whole lines it's on);
- `range.start` and `range.end`, each with `line` and `column` counted from 0 (add 1 to the line for what an editor
  shows), and `byteOffset`;
- `replacement` when there's a rewrite;
- `metaVariables.single.<NAME>.text` for each `$NAME`, and `metaVariables.multi.<NAME>` as a list of nodes for each
  `$$$NAME`;
- from `scan`, also `ruleId`, `severity`, `message`, `note` and `labels`.

## Exit codes

| Code | `run`                                                                                            | `scan`                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 0    | Something matched (or was rewritten); also a pattern that didn't parse, with a warning on stderr | Done, whether or not anything matched, unless an error-level rule did; also a missing path, with an `ERROR:` line |
| 1    | Nothing matched, or a path doesn't exist (an `ERROR:` line on stderr)                            | A rule with `severity: error` matched                                                                             |
| 2    | A bad or conflicting option                                                                      | The same                                                                                                          |

Other codes mean a pattern, rule or config couldn't be loaded: the reason is on stderr. `ast-grep test` exits non-zero
when a test fails.

## Languages

The `--lang` and `language:` names in 0.51.1: `bash`, `c`, `cpp` (also `cc`, `c++`, `cxx`), `csharp` (`cs`), `css`,
`elixir` (`ex`), `go` (`golang`), `haskell` (`hs`), `hcl`, `html`, `java`, `javascript` (`js`, `jsx`), `json`,
`kotlin` (`kt`), `lua`, `markdown` (`md`), `nix`, `php`, `python` (`py`), `ruby` (`rb`), `rust` (`rs`), `scala`,
`solidity` (`sol`), `swift`, `typescript` (`ts`), `tsx`, `yaml` (`yml`), `zig`. The list with every file extension is
at https://ast-grep.github.io/reference/languages.html.

- `typescript` reads `.ts`, `.cts`, `.mts`, and `tsx` only `.tsx`. `javascript` reads `.js`, `.cjs`, `.mjs`, `.jsx`.
- `.h` files are read as C, so a C++ header's classes don't parse; map them with `languageGlobs: { cpp: ['*.h'] }`.
- `.vue`, `.svelte` and `.astro` aren't read at all unless the project's `sgconfig.yml` maps them, for example
  `languageGlobs: { html: ['*.vue'] }`.
