---
name: Structural code search and rewrite
description: Use for searches and edits that follow the shape of code across many files: "find all calls to X", "rename this across the codebase", a codemod, "refactor every place that…", structural search or a custom lint rule. Previews each rewrite before applying it. Plain text searches stay with rg.
---

ast-grep reads code as a syntax tree, so `fetchUser($$$ARGS)` finds every call to `fetchUser` however it's spaced or
split over lines, and never a mention in a comment or a string. Reach for it when the answer depends on the shape of
the code: every call to a function, every empty `catch`, every `Optional[X]` annotation, one change made the same way in
two hundred files. When the answer depends only on text (an error message, a TODO, a URL, a word in docs and config,
a file name), `rg` is simpler and faster. Good work tells the user how many places in how many files matched before
anything changes, previews the rewrite and reads it, applies it in a separate run, and ends with the diff checked, the
build or tests run, and a search that finds nothing left to change.

## Before you start

- **Is it installed?** Run `ast-grep --version`. If that isn't found, try `sg --version`: the winget package puts only
  `sg` on the PATH. On Linux `sg` is usually the system's `setgroups` command, so call `ast-grep` there, and trust `sg`
  anywhere only when its version line says ast-grep. This skill was checked against ast-grep 0.51.1 (November 2026);
  `outline` needs 0.44 or newer, `run --kind` 0.43, `--files-with-matches` 0.40.4.
