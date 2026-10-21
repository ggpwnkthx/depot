/**
 * The schema domain (spec §7).
 *
 * The public entry point of the domain: the manifest of the deployment
 * and the vocabulary of the fields and the relations.
 */

export {
  COLLECTION_KEY_PATTERN,
  type CollectionDefinition,
  type FieldDefinition,
  type FieldType,
  FIELD_TYPES,
  type ManifestBundle,
  MANIFEST_VERSION,
  MAX_MANIFEST_BYTES,
  ManifestError,
  type RelationDefinition,
  type RelationType,
  RELATION_TYPES,
  SEARCH_CONFIG_PATTERN,
  type SearchDefinition,
  SERVER_FIELDS,
  SERVER_FIELD_SET,
  type ServerField,
  canonicalJson,
  contentVersion,
  parseManifestBundle,
} from './manifest'
