# The extension of the hub

The pinned hub (`d488835654ac313aaaeac845d9d7f5c68eb40020`) does not
answer the access context contract of the specification of the data
backend (section 5 of `SPECS.md`). The extension is a **required
integration and deployment dependency**: a hub that does not carry it
cannot answer `/v1/access-context`, and the backend fails closed
without it.

The patch is against the pinned revision and it does not change the
contract of the gateway: `POST /v1/decisions` answers exactly what it
answered before.

## The files

| File | What it holds |
| --- | --- |
| `0001-access-context-contract.patch` | The patch, against the pinned revision. |
| `apply.sh` | Applies the patch to a checkout and checks the revision. |

## What the patch holds

| File of the hub | What it adds |
| --- | --- |
| `src/domains/authorization/access-context.ts` | The rule of the contract: the facts, the evaluation and the limits. |
| `src/domains/authorization/access-context.test.ts` | The tests of the rule. |
| `src/platform/postgres/access-context.ts` | The statement that reads the complete set of the keys of the grants of the principal and of its groups. |
| `src/app/access-context.ts` | The two endpoints of the contract and the credentials of the deployment. |
| `src/app/access-context.test.ts` | The tests of the protocol. |
| `src/app/app.ts`, `src/app/dependencies.ts` | The routes and the dependencies. |
| `src/runtime/env.ts`, `src/runtime/composition.ts` | `HUB_ACCESS_CONTEXT_TOKENS` and the repository. |
| `docs/spec.md` | The section `8bis`, the contract of the extension, and the environment. |
| `docs/api.md` | The bodies of the requests and of the answers of the two endpoints. |
| `.env.example` | The variable of the credentials of the extension. |

## How to apply it

```bash
git clone https://github.com/ggpwnkthx/hub.git
cd hub
git checkout d488835654ac313aaaeac845d9d7f5c68eb40020
git apply /path/to/depot/integration/hub/0001-access-context-contract.patch
bun install
bun test
```

The script of the directory does the same thing and it refuses a
checkout that is not at the pinned revision:

```bash
./integration/hub/apply.sh /path/to/hub
```

The tests of the hub are the tests of the pinned revision plus the
tests of the extension. The two compatibility tests of the pinned
revision need the `bun` binary in the `PATH` of the process and a
checkout of the gateway; they fail in an environment that has neither,
and they fail the same way without the patch.

## The configuration of the deployment

The credential of the contract is a dedicated read only credential. It
is configured with `HUB_ACCESS_CONTEXT_TOKENS`, a JSON object whose keys
are the bearer tokens and whose values are the lists of the tenants every
token may ask about:

```bash
# A credential of a tenant: it may ask about the tenants of its list.
HUB_ACCESS_CONTEXT_TOKENS='{"the-token-of-the-backend-of-acme":["22222222-2222-4222-8222-222222222222"]}'

# A credential of the platform: it may ask about every tenant. It is a
# choice of the deployment and it is never the default.
HUB_ACCESS_CONTEXT_TOKENS='{"the-token-of-a-shared-backend":null}'
```

The credential of the backend is the one of `DATA_HUB_CONTEXT_TOKEN_FILE`.
The two have to agree: a credential that the hub does not know answers
`401`, and the backend answers `503 AUTHORIZATION_UNAVAILABLE`.

The credential of the access context authorizes the reading of a context
and nothing else. It is not the credential of the gateway
(`HUB_ACCESS_TOKEN`) and it is not the credential of the administration
(`HUB_ADMIN_TOKEN`).

## The compatibility of the gateway

The gateway keeps using `POST /v1/decisions`. The patch does not touch
the endpoint, the rules of the decision or the credentials of the
gateway. The compatibility harness of the data backend proves it: it
runs the pinned gateway against the extended hub and it checks that the
decision of the gateway still allows the principal.

```bash
bun run test:compat
```

## The deployment

The extension is deployed with the hub: a new image, a new version, the
new environment. The backend of a deployment that talks to a hub
without the extension answers `503 AUTHORIZATION_UNAVAILABLE` for every
business request, and the readiness probe fails. The failure is loud on
purpose: the backend does not fall back on the roles of the gateway, on
the administrative credentials of the hub and on the tables of the hub.
