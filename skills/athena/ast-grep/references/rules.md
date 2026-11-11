# Writing rules

A rule file is YAML that says what to match, and optionally what to write instead. Every example here was run against
ast-grep 0.51.1. A rule for one task lives in the `ast-grep-work` folder and goes when the task is done; a rule the
project keeps lives in its rule folder (last section). Write rule files with your file tools, in UTF-8.

## Running one

```
ast-grep scan --rule ast-grep-work/rule.yml src                       # report, with the fix shown as a diff
ast-grep scan --rule ast-grep-work/rule.yml --report-style short src  # one line per match: file:line:col
ast-grep scan --rule ast-grep-work/rule.yml -U src                    # apply the fix
```

- Preview and apply as in SKILL.md's steps: the run without `-U` changes nothing.
- `scan` exits 1 only when a rule with `severity: error` matched (or `--error` raised it); warnings and hints exit 0.
- One file can hold several rules separated by a line with `---`, for example the same check for `typescript` and for
  `tsx`, which are separate languages.
- `--inline-rules '<yaml>'` takes the rule as text. It's handy in bash; in Windows PowerShell 5.1 the quotes inside get
  stripped, so use a file there.

## The parts

```yaml
id: no-console-log
language: typescript
severity: warning
message: Use the logger instead of console.log
rule:
  pattern: console.log($$$ARGS)
fix: logger.info($$$ARGS)
```

| Key                                      | What it holds                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `language`, `rule`                 | Required. `language` takes a name or alias from `cli.md` (`typescript`, `TypeScript` and `ts` all work)                             |
| `severity`                               | `hint`, `info`, `warning`, `error` or `off`                                                                                         |
| `message`, `note`                        | One line shown with each match (may use `$NAME`); longer Markdown guidance (may not)                                                |
| `constraints`                            | Extra conditions on single captures                                                                                                 |
| `utils`                                  | Named sub-rules for `matches`                                                                                                       |
| `transform`                              | New captures computed from captured text, for `fix`                                                                                 |
| `fix`                                    | The rewrite, as a string or with `template`, `expandStart`, `expandEnd`                                                             |
| `files`, `ignores`                       | Globs for the paths it applies to, matched against paths as ast-grep walks them from where you run it, so run from the project root |
| `labels`, `url`, `metadata`, `rewriters` | Editor highlights, a docs link, data for other tools, rules for the `rewrite` transform                                             |

Since 0.51.1 a misspelt key (`fixx:`) stops the run with the line number; older versions ignored it silently.

**YAML quoting.** `$` needs no escaping. Put a pattern in single quotes when it starts with a character YAML treats
specially (`{`, `[`, `'`, `"`, `#`, `&`, `*`, `!`, `|`, `>`, `%`, `@` or a backtick), or contains `: ` (read as a key)
or ` #` (read as a comment). Inside single quotes write `'` as `''`. A multi-line `fix` goes in a `|-` block.

## Matching one node

- **`pattern`**: a string, or an object with `context` (code that parses), `selector` (the kind of node inside it to
  match) and optionally `strictness`:

  ```yaml
  rule:
    pattern:
      context: 'x: Optional[$T]'
      selector: generic_type
  ```

- **`kind`**: a node kind from `--debug-query=ast`. It also takes CSS-like selectors: `call_expression > identifier`
  (a child), `identifier + arguments` (the next sibling), `identifier ~ arguments` (a later sibling),
  `call_expression number` (any descendant). The node matched is the last one named.
- **`regex`**: a Rust regular expression searched in the node's whole text, children included. It matches anywhere
  unless anchored with `^…$`, and has no look-around or back-references. Pair it with `kind` or `pattern`: alone it's
  tried on every node. `kind: comment` with `regex: TODO` finds TODO comments, and not a variable called `TODO`.
- **`nthChild`**: the node's position among its named siblings, counted from 1: a number, a formula such as `2n+1`,
  or `{ position, reverse, ofRule }`. `kind: number` with `nthChild: 2` and `inside: { kind: arguments }` is a number
  passed as the second argument.
- **`range`**: a start and end `line` and `column`, counted from 0, end not included; for a tool pointing at a known
  spot.

Strictness decides how exactly a pattern must match. The default, `smart`, ignores commas and comments the pattern
doesn't mention; `cst` matches every character's node, so `foo(a, b)` stops finding `foo(a, b,)`; `signature` ignores
names and text, so `foo(a, b)` also finds `bar(c, d)`. Change it only with a reason.

## Relations

| Key        | The node must…                         |
| ---------- | -------------------------------------- |
| `inside`   | have an ancestor matching the sub-rule |
| `has`      | have a descendant matching it          |
| `follows`  | come after a sibling matching it       |
| `precedes` | come before a sibling matching it      |

- **`stopBy`** sets how far they look. The default, `neighbor`, checks only the direct parent, child or next sibling,
  which is why `inside: { kind: for_statement }` usually finds nothing. `stopBy: end` looks all the way up, down or
  along. A rule as `stopBy` stops at the first node matching it, and that node is still checked.
- **`field`** (with `inside` and `has`) names the role in the parent: `name`, `body`, `key`, `return_type` and so on,
  shown before the colon in `--debug-query=ast` output.
