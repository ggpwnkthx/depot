#!/usr/bin/env bun
/**
 * The mutation gate (spec §16).
 *
 * A test that passes on a correct implementation and on a broken one
 * proves nothing. The suites of this repository were written by the
 * author of the code, and the risk they carry is that they agree with
 * the code because they share its assumptions.
 *
 * The gate answers that risk with a question: **does the suite have
 * power?** It takes the code, breaks it on purpose, and checks that the
 * suite notices. A mutation that survives is a behaviour that nothing
 * in the repository proves, and it is a failure of the gate.
 *
 * The mutations are the ones of the trust boundary and of the paths
 * that the security review names. They are textual and they are
 * reverted: the gate never leaves the repository in a state that it
 * did not find.
 *
 *   bun run scripts/mutation.ts
 *
 * The environment:
 *
 *   MUTATION_ONLY   the name of one mutation, to run one of them
 *   MUTATION_TIMEOUT_MS  the budget of one mutation, in milliseconds
 */

import { readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'bun'

/**
 * The text of a mutation.
 *
 * The placeholder of the code under mutation is written with a section
 * sign: a string that holds `${` is the template of a value, and the
 * text of a mutation is not a template.
 */
function code(text: string): string {
  return text.replace(/\u00a7/g, '$')
}

/** One mutation of the code. */
interface Mutation {
  /** The name of the mutation, and what it breaks. */
  readonly name: string
  /** The file that is mutated. */
  readonly file: string
  /** The text that is replaced. */
  readonly from: string
  /** The text that replaces it. */
  readonly to: string
  /** The suite that must notice the mutation. */
  readonly test: string
}

/**
 * The mutations of the gate.
 *
 * Every one of them breaks a rule that the specification fixes, and
 * every one of them is in a place that the security review names.
 */
const MUTATIONS: readonly Mutation[] = [
  {
    name: 'the type of the protected header is not checked',
    file: 'src/domains/gateway-context/verify.ts',
    from: 'if (header.typ !== IDENTITY_SIGNATURE_TYPE) return false',
    to: 'if (false) return false',
    test: 'test/unit/fuzz.test.ts',
  },
  {
    name: 'the payload of the signature may be transmitted',
    file: 'src/domains/gateway-context/verify.ts',
    from: "if (transmittedPayload !== '') return false",
    to: 'if (false) return false',
    test: 'test/unit/fuzz.test.ts',
  },
  {
    name: 'the critical header of the signature is not refused',
    file: 'src/domains/gateway-context/verify.ts',
    from: 'if (header.crit !== undefined) return false',
    to: 'if (false) return false',
    test: 'test/unit/fuzz.test.ts',
  },
  {
    name: 'the path of the request may name a workspace that is not one',
    file: 'src/domains/gateway-context/verify.ts',
    from: 'if (!isUuid(actual)) return null',
    to: 'if (false) return null',
    test: 'test/unit/gateway-context.test.ts',
  },
  {
    name: 'the expiry of a cursor is not checked',
    file: 'src/domains/records/canonical.ts',
    from: 'if (payload.expiry <= now) {',
    to: 'if (false) {',
    test: 'test/contract/cursor.test.ts',
  },
  {
    name: 'the scope of a cursor is not checked',
    file: 'src/domains/records/canonical.ts',
    from: 'payload.workspace !== expected.workspace ||',
    to: 'false ||',
    test: 'test/contract/cursor.test.ts',
  },
  {
    name: 'the signature of a cursor is not checked',
    file: 'src/domains/records/canonical.ts',
    from: 'if (left.length !== right.length || !timingSafeEqual(left, right)) {',
    to: 'if (false) {',
    test: 'test/contract/cursor.test.ts',
  },
  {
    name: 'a collection without a policy is readable',
    file: 'src/domains/records/service.ts',
    from: `    const policies = this.#readPolicies(context, collection.key)
    if (policies.length === 0) {
      throw new ServiceError('FORBIDDEN')
    }`,
    to: `    const policies = this.#readPolicies(context, collection.key)`,
    test: 'test/contract/projection.test.ts',
  },
  {
    name: 'the predicates of a write are not both of them',
    file: 'src/domains/records/write-guard.ts',
    from: code('return `(§{where}) and (§{check})`'),
    to: code('return `(§{where}) or (§{check})`'),
    test: 'test/integration/write-guard.test.ts',
  },
  {
    name: 'a statement that failed takes the connection of the pool with it',
    file: 'src/platform/postgres/scoped.ts',
    from: '      if (!released) {',
    to: '      if (false) {',
    test: 'test/integration/pool.test.ts',
  },
  {
    name: 'the cache of the context is not bounded',
    file: 'src/domains/authorization/index.ts',
    from: 'while (this.#cache.size > this.#cacheMaxEntries) {',
    to: 'while (false) {',
    test: 'test/unit/context-cache.test.ts',
  },
  {
    name: 'the fields of a row are not the fields of the policies',
    file: 'src/domains/records/service.ts',
    from: code(
      "return `case when §{condition} then jsonb_build_object('§{field}', c§{index}) else '{}'::jsonb end`"
    ),
    to: code("return `jsonb_build_object('§{field}', c§{index})`"),
    test: 'test/contract/mixed-policies.test.ts',
  },
  {
    name: 'the image of a version is written when the change is refused',
    file: 'src/domains/records/write-guard.ts',
    from: code('from pre join updated on true`'),
    to: code('from pre`'),
    test: 'test/integration/versions.test.ts',
  },
  {
    name: 'the policies of the deployment are not evaluated over the image of a version',
    file: 'src/domains/records/service.ts',
    from: code(
      'where §{scopeClause} and §{idClause} and (§{predicate})\n          order by t."version" desc'
    ),
    to: code('where §{scopeClause} and §{idClause}\n          order by t."version" desc'),
    test: 'test/contract/versions.test.ts',
  },
]

/** The budget of one mutation, in milliseconds. */
const TIMEOUT_MS = Number(process.env.MUTATION_TIMEOUT_MS ?? 300_000)

/** Runs a suite and answers its status. */
async function runSuite(path: string): Promise<number> {
  const child = spawn(['bun', 'test', path], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env },
  })
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS)
  const [code] = await new Promise<[number, string]>((resolve) => {
    child.exited.then((exitCode) => resolve([exitCode, '']))
  })
  clearTimeout(timer)
  return code
}

