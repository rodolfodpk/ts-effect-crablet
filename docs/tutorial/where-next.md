# Clean up, and where next

[← Step 5 - a page that uses it](05-a-page-that-uses-it.md) · [Tutorial index](README.md)

Stop the server and the page (Ctrl-C) and remove the database:

```bash
docker compose down -v
```

- The **wallet example** ([`examples/wallet-example-app`](../../examples/wallet-example-app)) is this at full size: five commands, four views, an automation, an
  outbox, statement periods.
- [ADR-0010](../adr/0010-declarative-command-api.md) explains the command API; [ADR-0011](../adr/0011-http-api-from-the-domain-model.md) the HTTP one.
- The [DCB guide](../dcb-guide.md) works through a transfer and this same enrolment example in more depth, including how the append conditions map onto the
  [DCB specification](https://dcb.events/specification/).
- [Evolving events](../evolving-events.md) is what to do when an event has to change after it has been written.
