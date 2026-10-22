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

```json
{
  "version": 1,
  "repositories": {
    "shuttle": {
      "url": "https://github.com/ggpwnkthx/shuttle.git",
      "commit": "1199d6d350be86b0081cb367e022722649825544"
    },
    "hub": {
      "url": "https://github.com/ggpwnkthx/hub.git",
      "commit": "c52681fb3164ee952df93ae9dec8317dc6f9ce91"
    }
  }
}
```

The revisions are full commits: they are immutable, and a change of
the baseline is a change of the manifest and a new run of the harness.

The baseline is written in the [specification](specification.md) §1.1,
and the check of the drift proves that the two still agree:

```bash
bun run check:compatibility
```

The check also refuses a workflow of the continuous integration that
holds a revision of its own: a pin that is written twice is a pin that
drifts, and a harness that runs against another revision than the one
of the specification proves nothing.

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
