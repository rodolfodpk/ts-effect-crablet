# Database tables

*Reference · developers and operators · none · look up*

The tables the framework owns. The schema is the SQL in [`@crablet/db-migrations`](../../packages/db-migrations/README.md) (V1 to V14); your own
tables, views included, are numbered from V100. A diagram of how they relate is in
[the architecture](../concepts/architecture.md#what-is-in-the-database).

| Table | One row per | What it holds |
|---|---|---|
| `crablet_events` | event | The log: `position`, `type`, `tags` (indexed), `data` (the payload, JSON), `transaction_id`, and correlation and causation ids. Never updated or deleted. |
| `crablet_event_tag_keys` | event and tag key | `(key, position)`, so the pollers can select events by tag key cheaply ([ADR-0019](../adr/0019-storage-visibility-and-the-tag-table.md)). |
| `crablet_commands` | command, when auditing is on | The command's type, its input (redacted by default) and metadata, in the same transaction as its events. |
| `crablet_view_progress` | view | The view's cursor (`last_transaction_id`, `last_position`), status, error count and last error. |
| `crablet_automation_progress` | automation | The same, for an automation. |
| `crablet_outbox_topic_progress` | outbox topic | The same, for an outbox topic. |

The append is a SQL function with a condition (`append_events_if`), so the check and the write are one statement
([ADR-0003](../adr/0003-non-commutative-append-concurrency-protection.md)). How much space each table takes is reported by `storageReport()`
([Monitor it](../guides/operate/monitor-it.md)).
