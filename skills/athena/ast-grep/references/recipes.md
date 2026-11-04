# Recipes

Each of these was run on small real files with ast-grep 0.51.1 and its result read. Run a rewrite first as written,
which only prints the diff; read it; then run the same command again with `-U` added. Rules go in the `ast-grep-work`
folder and run with `ast-grep scan --rule ast-grep-work/<file>.yml <path>`. Every command here works in bash, zsh and
PowerShell as written.

## Every call to a function (JavaScript, TypeScript)

```
ast-grep run -p 'fetchUser($$$ARGS)' src                    # direct calls
ast-grep run -p '$OBJ.fetchUser($$$ARGS)' src               # as a method of anything
ast-grep run -p 'fetchUser($$$ARGS)' --files-with-matches src
```

With no `--lang`, `.js`, `.jsx`, `.ts` and `.tsx` files are all read. Neither pattern finds the function passed as a
value (`.then(fetchUser)`); the bare name `-p 'fetchUser'` finds every identifier spelled that way.

## Rename a function across a codebase (JavaScript, TypeScript)

```
ast-grep run -p 'fetchUser' -r 'loadUser' src
rg -w fetchUser
```

The bare name renames calls, the declaration, imports and exports, `typeof fetchUser` and the function passed as a
value. It also renames an unrelated local variable of the same name in another function, so it suits a distinctive
name; for a common one (`load`, `get`) use the call patterns above or a language server's rename. It leaves
`obj.fetchUser()` and `{ fetchUser: … }` keys alone (properties are another kind of node), and also the shorthand
`{ fetchUser }`, which after the rename points at a name that no longer exists: change it by hand to
`{ fetchUser: loadUser }` (same key) or `{ loadUser }` (new key). After applying, the `rg` run shows what's left in
strings, comments and docs. Run the type check: an import of a name its module no longer exports fails there.

## `console.log` to a logger (TypeScript and TSX)

```
ast-grep run -p 'console.log($$$ARGS)' -r 'logger.info($$$ARGS)' src
```

No `--lang`, so `.ts` and `.tsx` are both covered. The arguments come back as written, commas included. Files that
didn't use `logger` before need its import.

## Empty `catch` blocks (TypeScript), find only

```yaml
id: empty-catch
language: typescript
message: this catch swallows the error
rule:
  any:
    - pattern:
        context: try {} catch ($E) {}
        selector: catch_clause
    - pattern:
        context: try {} catch {}
        selector: catch_clause
```

Finds `catch (e) {}`, `catch {}` and a `catch` holding only a comment. Add the same rule with `language: tsx` after a
`---` line for `.tsx` files.

## `<img>` without `alt` (TSX), find only

```yaml
id: img-without-alt
language: tsx
message: <img> has no alt attribute
rule:
  any:
    - kind: jsx_self_closing_element
    - kind: jsx_opening_element
  has:
    field: name
    regex: ^img$
  not:
    has:
      kind: jsx_attribute
      has:
        kind: property_identifier
        regex: ^alt$
```

`alt=""` counts as present (right for a decorative image). An `<img {...props} />` is reported, though the spread may
carry an `alt`. For `.jsx` files use `language: javascript`.

## Every function definition (Python)

```
ast-grep run --kind function_definition --lang py src
```

Methods and nested functions included. The tempting `def $F($$$)` parses into an `ERROR` node (`--debug-query`
shows it), so what it finds can't be relied on, and `def $F($$$): $$$BODY` misses functions with a return annotation.

## `Optional[X]` to `X | None` (Python)

```
ast-grep run -p 'x: Optional[$T]' --selector generic_type -r '$T | None' --lang py src
```

The `x: ` makes the pattern a type annotation rather than indexing. `Optional[Optional[int]]` needs a second apply.
`X | None` evaluated at run time needs Python 3.10 or newer (older versions only with
`from __future__ import annotations` in the file), so check the project's minimum first, or ask. Afterwards remove
`Optional` from imports where it's no longer used. `typing.Optional[…]` and annotations in quotes aren't matched:
find them with `rg 'Optional\['`.

## `assertEquals` to `assertEqual` (Python)

```yaml
id: assert-equals
language: python
message: assertEquals was removed in Python 3.12
rule:
  pattern: self.$M($$$ARGS)
constraints:
  M:
    regex: ^assert(Not)?Equals$
transform:
  NEW: replace($M, replace='Equals$', by='Equal')
fix: self.$NEW($$$ARGS)
```

`assertEquals` and `assertNotEquals` exist up to Python 3.11 and are gone in 3.12. Calls on anything other than `self`
are left alone.

## `io/ioutil` to `os` (Go)

```yaml
id: ioutil-to-os
language: go
message: io/ioutil is deprecated; os has the same function
rule:
  pattern:
    context: x := ioutil.$F($$$ARGS)
    selector: call_expression
constraints:
  F:
    regex: ^(ReadFile|WriteFile)$
fix: os.$F($$$ARGS)
```

Since Go 1.16 these two just call `os.ReadFile` and `os.WriteFile`. The `x := ` context keeps the call from being read
as a type conversion. Afterwards fix the imports
(`goimports -w` on the changed files, or the `go build` errors). To list error returns without context, find only:
`ast-grep run -p 'if err != nil { return err }' --lang go`. Don't rewrite `return $ERR`: it also matches `return nil`
and `return n`.

## `.unwrap()` where `?` could go (Rust), find only

```yaml
id: unwrap-in-result-fn
language: rust
message: this function returns Result, so ? may fit better than unwrap()
rule:
  pattern: $E.unwrap()
  inside:
    kind: function_item
    has:
      field: return_type
      regex: Result
    stopBy:
      any:
        - kind: function_item
        - kind: closure_expression
  not:
    inside:
      kind: mod_item
      follows:
        pattern: '#[cfg(test)]'
      stopBy: end
```

Only functions declared to return a `Result`, not closures inside them, and not the `#[cfg(test)]` module. Each match
is a candidate: `?` works only when the error converts into the function's error type, so change them one at a time
and build.
