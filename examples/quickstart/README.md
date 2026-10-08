# quickstart

The README's seat-booking example as one runnable script, with no database and no Docker: a command is declared, then run through the real pipeline on the
in-memory store.

```bash
bun install                                  # once, at the repository root
node examples/quickstart/src/quickstart.ts
```

You should see the six lines shown in the [main README](../../README.md) (the repeat of `add 12A` does nothing; the second booking of `12A` fails with `SeatTaken`;
booking `99Z` fails with `SeatNotFound`).

Read next: the [tutorial](../../docs/tutorial/README.md), which turns the same ideas into a service on Postgres. The test `examples/quickstart/test/quickstart.test.ts`
checks the output above.