- **Installing is the user's call.** Ask first, then use the line for their system:
  - Windows: `winget install --id ast-grep.ast-grep --accept-source-agreements --accept-package-agreements` (gives
    `sg`; open a new shell if it isn't found), or `scoop install main/ast-grep` (gives both names)
  - macOS: `brew install ast-grep`
  - Linux, or any system with Node: `npm install -g @ast-grep/cli`; with Rust: `cargo install ast-grep --locked`;
    `pip install ast-grep-cli` works inside a virtual environment
- **Know the state of the files.** Run `git status` before a rewrite. With a clean tree the diff is the whole record of
  what ast-grep did. If files it will touch have uncommitted changes, or the folder isn't under git, ask whether the
  user wants to commit first; if not, copy those files to an `ast-grep-backup` folder in the workspace before applying,
  keep it, and say where it is. Never `git stash`: every worktree shares the stash.
- **Working files** (rule files, sample snippets, saved JSON) go in an `ast-grep-work` folder in the workspace and are
  deleted before you report, unless the user asked for a lint rule to keep in the project. Write them with your file
  tools: Windows PowerShell 5.1's `>` writes UTF-16, which ast-grep refuses as a rule file and silently skips as code.

## How to do it well

### ast-grep, rg, or something that knows the program

ast-grep knows syntax, not meaning. It has no idea of scope, types or data flow: a rename with the pattern `fetchUser`
also renames a local variable of that name in another function and misses the shorthand `{ fetchUser }` (a different
kind of node), and `$OBJ.save()` looks the same whatever `$OBJ` is. So:

- **Shape questions** (calls, arguments, declarations, imports, statements inside other statements): ast-grep.
- **Text questions** (comments, strings, docs, config, several languages at once): `rg`. After a rename, run `rg -w`
  on the old name anyway to find what a code pattern can't reach.
- **Meaning questions** (every use of this symbol, this method on this class only): a language server's rename or
  find-references, or the compiler, if you have one. ast-grep can still list the candidates; check each.

### Patterns are code, not regex

A pattern is a snippet of the target language with metavariables in it:

- `$NAME` matches one node: an expression, an identifier, an argument, a statement. Names use capitals, digits and `_`.
- `$$$` matches zero or more nodes (arguments, parameters, statements); `$$$ARGS` also captures them. It's lazy: it
  stops at the first place the rest of the pattern can match, so `foo($$$A, b, $$$C)` on `foo(a, c, b, b, c)` gives
  `a, c` and `b, c`.
- A name used twice must match the same text: `$X == $X` finds `a == a`, not `a == b`. Names starting with `_` (`$_`,
  `$_FN`) capture nothing and may differ at each use.
- A metavariable is a whole node: `use$HOOK` matches nothing. For part of a name, match `$F` and put a `regex` on it in
  a rule.
- There's no regex inside a pattern: `foo|bar`, `.*` and `\w+` are read as code. Alternatives go in a rule's `any`, and
  a text condition in its `regex` field.
- A string literal matches by its exact text, quotes included: `foo('x')` doesn't find `foo("x")`. Use `foo($S)` and
  a constraint.
- Whitespace and line breaks don't matter, and code written inside a comment or a string is never matched.

The pattern has to parse as one complete node. `catch ($E) {}` alone isn't valid code, so give it context and pick the
part you mean: `-p 'try {} catch ($E) {}' --selector catch_clause`. Some snippets parse as something other than what
you meant: in Go a one-argument `ioutil.ReadFile($P)` reads as a type conversion and finds no calls, and in Python
`Optional[$T]` reads as a subscript, not the annotation. The same fix works: write the code around it and select the
node (`references/recipes.md` has both).

### Quoting the pattern

In bash and zsh, put the pattern in single quotes so the shell leaves `$X` alone. PowerShell also needs single quotes
(double quotes expand `$X`), with a `'` inside written as `''`. Windows PowerShell 5.1 strips the `"` characters inside
an argument passed to a program, so a pattern or rewrite that contains a double quote goes in a rule file run with
`ast-grep scan --rule <file>`, not on the command line.

### When nothing matches

1. Read stderr. "Pattern contains an ERROR node" means the pattern didn't parse, even though the exit code may be 0.
   Exit code 1 means no match, or a path that doesn't exist.
2. Check the language. `--lang ts` skips `.tsx` files (`tsx` is its own language) and `--lang js` covers `.jsx`.
   Without `--lang`, each file is read in its own language, which covers `.ts` and `.tsx` in one run but also tries the
   pattern on other languages under the path.
3. See how the pattern was read: add `--lang <lang> --debug-query=pattern` (the `=` is needed; with a space the word is
   taken as a path). The top line is the node kind the pattern became.
4. See the kinds in the code you want: copy a few real lines into a sample file in the work folder, use them as the
   pattern with `--debug-query=ast`, and point the run at that sample file. In Python, Go and other languages where
   `$` can't appear in a name, `ast` and `cst` show `ERROR` around metavariables even when the pattern is fine;
   `pattern` is the view to trust there.
5. Change the shape: add context and `--selector <kind>`, or match `--kind <kind>` and narrow it in a rule. The online
   playground (https://ast-grep.github.io/playground.html) shows the pattern's tree beside the code's, if the user can
   open it.

### Move to a rule file when

One `run -p` covers one pattern. Write a YAML rule (`references/rules.md`) when you need a condition on a capture
(`constraints`), "inside X" or "containing Y" (`inside` and `has`, with `stopBy: end` to look past the direct parent or
child), alternatives or exclusions (`any`, `not`), a rewrite that changes a capture (`transform`), a pattern with `"` in
Windows PowerShell, or a check the project keeps and tests (`sgconfig.yml` and `ast-grep test`).

## Steps for a rewrite

1. **Search and count.** Run the pattern without `-r`. `--files-with-matches` lists the files; `--json=stream` prints
   one line per match, so `| Measure-Object -Line` in PowerShell or `| wc -l` in a POSIX shell counts them. Read a
   sample, including the odd ones: tests, generated files, other languages, matches inside larger expressions. If the
   count surprises you or the user, stop and say so before going on.
2. **Preview.** The same command with `-r '<rewrite>'` (or the rule with its `fix`) and without `-U` prints a diff for
   every match and changes nothing. Read it. Narrow the pattern or the rule, or exclude paths with
   `--globs '!<path>'`, until every hunk is one you mean.
3. **Apply** in a separate run: the same command plus `-U`. Don't add `--json` to it: with `--json`, `-U` silently
   writes nothing. `-i` (interactive) needs a person at a terminal, so it's no use here.
4. **Check.** ast-grep prints "Applied N changes"; `git diff --stat` gives the files. Rerun the search: it should find
   nothing, or only what you meant to leave. One pass rewrites the outer match of nested ones (`f(f(x))`), so repeat
   apply and search until it's clean. Then run the project's formatter on the changed files if it uses one, and its
   type check, build and tests.

## Done means

- You report the numbers from the real output (matches changed, files changed) and what you left alone on purpose:
  skipped matches, and places a code pattern can't reach (strings, comments, docs, other languages) found with `rg`.
- The search reruns clean, and the build, type check and tests pass, or a failure is shown to happen without the
  change too.
- You've read the diff: nothing changed in generated or vendored files or test fixtures unless that was the point, and
  the user's own uncommitted work is untouched.
- The work folder is gone (a backup folder stays, and the user knows where). Nothing is committed unless the user
  asked; then stage the changed files by name.

## Watch out for

- A metavariable in the rewrite that the pattern never captured becomes empty text, with no warning:
  `-r 'const $TMP = await $P'` writes `const  = await …`. Every `$NAME` in a rewrite must come from the pattern or a
  `transform`.
- A rewrite that adds a call may need an import, and one that removes the last use leaves an unused import. The build
  or linter shows both (`goimports`, `ruff`, `eslint --fix` clean them up).
- A multi-line fix is re-indented to the match, but its line breaks are `\n` even in a file with Windows line endings,
  and if the pattern matched an expression, the statement's `;` stays after your replacement. Match the whole
  statement (`references/rules.md`), and check the diff for mixed line endings.
- Files under `.gitignore` (`dist`, `node_modules`) are skipped, but generated code that's committed is not: exclude
  it with `--globs '!<folder>/**'`. A folder named on the command line is searched even when ignored.

## Files

- `references/rules.md`: writing YAML rules: every rule key, `stopBy`, `constraints`, `transform`, `fix` that also
  removes a comma, tested examples, and setting up `sgconfig.yml` with rule tests. Open it before your first rule.
- `references/cli.md`: the commands and flags worth knowing, the JSON output, exit codes, and the languages with
  their file extensions. Open it when a flag, an output format or a file type matters.
- `references/recipes.md`: tested searches and rewrites for TypeScript, JavaScript, Python, Go and Rust, each previewed
  before it's applied. Open it at the start of a task like one of them.
