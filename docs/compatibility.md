# The compatibility with the platform

The depot does not own the contracts of the platform. Shuttle signs
the identity of the caller and Hub owns the identity, the tenants and
the grants. The depot proves that it works with them: the compatibility
harness runs the **real** pinned gateway, the **real** Hub and the
**real** backend of this repository, against a real PostgreSQL server.

## The baseline of the integration

The manifest `compatibility.json`, at the root of the repository, is the
one place that owns the repositories of the gateway and of the hub and
the revisions that are tested against them.

<!-- compatibility-manifest:start -->

```json
{
  "version": 1,
  "repositories": {
    "shuttle": {
      "url": "https://github.com/ggpwnkthx/shuttle.git",
      "commit": "89701713e50812f000f77c5ac9313527f0be3bfe"
    },
    "hub": {
      "url": "https://github.com/ggpwnkthx/hub.git",
      "commit": "2d923fab44ce661a8cf3adbb50a0b07863f1f60c"
    }
  }
}
```

<!-- compatibility-manifest:end -->

The revisions are full commits: they are immutable, and a change of
the baseline is a change of the manifest and a new run of the harness.

The baseline is the release `v2.0.0` of the gateway and the release
`v2.0.0` of Hub. The two are the pair that the platform publishes
together: the manifest of Hub `v2.0.0` pins the gateway `v2.0.0`, and
the harness proves the depot against that pair.

The baseline is written in the [specification](specification.md) §1.1,
and the check of the drift proves that the two still agree:

```bash
bun run check:compatibility
```

The check also refuses a workflow of the continuous integration that
holds a revision of its own: a pin that is written twice is a pin that
drifts, and a harness that runs against another revision than the one
of the specification proves nothing.

## The releases `2.0.0` of the platform

The two releases of the platform are **MAJOR** ones: they change the
contracts of the gateway and of Hub. The contract of the API of the depot
does not change: the path of every route is still `v1`, the identity of
the gateway is still the version `v5`, and the access context of Hub is
still the version `1`. The depot reads the contracts of the platform and
never writes them, so the changes below are the ones a deployment of the
platform has to make, and the ones the depot has to follow.

### The gateway, the release `v2.0.0`

The gateway closes five defects of the security of a deployment. One of
them changes the contract that the depot reads — the subject of the
identity — and the four others are the business of the deployment of the
gateway. The harness proves the depot against the real gateway of the
release:

| The change | What it means for the depot |
| --- | --- |
| The **subject** of the caller is written **as it is**: it is never rewritten, and a subject that cannot be written into a header is refused by the gateway with a `500`. | The subject of the identity of Hub is a uuid, and the backend requires it. The backend reads the header as it is and rebuilds the signed bytes from it: it MUST NOT trim it and MUST NOT normalize it. The unit suite proves that a subject that the gateway did not write is refused. |
| The **host** is decided before the method: a catch-all that names `GET` does not answer the `GET` of a host that has a route of its own. | The bindings of the backend are per host, and the backend derives the route from the binding that matches the signed host. A deployment that relies on a catch-all of the gateway has to move the hosts it names to the catch-all. |
| The **address of the caller** is the entry that is `SHUTTLE_TRUSTED_PROXY_HOPS` positions from the right of the chain of `x-forwarded-for`. | The variable is new and it is the business of the deployment of the gateway. A deployment behind a single ingress has nothing to do: the default is one. |
| The **ranges of the trusted proxies** of the environment replace the ranges of the route table. | The variable is the business of the deployment of the gateway. A deployment that set `SHUTTLE_TRUSTED_PROXIES` and relied on the ranges of its file has to name the ranges of the file in the variable. |
| The **users of the shared state in Redis** are described by a file that holds one rule per line, and the passwords are not in it. | The deployment writes the passwords of the two users after the server started. It is the business of the deployment of the gateway: the depot holds no shared state. |

The format of the route table, the protocol of the decisions, the
headers of the identity and the version of the signature are unchanged:
`v5` is still `v5`, and the legacy format `v4` is still refused by the
routes of the current format.

### Hub, the release `v2.0.0`

The contract of Hub changed, and the access context contract — the one
the depot speaks — did not: the discovery, the request, the answer and
the rule of the access context are the ones of the version `1`, and the
extension that carries it is still the extension of the depot.

