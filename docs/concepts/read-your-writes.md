# Reading your own writes

*Concept · developers building an API or a page · [views and delivery](./views-and-delivery.md) · 10 minutes*

Views update in the background, a moment after a command commits. Without help, a client that subscribes a student and then asks "how many seats are
left?" can get the number from before its own write. This page is how that is prevented, and what a client sees when it cannot be.

## The marker

A command's answer carries a **marker**: where in the log its write ended, as `<transactionId>:<position>`. The command waits for nothing else; it does
not know which views exist.

A read can carry the marker: `GET /api/courses/math?consistentWith=<marker>`. The server then answers only once **every view that endpoint reads** has
reached the marker. Any client holding the marker can use it: the writer, a second tab, or another service the writer passed it to.

## The default is strict

| The read carries | The server |
|---|---|
| a marker | waits until the endpoint's views include that write |
| no marker | waits for everything committed when the request arrived (`latest`) |
| a marker beyond the end of the log, or a bad parameter | answers `400` at once, without waiting |

If the views do not catch up within the timeout (5 seconds by default), the answer is a `503` problem with `Retry-After` and the views that were
behind. A view that has stopped after too many errors answers `503` at once, with no `Retry-After`, because retrying will not help until someone
resets it.

So a read is either right or a clear `503`. It is never silently stale. An endpoint can choose a looser mode (`bounded` answers with a
`Crablet-Consistency: stale` header instead of failing; `eventual` does not wait), and a request can ask for a looser mode only where the server
allows it ([ADR-0015](../adr/0015-read-consistency-by-marker.md), decisions 4 and 5).

## Clients that did not write

A page that shows data someone else may change listens to a feed of **pings** (server-sent events; the course app serves it at `GET /api/views/changes`). A ping says "this view
moved" and carries no data; the page reads again through the same endpoints, with the same authorization ([ADR-0014](../adr/0014-live-updates-by-ping.md)).

- A ping is sent only after the view's data and cursor have committed, so it never announces data a read cannot find yet.
- A ping can be lost. The feed starts each connection with every view's current position, so a client that reconnects reads once and cannot stay stale.

## See it work

[Tutorial step 4](../tutorial/04-read-your-own-writes.md) adds a view to the course service and makes a read include a write. [Step 5](../tutorial/05-a-page-that-uses-it.md)
puts a page in front of it that uses markers and pings.

## Decisions behind this page

[ADR-0015](../adr/0015-read-consistency-by-marker.md) (the marker and the modes) · [ADR-0014](../adr/0014-live-updates-by-ping.md) (pings) ·
[ADR-0016](../adr/0016-one-listen-per-process-for-view-progress.md) (one listener per process)