- `has` also sees unnamed tokens such as a block's `{`, so "has something that isn't a comment" is always true.

`await` inside a loop of the same function, stopping at a function boundary, so a callback inside the loop doesn't
count:

```yaml
id: await-in-loop
language: javascript
message: await inside a loop runs the calls one after another
rule:
  pattern: await $CALL
  inside:
    any:
      - kind: for_in_statement
      - kind: for_statement
      - kind: while_statement
    stopBy:
      any:
        - kind: function_declaration
        - kind: function_expression
        - kind: arrow_function
        - kind: method_definition
```

With `stopBy: end` instead, an `await` in a `forEach(async …)` callback inside the loop matched too; with no `stopBy`,
nothing matched.

## Combining

- Several keys in one rule object must all match the same node.
- `all: [ … ]` does the same in order, so a later rule can use what an earlier one captured. Use it when that matters.
- `any: [ … ]` matches if one does; only the matching branch's captures are kept.
- `not: { … }` excludes. A rule needs at least one positive key: one made only of `not` doesn't load.
- `matches: <id>` uses a rule defined under `utils:` in the same file (`utils: { console-call: { pattern: … } }`), or
  in the project's `utilDirs`.
- `all` and `any` describe one node. "Has a number and a string" is `all: [ { has: … }, { has: … } ]`, not one `has`
  holding an `all`.

## Conditions on captures

`constraints` filter single captures (`$M`, not `$$$ARGS`) after the rule has matched. They don't work inside `not`.

```yaml
rule:
  pattern: console.$M($$$ARGS)
constraints:
  M:
    regex: ^(log|debug)$
fix: logger.debug($$$ARGS)
```

## Rewriting

- A `fix` string isn't parsed, so captures can go anywhere in it, even joined to other letters (`use$NAME`).
  `$$$ARGS` comes back with its commas. `fix: ''` deletes the node but leaves the separator around it.
- A multi-line fix is re-indented to where the match starts. Match the whole statement so its `;` goes too, which also
  catches statements written without one:

  ```yaml
  rule:
    kind: expression_statement
    has:
      pattern: old($A)
  fix: |-
    try {
      neu($A);
    } catch {}
  ```

- **Removing a list item with its comma**: widen the replaced range with `expandEnd` (or `expandStart`), a rule the
  range grows over while it matches:

  ```yaml
  id: drop-password-key
  language: javascript
  rule:
    kind: pair
    has:
      field: key
      regex: ^password$
  fix:
    template: ''
    expandEnd:
      regex: ','
  ```

  `{ host: "x", password: "secret", port: 1 }` becomes `{ host: "x",  port: 1 }`: run the formatter afterwards.

- **`transform`** makes new captures from old ones, for use in `fix`; one transform can use another made before it.
  Each has a long form and, since 0.38.3, a short one:

  ```yaml
  transform:
    NEW: replace($M, replace='Equals$', by='Equal') # regex replace in the text of one capture
    INNER: substring($S, startChar=1, endChar=-1) # slice by characters; negative counts from the end
    CAMEL: convert($F, toCase=camelCase) # change case
    SNAKE: # the long form of the same kind of step
      convert: { source: $F, toCase: snakeCase, separatedBy: [underscore] }
  ```

  `toCase` is one of `lowerCase`, `upperCase`, `capitalize`, `camelCase`, `snakeCase`, `kebabCase`, `pascalCase`.
  `separatedBy` takes `dash`, `dot`, `space`, `slash`, `underscore`, `caseChange` in lower case (`Underscore` fails to
  load), and uses all of them when left out. `rewrite`, marked experimental, applies the rules listed under
  `rewriters` inside a capture.

## Keeping rules in a project

Write `sgconfig.yml` at the project root by hand. In 0.51.1, `ast-grep new project` writes absolute paths into it,
which break on any other machine.

```yaml
ruleDirs:
  - rules
testConfigs:
  - testDir: rule-tests
```

- `ruleDirs` is required. Others: `utilDirs` (shared `utils`, one per file with `id` and `language`), `languageGlobs`
  (file patterns read as a language, such as `html: ['*.vue']`, which only applies when the config is found), and
  `customLanguages`, whose native libraries load only with `--custom-languages allow` or `trust` since 0.50.
- ast-grep finds the file by looking up from the current folder. Then `ast-grep scan` runs every rule, and
  `--filter <regex>` picks rules by id (it can't be combined with `--rule`).
- A test file in `rule-tests` lists code the rule should leave alone and code it should report:

  ```yaml
  id: no-console-log
  valid:
    - logger.info('x')
    - console.error('boom')
  invalid:
    - console.log('x')
    - console.log(a, b)
  ```

- `ast-grep test --skip-snapshot-tests` checks only that: `.` passed, `N` noisy (reported valid code), `M` missing
  (didn't report invalid code). Once the rule is right, `ast-grep test -U` saves what each invalid case produces in
  `rule-tests/__snapshots__`, which belong in the project beside the rule; plain `ast-grep test` then compares
  against them. A case with no snapshot, or a changed one, fails.
- In CI, `ast-grep scan --format github` writes GitHub annotations and `--format sarif` a SARIF report.
  `--report-style short` only shortens the text output. Give the rules that should fail the build `severity: error`.
