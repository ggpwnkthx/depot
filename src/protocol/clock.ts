/**
 * The clock of the service.
 *
 * The service reads the wall clock for the timestamps it writes and for
 * the answers of the hub, and it reads a monotonic clock for its
 * deadlines: a deadline that is measured against a clock that jumps is
 * not a deadline.
 */

/** The clock of the service. */
export interface Clock {
  /** The milliseconds since the epoch. */
  now: () => number
  /** The milliseconds of a monotonic clock. */
  monotonic: () => number
}

/** The clock of the process. */
export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
}

/** A clock that a test drives. */
export function fixedClock(
  start = 0
): Clock & { advance: (ms: number) => void; set: (ms: number) => void } {
  let wall = start
  let mono = start
  return {
    now: () => wall,
    monotonic: () => mono,
    advance: (ms: number) => {
      wall += ms
      mono += ms
    },
    set: (ms: number) => {
      wall = ms
      mono = ms
    },
  }
}
