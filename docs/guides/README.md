# Task guides

*Guides · developers and operators · the [tutorial](../tutorial/README.md) done · one page each*

Short pages for "how do I...?". Each one is a checklist with code from a real, tested file, so what you read is what runs. They assume you have done the
tutorial.

## Build: while writing an application

| I want to... | Guide |
|---|---|
| Keep a read model (a table) up to date from events | [Add a view](build/add-a-view.md) |
| Change the schema and keep the queries checked | [The database workflow](build/database-workflow.md) |
| React to an event by issuing a command | [Add an automation](build/add-an-automation.md) |
| Act once several events have happened, in any order (the EIP Aggregator) | [Aggregate events](build/aggregate-events.md) |
| Run a command once a time has passed (a hold that expires, an unpaid subscription released) | [Set a deadline](build/set-a-deadline.md) |
| Call a command over HTTP, with a generated OpenAPI description | [Expose a command over HTTP](build/expose-a-command-over-http.md) |
| Test a command's decisions without a database | [Test a command](build/test-a-command.md) |
| Decide on something the input does not name (a card number names a member) | [Look something up before deciding](build/look-something-up-first.md) |
| Close a statement or a shift and open the next one | [Turn a period](build/turn-a-period.md) |
| Change an event that is already stored | [Evolving events](build/evolving-events.md) |

## Operate: while running it

| I want to... | Guide |
|---|---|
| Run it for real: migrations, connections, the background processors | [Run it in production](operate/run-in-production.md) |
| Decide the settings for a first deployment | [Configure it](operate/configure.md) |
| Know what happens when something breaks | [Failure modes](operate/failure-modes.md) |
| Answer an alert | [Runbooks](operate/runbooks.md) |
| See what it is doing and what it costs | [Monitor it](operate/monitor-it.md) |
| Watch it on a Grafana dashboard, with alerts | [See it on a dashboard](operate/dashboard.md) |
| Run the wallet on a local Kubernetes cluster and break it on purpose | [Run the kind lab](operate/run-the-kind-lab.md) |

The examples are the course-enrolment app (views, HTTP, payments with a time window, automations that react to several events or to one) and the wallet app
(automation, periods, background processors, tests).
