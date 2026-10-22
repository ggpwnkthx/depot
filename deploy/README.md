# The deployment of the development machine
#
# The files of this directory are the fixtures of a development machine:
#
# - `bindings.json` holds the routes the deployment accepts, and the
#   verification of the identity of every route: the version of the
#   signature, the algorithm, and the file of the key. The current
#   version is `v5` with `ES256`: the key is the **public** key of the
#   gateway, on the curve P-256, and the gateway holds the private one
#   and signs the identity with it. An upstream that verifies an
#   identity with it cannot mint one.
#
# - `secrets/cursor.key` signs the cursors of the pages. It is a secret
#   of the service and it is not the key of the gateway.
#
# - `secrets/hub-context.token` is the credential of the deployment at
#   the hub of the access context contract.
#
# - `secrets/identity.public.pem` is the public key of the gateway of
#   the development machine. The private key of the pair is not in the
#   repository: the gateway of the machine holds it, and it is generated
#   with the script of the gateway (`bun run identity:key`).
#
# - `secrets/identity.key` is the **legacy** derived key of the gateway
#   (`HMAC-SHA256(SHUTTLE_SESSION_SECRET, "shuttle-identity-signature-v1")`).
#   It is the migration path of a deployment that still shares a key
#   with its gateway, and it is a signing capable secret: it belongs
#   inside the trust boundary of the gateway.
#
# **The values here are the values of a development machine.** They are
# not secrets: they are committed, and anyone who reads the repository
# knows them. A deployment mounts the credentials of its secret manager
# and it never writes them in an image.
#
# The stack of the development machine:
#
#   docker compose up --build
#
# The gateway and the hub are not part of it: they are the services of
# the platform, and the compatibility harness runs the three of them
# together against the real revisions that the manifest
# `compatibility.json` pins:
#
#   bun run test:compat
