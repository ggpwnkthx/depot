# The documentation of the depot

The depot is the headless data backend of the platform. It serves
permission aware data APIs to the applications that live behind
[Shuttle](https://github.com/ggpwnkthx/shuttle), and it takes the
identity and the capabilities of the caller from
[Hub](https://github.com/ggpwnkthx/hub).

This directory holds the whole documentation of the service. It is
written for three audiences, and each document says which one it is
for.

## Where to start

| If you are | Read |
| --- | --- |
| a consumer of the API | [the contract of v1](api.md), then [the client](client.md) |
| an operator of a deployment | [the configuration](configuration.md), [the operations](operations.md), [the migrations](migrations.md) |
| a reviewer of the service | [the specification](specification.md), [the security model](security.md), [the decisions](decisions.md) |
| a contributor | [the development](development.md), [the architecture](architecture.md) |

## The documents

| Document | What it holds |
| --- | --- |
| [architecture.md](architecture.md) | What the service is, how a request travels through it, and the boundaries of the code. |
| [getting-started.md](getting-started.md) | The development machine, from an empty checkout to a running service. |
| [configuration.md](configuration.md) | Every variable of the environment, the bindings file, the manifests and the policy bundles. |
| [api.md](api.md) | The stable surface of the API: the paths, the envelopes, the errors, the filters and the rules of a change. |
| [client.md](client.md) | The typed client `@data-backend/client`, and the types of the collections of a deployment. |
| [specification.md](specification.md) | The normative contract of the release. |
| [security.md](security.md) | The model of the security, the review of it and the findings that are open. |
| [operations.md](operations.md) | The probes, the metrics, the logs, the drain, the budgets and the alarms. |
| [compatibility.md](compatibility.md) | The baseline of the integration with Shuttle and Hub, and the harness that proves it. |
| [migrations.md](migrations.md) | The migrations, the drift, the roles and the bundles. |
| [retention.md](retention.md) | The retention of the history and the removal of a workspace. |
| [backup-restore.md](backup-restore.md) | The backup, the restore and the rehearsal of the restore. |
| [troubleshooting.md](troubleshooting.md) | The failures of the service and what to do about them. |
| [capacity.md](capacity.md) | The capacity report of the release, and what a deployment declares. |
| [decisions.md](decisions.md) | The choices of the implementation and the reason of each one. |
| [development.md](development.md) | The suites of the tests, the gates of a release and the scripts of the repository. |
| [changelog.md](changelog.md) | The changes of the service, from the newest to the oldest. |

## The status of the release

**Version 0.2.0 is published, and it is a pre-production release.** It
is implemented, it passes its own gates, and the compatibility harness
runs it against the real gateway and the real hub — but it has never
run outside its own harness. It has no production history, no external
user, and no review that was written by somebody other than the author
of the code. The findings that are still open are in
[security.md](security.md).
