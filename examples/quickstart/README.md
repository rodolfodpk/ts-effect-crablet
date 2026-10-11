# quickstart

The README's example as one runnable script, with no database and no Docker. A course has at most N students and a student takes at most 3 courses;
one command, `Subscribe`, decides both, and runs through the real pipeline on the in-memory store.

```bash
bun install                                  # once, at the repository root
node examples/quickstart/src/quickstart.ts
```

It starts from a history where `math` has one seat and `art`, `bio` and `chem` have ten, then prints one line per subscription: Bob finds `math` full,
Ann's repeat changes nothing, Ann's fourth course is refused with `StudentAtLimit`, and an unknown course is refused with `CourseNotFound`. The test
`examples/quickstart/test/quickstart.test.ts` pins those lines and checks that the [README](../../README.md) shows them.

Read next: the [tutorial](../../docs/tutorial/README.md), which builds the same domain into a service on Postgres, with real races.
