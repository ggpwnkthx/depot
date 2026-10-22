/**
 * The version of the service (spec §14).
 *
 * The package is the source of truth of the version: the image, the
 * standalone binary, the answer of the health probe and the log of the
 * start carry the version of the release that built them. The workflows
 * of the release check that the version of the package is the version of
 * the tag and the version of the image, so the version never drifts away
 * from the release.
 */

import { version as packageVersion } from '../package.json'

/** The version of the service. */
export const SERVICE_VERSION: string = packageVersion
