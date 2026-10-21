#!/usr/bin/env bun
/**
 * The architecture check (spec §13).
 *
 * The check reads the imports of the source and it refuses the shapes
 * the specification forbids:
 *
 * - the core of a domain imports nothing but the protocol, its own
 *   domain and the public entry points of the domains it may use
 * - the application imports the public entry points of the domains and
 *   not their internals
 * - there is no cycle between the modules, not even a cycle of types
 * - there is no catch-all directory of shared implementations
 *
 * The command prints the problems and exits with a status of 1 when
 * there is one.
 */

import { access, readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** The domains of the service and the domains they may use. */
export const DOMAIN_MATRIX: Readonly<Record<string, readonly string[]>> = {
  'gateway-context': [],
  workspaces: [],
  schema: [],
  audit: [],
  events: [],
  catalog: ['schema', 'authorization', 'workspaces'],
  authorization: ['gateway-context', 'workspaces', 'schema'],
  records: ['gateway-context', 'workspaces', 'schema', 'authorization', 'audit', 'events'],
}

/** The directories that may not exist: they are the catch-alls. */
const FORBIDDEN_DIRECTORIES = ['shared', 'common', 'utils', 'helpers', 'misc', 'lib']

/** The modules that the core of a domain may not import. */
const FORBIDDEN_IN_DOMAIN = ['hono', 'bun', 'node:fs', 'node:path', 'node:crypto']

/** One import of a file. */
interface Import {
  /** The module that is imported. */
  readonly specifier: string
  /** True when the import is a type only import. */
  readonly typeOnly: boolean
}

/** The files of the source. */
async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await sources(path)))
      continue
    }
    if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

/** Reads the imports of a file. */
function importsOf(source: string): Import[] {
  const found: Import[] = []
  const pattern = /(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g
  let match = pattern.exec(source)
  while (match) {
    found.push({ specifier: match[2] ?? '', typeOnly: Boolean(match[1]) })
    match = pattern.exec(source)
  }
  return found
}

/** The problem of the architecture. */
export interface ArchitectureProblem {
  readonly file: string
  readonly message: string
}

/** Runs the check over the source of the service. */
export async function checkArchitecture(root = 'src'): Promise<ArchitectureProblem[]> {
  const problems: ArchitectureProblem[] = []
  const files = await sources(root)

  // The catch-all directories.
  for (const name of FORBIDDEN_DIRECTORIES) {
    for (const forbidden of [`${root}/${name}`, `${root}/domains/${name}`]) {
      try {
        await readdir(forbidden)
        problems.push({
          file: forbidden,
          message: 'a catch-all directory of shared code is not allowed',
        })
      } catch {
        // The directory does not exist: nothing to refuse.
      }
    }
  }

  // The graph of the modules.
  const graph = new Map<string, string[]>()
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const local: string[] = []
    for (const entry of importsOf(source)) {
      const specifier = entry.specifier
      if (!specifier.startsWith('.')) {
        if (specifier.startsWith('node:')) continue
        // A package: the domains may not depend on the framework.
        const domain = domainOf(file, root)
        if (domain && FORBIDDEN_IN_DOMAIN.includes(specifier)) {
          problems.push({
            file: relative(root, file),
            message: `the core of a domain may not import "${specifier}"`,
          })
        }
        continue
      }
      const target = await resolve(join(dirnameOf(file), specifier))
      if (!target) continue
      local.push(target)
      const targetDomain = domainOf(target, root)
      const sourceDomain = domainOf(file, root)
      if (!sourceDomain) continue
      if (isAdapter(file)) continue
      if (!targetDomain) {
        if (
          target.includes(`${root}/platform`) ||
          target.includes(`${root}/runtime`) ||
          target.includes(`${root}/app`)
        ) {
          problems.push({
            file: relative(root, file),
            message:
              'the core of a domain may not import the platform, the runtime or the application',
          })
        }
        continue
      }
      if (targetDomain === sourceDomain) continue
      const allowed = DOMAIN_MATRIX[sourceDomain] ?? []
      if (!allowed.includes(targetDomain)) {
        problems.push({
          file: relative(root, file),
          message: `the domain "${sourceDomain}" may not use the domain "${targetDomain}"`,
        })
        continue
      }
      // The domain is used through its public entry point.
      if (!isPublicEntry(target)) {
        problems.push({
          file: relative(root, file),
          message: `the domain "${sourceDomain}" must import the public entry point of "${targetDomain}"`,
        })
      }
    }
    graph.set(file, local)
  }

  // The cycles.
  for (const cycle of cycles(graph)) {
    problems.push({ file: cycle.join(' -> '), message: 'the modules have a cycle' })
  }

  return problems
}

/** The directory of a file. */
function dirnameOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/'))
}

/** True when the file is an adapter of a domain. */
function isAdapter(file: string): boolean {
  return file.includes('/adapters/')
}

/** The domain of a file, when it is in a domain. */
function domainOf(file: string, root: string): string | null {
  const normalized = file.split('/').join('/')
  const marker = `${root}/domains/`
  const index = normalized.indexOf(marker)
  if (index < 0) return null
  const rest = normalized.slice(index + marker.length)
  const name = rest.split('/')[0]
  return name ?? null
}

/** True when the file is the public entry point of a domain. */
function isPublicEntry(file: string): boolean {
  return file.endsWith('/index.ts')
}

/** Resolves a specifier to a file of the source. */
async function resolve(base: string): Promise<string | null> {
  const candidates = [`${base}.ts`, `${base}/index.ts`]
  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // The candidate does not exist.
    }
  }
  return null
}

/** The cycles of the graph. */
function cycles(graph: Map<string, string[]>): string[][] {
  const found: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []

  const visit = (node: string): void => {
    const current = state.get(node)
    if (current === 'done') return
    if (current === 'visiting') {
      const index = stack.indexOf(node)
      if (index >= 0) found.push([...stack.slice(index), node])
      return
    }
    state.set(node, 'visiting')
    stack.push(node)
    for (const next of graph.get(node) ?? []) {
      if (graph.has(next)) visit(next)
    }
    stack.pop()
    state.set(node, 'done')
  }

  for (const node of graph.keys()) visit(node)
  return found
}

if (import.meta.main) {
  const problems = await checkArchitecture()
  if (problems.length === 0) {
    console.log(JSON.stringify({ level: 'info', msg: 'the architecture is valid' }))
  } else {
    for (const problem of problems) {
      console.error(`${problem.file}: ${problem.message}`)
    }
    process.exit(1)
  }
}
