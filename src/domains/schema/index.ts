/**
 * The schema domain (spec §7).
 *
 * The public entry point of the domain: the manifest of the deployment
 * and the vocabulary of the fields and the relations.
 */

export {
  type CollectionDefinition,
  type FieldDefinition,
  type FieldType,
  type ManifestBundle,
  canonicalJson,
  contentVersion,
  parseManifestBundle,
} from './manifest'
