/**
 * The budget of the bytes of an answer (spec §9.6).
 *
 * The contract of the API bounds the size of an answer: four mebibytes,
 * expansions included. The bound is a bound of the **resources** of the
 * service and not only of the bytes that leave it: an answer that is
 * built and then refused has already cost the memory of the process and
 * the time of the database.
 *
 * The budget counts the bytes as the answer is built and refuses it as
 * soon as the bound is crossed. The work that is stopped is the work
 * that follows, and the memory that is held is the memory of the rows
 * that were counted.
 *
 * The count is an estimate of the size of the answer, not its exact
 * size: the escaping of the json and the envelope of the answer are
 * counted by the check that follows. The budget refuses early, and the
 * check that follows refuses exactly.
 */

import { ServiceError } from '../../protocol/errors'

/**
 * The budget of the bytes of an answer.
 *
 * The budget is spent by the rows that the answer carries. A row is
 * counted when it is added, and the budget refuses the answer as soon as
 * it is spent.
 */
export class ResponseBudget {
  #bytes = 0
  readonly #limit: number

  constructor(limit: number) {
    this.#limit = limit
  }

  /** The bytes that were counted. */
  get used(): number {
    return this.#bytes
  }

  /** The bound of the budget. */
  get limit(): number {
    return this.#limit
  }

  /**
   * Counts the bytes that the database measured and refuses the answer
   * when the budget is spent.
   *
   * The rows of a page and the rows of an expansion are measured by
   * the statement that built them: the size of the payload is the size
   * of the bytes that the database holds, and the process does not
   * serialize a row to know how big it is.
   */
  addBytes(size: number): number {
    // The separator of the array and the envelope of the answer are
    // counted with every row: the budget is an upper bound of the size
    // of the answer, never a lower one.
    this.#bytes += size + 1
    if (this.#bytes > this.#limit) {
      throw new ServiceError('RESULT_TOO_LARGE')
    }
    return size
  }
}
