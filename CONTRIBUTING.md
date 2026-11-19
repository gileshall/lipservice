# Contributing to Lip Service

Bug reports, ideas and questions are welcome: open an issue.

Code from outside is not being merged yet. Lip Service is offered under two licenses, the
AGPL-3.0 and commercial ones, and a contribution has to be licensable under both; the agreement
that makes that possible is not written yet. A pull request sent before then will wait.

## How

If you are working on the code for yourself, these are the checks:

1. `cargo test --release --lib` in `engine/` passes. The tests under `engine/tests` need model
   files that are not published yet.
2. `python python/tests/check.py` and `python python/tests/docs.py` pass if you touched the
   package or a page with examples in it. Both say how to run them.
3. A new source file starts with the license line the others have:
   `SPDX-License-Identifier: AGPL-3.0-only`.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
