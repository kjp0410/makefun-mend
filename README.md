# mend: one patch tool for every AI edit format

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. `mend` reads all four to one written specification, finds the lines an
edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: 0 when the tree is written (or would be, with `--check`), 1
when one or more edits failed (no file is written), 2 on a usage, missing
patch, undetected format or parse error.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner, kept as it is.
- `LICENSE`: MIT.
