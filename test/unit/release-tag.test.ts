import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  decideTag,
  parseVersion,
  readProjectVersions,
  writeProjectVersion,
} from '../../scripts/tag-release'

/**
 * The tag of a release (spec §16).
 *
 * The tag names the version of the release, and the workflow of the
 * release runs on it. The rules are three: the versions of the project
 * have to be the same one, the version has to increase, and the
 * comparison of the versions is the comparison of the numbers and not
 * the comparison of the texts.
 */

describe('the versions of the project', () => {
  test('it parses a version', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: '' })
    expect(parseVersion('0.2.0-rc.1')).toEqual({
      major: 0,
      minor: 2,
      patch: 0,
      prerelease: 'rc.1',
    })
  })

  test('it refuses a version that is not of the form major.minor.patch', () => {
    expect(() => parseVersion('1.2')).toThrow()
    expect(() => parseVersion('v1.2.3')).toThrow()
    expect(() => parseVersion('1.2.3.4')).toThrow()
  })

  test('it compares the versions as numbers and not as texts', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1)
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1)
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0)
  })

  test('a pre-release is smaller than the release it precedes', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1)
  })

  test('the three versions of the repository are the same one', () => {
    const versions = readProjectVersions()
    expect(versions.service).toBe(versions.client)
    expect(versions.service).toBe(versions.image)
  })

  test('it writes the version in the three files of the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'depot-version-'))
    try {
      mkdirSync(join(root, 'packages/client'), { recursive: true })
      writeFileSync(
        join(root, 'package.json'),
        '{\n  "name": "data-backend",\n  "version": "0.2.0",\n  "private": true\n}\n'
      )
      writeFileSync(
        join(root, 'packages/client/package.json'),
        '{\n  "name": "@data-backend/client",\n  "version": "0.2.0"\n}\n'
      )
      writeFileSync(
        join(root, 'Dockerfile'),
        'FROM oven/bun:1.4.3\nARG VERSION=0.2.0\nARG REVISION=dev\n'
      )
      const written = writeProjectVersion('1.2.3', root)
      expect(written).toEqual({ service: '1.2.3', client: '1.2.3', image: '1.2.3' })
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"version": "1.2.3"')
      expect(readFileSync(join(root, 'packages/client/package.json'), 'utf8')).toContain(
        '"version": "1.2.3"'
      )
      expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).toContain('ARG VERSION=1.2.3')
      // The rest of the files is untouched.
      expect(readFileSync(join(root, 'Dockerfile'), 'utf8')).toContain('ARG REVISION=dev')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('it refuses a version that is not of the form major.minor.patch', () => {
    const root = mkdtempSync(join(tmpdir(), 'depot-version-'))
    try {
      mkdirSync(join(root, 'packages/client'), { recursive: true })
      writeFileSync(join(root, 'package.json'), '{"version": "0.2.0"}')
      writeFileSync(join(root, 'packages/client/package.json'), '{"version": "0.2.0"}')
      writeFileSync(join(root, 'Dockerfile'), 'ARG VERSION=0.2.0\n')
      expect(() => writeProjectVersion('1.2', root)).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the decision of the tag', () => {
  const versions = { service: '1.0.0', client: '1.0.0', image: '1.0.0' }

  test('it creates the tag when the version increased', () => {
    const decision = decideTag(versions, ['v0.1.0', 'v0.2.0'])
    expect(decision?.tag).toBe('v1.0.0')
    expect(decision?.previous).toBe('v0.2.0')
  })

  test('it creates the tag of the first release', () => {
    const decision = decideTag(versions, [])
    expect(decision?.tag).toBe('v1.0.0')
    expect(decision?.previous).toBe(null)
  })

  test('it creates nothing when the version did not increase', () => {
    expect(decideTag(versions, ['v1.0.0'])).toBe(null)
    expect(decideTag(versions, ['v1.0.1', 'v1.0.0'])).toBe(null)
    expect(decideTag(versions, ['v2.0.0'])).toBe(null)
  })

  test('it ignores the tags that are not versions', () => {
    const decision = decideTag(versions, ['nightly', 'v0.2.0', 'v-anything'])
    expect(decision?.tag).toBe('v1.0.0')
    expect(decision?.previous).toBe('v0.2.0')
  })

  test('the highest tag is the one with the numbers and not the one with the text', () => {
    const decision = decideTag(versions, ['v0.9.0', 'v0.10.0'])
    expect(decision?.previous).toBe('v0.10.0')
  })
})
