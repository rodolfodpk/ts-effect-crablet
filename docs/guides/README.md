# Task guides

Short pages for "how do I...?". Each one is a checklist with the code from a real, tested file, so what you read is what runs. New to the project? Do the
[tutorial](../tutorial/README.md) first; these assume you have.

| I want to... | Guide |
|---|---|
| Keep a read model (a table) up to date from events | [Add a view](add-a-view.md) |
| React to an event by issuing a command | [Add an automation](add-an-automation.md) |
| Call a command over HTTP, with a generated OpenAPI description | [Expose a command over HTTP](expose-a-command-over-http.md) |
| Test a command's decisions without a database | [Test a command](test-a-command.md) |
| Run it for real: migrations, the connection, the background processors | [Run it in production](run-in-production.md) |
| See what it is doing and what it costs | [Monitor it](monitor-it.md) |
| Change an event that is already stored | [Evolving events](../evolving-events.md) |

The examples are the course-enrolment app (views, HTTP) and the wallet app (automation, background processors, tests).