| The change | What it means for the depot |
| --- | --- |
| The **credentials of a gateway** are always scoped to their tenant. The bearer token of the deployment is the only scheme that is not scoped, and it is deprecated. | The depot does not call the decision endpoint: it speaks the access context contract with its own credential, and that credential is scoped to the tenants it may ask about. The change is the business of the deployment of the gateway. |
| The **flags of a tenant** that belong to the platform (`shared_client`, `is_default`) are the work of the operator of the platform. | The depot holds no tenant of Hub and administers none. |
| The **budget of the limiter** of the administration is spent by the calls that fail, and the **call to a provider** is made to the address that was checked. | The depot calls no provider of Hub: the identity is the one the gateway forwards. |
| The **answers carry the headers of a browser**, and the answer of the token endpoint is never stored by a cache. | The depot reads the body of the access context and nothing else. |

The subject of the tokens of Hub is a **uuid**, and the gateway of the
release `v2.0.0` writes it into the headers of the identity as it is:
it is never rewritten, and it is always writable. The principal of the
backend is therefore the uuid of the principal of Hub, and the two
services never speak of two different callers.

## The harness

```bash
bun run test:compat
```

The harness clones the gateway and Hub at the revisions of the
baseline, it starts them with a PostgreSQL server and a deployment of
the backend, and it performs the acceptance scenario of the
specification through the gateway: a client discovers a collection, it
creates a record under its own identity, it reads the fields it may
read, it updates its own record with a current validator, it observes
the metadata of the audit, and it proves that another tenant cannot
reach the data.

## The sources of the checkouts

The harness takes the gateway and Hub from the network when it can, and
from local checkouts when it cannot. The order of the sources is the
order of the list: an explicit repository wins over a mirror, and a
mirror wins over the url of the manifest.

| Variable | What it is |
| --- | --- |
| `SHUTTLE_REPOSITORY` | The repository of the gateway: a git url, or the path of a local repository. |
| `HUB_REPOSITORY` | The repository of Hub. |
| `SHUTTLE_COMMIT` | The revision of the gateway. |
| `HUB_COMMIT` | The revision of Hub. |
| `COMPAT_MIRROR` | A directory that holds the bare mirrors `shuttle.git` and `hub.git`. |
| `COMPAT_KEEP` | When it is set, the temporary directory of the run is kept. |

```bash
SHUTTLE_REPOSITORY=/srv/mirrors/shuttle HUB_REPOSITORY=/srv/mirrors/hub \
  bun run test:compat
```

A repository that is a path on the disk is cloned from that path, and
the clone of a local path does not use the network. A url with or
without the suffix `.git` names the same mirror.

`SHUTTLE_COMMIT` and `HUB_COMMIT` name another revision: a run with an
override is a run of a candidate, and the harness says that it is not
the proof of the baseline. An override that is not a full revision is
an error, and the harness never falls back to another source.

## The extension of Hub

The access context contract is a **required integration and deployment
dependency**: a Hub that does not answer `/v1/access-context` cannot
serve this backend, and the backend fails closed without it.

The extension is **upstream**: Hub carries it since `4cedcfc`, and the
baseline of Hub in `compatibility.json` is a revision that carries it.
The depot holds no copy of the change. A contract of the platform lives
in the repository of the platform, and the harness proves it against
the real Hub.

A change of the contract of Hub therefore has two steps:

1. the change lands in the repository of Hub, and it preserves the
   existing contract of the decisions of the gateway,
2. the manifest of this repository is updated to the revision that
   carries it, and the harness passes.

## The fixtures of the signature

The fixture of the signature of the identity is produced by the pinned
gateway itself: the canonical payload and the signature come from the
code of the gateway, and the test of the backend checks its own
verification against those bytes.

```bash
SHUTTLE_CHECKOUT=/path/to/shuttle bun run scripts/generate-fixtures.ts
```

The checkout has to be at the revision of the baseline: the fixture is
the evidence of the contract of that revision and not of another one.
The fixture carries the revision it comes from, and the suite refuses a
fixture that does not carry the revision of the manifest.

The fixture also carries the legacy format `v4`, because the backend
still reads it for the deployments whose gateway is older. The gateway
does not sign it any more — it was removed in the release `1.0.0` — so
the derivation of its key is the one part of the fixture that the
harness and the generator keep locally: the payload and the signature
are still the ones of the code of the gateway.
