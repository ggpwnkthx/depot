import { describe, expect, test } from 'bun:test'
import { ServiceError } from '../../src/protocol/errors'
import {
  breaksConnection,
  driverCodeOf,
  serviceCodeFor,
  serviceErrorFor,
} from '../../src/platform/postgres/errors'

/** Builds the error of the driver, with its SQLSTATE. */
function driverError(code: string): Error {
  const error = new Error(`the server refused: ${code}`)
  ;(error as { code?: string }).code = code
  return error
}

describe('the translation of the failures of the driver', () => {
  test('a lock that was not granted is a conflict', () => {
    expect(serviceCodeFor(driverError('55P03'))).toBe('CONFLICT')
  })

  test('a serialization failure and a deadlock are conflicts', () => {
    expect(serviceCodeFor(driverError('40001'))).toBe('CONFLICT')
    expect(serviceCodeFor(driverError('40P01'))).toBe('CONFLICT')
  })

  test('a unique constraint is a conflict', () => {
    expect(serviceCodeFor(driverError('23505'))).toBe('CONFLICT')
  })

  test('a foreign key is an invalid reference', () => {
    expect(serviceCodeFor(driverError('23503'))).toBe('INVALID_REFERENCE')
  })

  test('a null and a check constraint are a validation failure', () => {
    expect(serviceCodeFor(driverError('23502'))).toBe('VALIDATION_FAILED')
    expect(serviceCodeFor(driverError('23514'))).toBe('VALIDATION_FAILED')
  })

  test('a statement that ran out of time is a deadline', () => {
    expect(serviceCodeFor(driverError('57014'))).toBe('DEADLINE_EXCEEDED')
  })

  test('a connection that is gone is an unavailable database', () => {
    expect(serviceCodeFor(driverError('08006'))).toBe('DATABASE_UNAVAILABLE')
    expect(serviceCodeFor(driverError('ECONNREFUSED'))).toBe('DATABASE_UNAVAILABLE')
    expect(serviceCodeFor(driverError('57P01'))).toBe('DATABASE_UNAVAILABLE')
  })

  test('a defect of the service is not translated', () => {
    // A statement that does not parse and a column that does not exist
    // are defects of the service: they must not be hidden behind a
    // plausible answer.
    expect(serviceCodeFor(driverError('42601'))).toBeNull()
    expect(serviceCodeFor(driverError('42703'))).toBeNull()
    expect(serviceCodeFor(driverError('42P01'))).toBeNull()
    expect(serviceCodeFor(driverError('22012'))).toBeNull()
  })

  test('a failure that is not of the driver is not translated', () => {
    expect(serviceCodeFor(new Error('something else'))).toBeNull()
    expect(serviceCodeFor('a string')).toBeNull()
    expect(serviceCodeFor(undefined)).toBeNull()
  })

  test('an error of the service keeps its code', () => {
    const original = new ServiceError('FORBIDDEN')
    expect(serviceCodeFor(original)).toBe('FORBIDDEN')
    expect(serviceErrorFor(original)).toBe(original)
  })
})

describe('the error of the service for a failure of the driver', () => {
  test('it is the error of the contract and it keeps the cause', () => {
    const cause = driverError('55P03')
    const error = serviceErrorFor(cause)
    expect(error).toBeInstanceOf(ServiceError)
    expect(error?.code).toBe('CONFLICT')
    expect(error?.status).toBe(409)
    // The cause is for the log: it holds the text of the statement.
    expect(error?.cause).toBe(cause)
  })

  test('the message of the answer never holds the reason of the driver', () => {
    const error = serviceErrorFor(driverError('23505'))
    expect(error?.message).not.toContain('23505')
    expect(error?.message).not.toContain('the server refused')
  })
})

describe('the failures that break the connection', () => {
  test('a statement that failed does not break the connection', () => {
    expect(breaksConnection(driverError('55P03'))).toBe(false)
    expect(breaksConnection(driverError('23505'))).toBe(false)
    expect(breaksConnection(driverError('57014'))).toBe(false)
  })

  test('a connection that is gone breaks it', () => {
    expect(breaksConnection(driverError('08006'))).toBe(true)
    expect(breaksConnection(driverError('ECONNRESET'))).toBe(true)
    expect(breaksConnection(driverError('57P01'))).toBe(true)
  })
})

describe('the code of the driver', () => {
  test('it is read from the failure', () => {
    expect(driverCodeOf(driverError('55P03'))).toBe('55P03')
    expect(driverCodeOf(new Error('no code'))).toBeNull()
    expect(driverCodeOf(null)).toBeNull()
  })
})
