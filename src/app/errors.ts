/**
 * The answers of the service (spec §9.7).
 *
 * Every failure answers with the same envelope: the code, a safe message,
 * the details of the fields and the correlation id of the request. The
 * envelope never carries a stack trace, a statement, a name of a
 * constraint, a reason of Hub or a credential.
 */

import type { ErrorCode, ErrorDetail } from '../protocol/errors'
import { ERROR_MESSAGE, type ServiceError } from '../protocol/errors'

/** The envelope of an error. */
export interface ErrorEnvelope {
  error: {
    code: ErrorCode
    message: string
    details?: ErrorDetail[]
  }
  requestId: string
}

/** Builds the envelope of an error. */
export function envelopeFor(error: ServiceError, requestId: string): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    error: {
      code: error.code,
      message: error.message || ERROR_MESSAGE[error.code],
    },
    requestId,
  }
  if (error.details.length > 0) {
    envelope.error.details = [...error.details]
  }
  return envelope
}