/** The result of one mutation. */
interface Outcome {
  readonly mutation: Mutation
  /** True when the suite noticed the mutation. */
  readonly caught: boolean
  /** The status of the suite. */
  readonly status: number
  /** The reason of the failure, when the mutation was not noticed. */
  readonly problem?: string
}

/** Runs one mutation and answers its outcome. */
async function applyMutation(mutation: Mutation): Promise<Outcome> {
  const original = await readFile(mutation.file, 'utf8')
  if (!original.includes(mutation.from)) {
    return {
      mutation,
      caught: false,
      status: -1,
      problem: `the text of the mutation is not in "${mutation.file}": the mutation is stale`,
    }
  }
  await writeFile(mutation.file, original.replace(mutation.from, mutation.to))
  try {
    const status = await runSuite(mutation.test)
    // The suite must fail: a suite that passes on a broken
    // implementation proves nothing about the behaviour.
    return { mutation, caught: status !== 0, status }
  } finally {
    await writeFile(mutation.file, original)
  }
}

/** Runs the gate. */
async function main(): Promise<void> {
  const only = process.env.MUTATION_ONLY ?? ''
  const selected = only
    ? MUTATIONS.filter((mutation) => mutation.name.includes(only) || mutation.file.includes(only))
    : MUTATIONS
  if (selected.length === 0) {
    console.error(`no mutation matches "${only}"`)
    process.exit(1)
  }
  const outcomes: Outcome[] = []
  for (const mutation of selected) {
    const outcome = await applyMutation(mutation)
    outcomes.push(outcome)
    const state = outcome.caught ? 'caught' : 'SURVIVED'
    console.log(
      JSON.stringify({
        level: outcome.caught ? 'info' : 'error',
        msg: `${state}: ${mutation.name}`,
        file: mutation.file,
        test: mutation.test,
        ...(outcome.problem ? { problem: outcome.problem } : {}),
      })
    )
  }
  const survived = outcomes.filter((outcome) => !outcome.caught)
  console.log(
    JSON.stringify({
      level: survived.length === 0 ? 'info' : 'error',
      msg: `${outcomes.length - survived.length}/${outcomes.length} mutations were caught`,
    })
  )
  if (survived.length > 0) {
    console.error(
      `the gate failed: ${survived.length} mutation(s) survived. The suites do not prove these behaviours.`
    )
    process.exit(1)
  }
}

await main()
