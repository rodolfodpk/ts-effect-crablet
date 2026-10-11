# Task guides

Short pages for "how do I...?". Each one is a checklist with the code from a real, tested file, so what you read is what runs. New to the project? Do the
[tutorial](../tutorial/README.md) first; these assume you have.

| I want to... | Guide |
|---|---|
| Keep a read model (a table) up to date from events | [Add a view](build/add-a-view.md) |
| Change the schema and keep the queries type-checked (migrate, generate the types, test) | [The database workflow](build/database-workflow.md) |
| React to an event by issuing a command | [Add an automation](build/add-an-automation.md) |
| Call a command over HTTP, with a generated OpenAPI description | [Expose a command over HTTP](build/expose-a-command-over-http.md) |
| Test a command's decisions without a database | [Test a command](build/test-a-command.md) |
| Close one statement or shift and open the next, per period | [Turn a period](build/turn-a-period.md) |
| Run it for real: migrations, the connection, the background processors | [Run it in production](operate/run-in-production.md) |
| See what it is doing and what it costs | [Monitor it](operate/monitor-it.md) |
| Watch the poller and its consumers on a Grafana dashboard, with alerts | [See it on a dashboard](operate/dashboard.md) |
| Run the wallet on a local Kubernetes cluster, watch it, and break it on purpose | [Run the kind lab](operate/run-the-kind-lab.md) |
| Change an event that is already stored | [Evolving events](build/evolving-events.md) |

The examples are the course-enrolment app (views, HTTP) and the wallet app (automation, background processors, tests).
