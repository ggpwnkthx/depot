/**
 * The description of the API (spec §12).
 *
 * The document describes the fixed protocol: the paths, the envelopes, the
 * headers and the errors. The details of the collections are the runtime
 * metadata of the deployment: they are not in the document, because they
 * change with the deployment and because they depend on the caller.
 */

/** The description of the API. */
export function openapiDocument(schemaVersion: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Headless Data Backend',
      version: schemaVersion,
      description:
        'Permission aware data APIs behind Shuttle. The identity of the caller is carried by the gateway; the caller authenticates at Shuttle.',
    },
    servers: [{ url: '/', description: 'The origin of the deployment.' }],
    security: [],
    paths: {
      '/ws/{workspaceId}/v1/me': {
        get: {
          summary: 'The identity of the caller in the workspace.',
          parameters: [workspaceParameter()],
          responses: {
            200: jsonResponse('The principal, the tenant and the workspace.'),
            401: errorResponse('The request could not be authenticated.'),
            403: errorResponse('The principal has no access to the workspace.'),
          },
        },
      },
      '/ws/{workspaceId}/v1/schema': {
        get: {
          summary: 'The metadata of the collections the caller may use.',
          parameters: [workspaceParameter()],
          responses: {
            200: jsonResponse('The authorized metadata.'),
            401: errorResponse('The request could not be authenticated.'),
          },
        },
      },
      '/ws/{workspaceId}/v1/schema/{collection}': {
        get: {
          summary: 'The metadata of one collection.',
          parameters: [workspaceParameter(), collectionParameter()],
          responses: {
            200: jsonResponse('The authorized metadata of the collection.'),
            404: errorResponse('The collection is not visible.'),
          },
        },
      },
      '/ws/{workspaceId}/v1/items/{collection}': {
        get: {
          summary: 'A bounded, permission aware list.',
          parameters: [
            workspaceParameter(),
            collectionParameter(),
            queryParameter('fields', 'Comma separated field names.', 'string'),
            queryParameter('filter', 'A url encoded json filter.', 'string'),
            queryParameter('sort', 'Up to three fields, `-` for descending.', 'string'),
            queryParameter('limit', 'The size of the page, at most 200.', 'integer'),
            queryParameter('cursor', 'The cursor of the next page.', 'string'),
            queryParameter('include', 'Comma separated relation names.', 'string'),
            queryParameter('include_count', 'Whether the count is returned.', 'boolean'),
          ],
          responses: {
            200: jsonResponse('The page and its meta.'),
            400: errorResponse('The query is not valid.'),
            403: errorResponse('The caller may not read the collection.'),
          },
        },
        post: {
          summary: 'Creates one record.',
          parameters: [
            workspaceParameter(),
            collectionParameter(),
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 1, maxLength: 128 },
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            201: jsonResponse('The receipt of the creation.'),
            409: errorResponse('The key was used with another body, or the operation is running.'),
            422: errorResponse('The body holds invalid values.'),
          },
        },
      },
      '/ws/{workspaceId}/v1/items/{collection}/{id}': {
        get: {
          summary: 'One record and its validator.',
          parameters: [workspaceParameter(), collectionParameter(), idParameter()],
          responses: {
            200: {
              description: 'The canonical representation of the record.',
              headers: { ETag: { schema: { type: 'string' } } },
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            404: errorResponse('The record does not exist or is not readable.'),
          },
        },
        patch: {
          summary: 'Updates one record.',
          parameters: [
            workspaceParameter(),
            collectionParameter(),
            idParameter(),
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              schema: { type: 'string' },
              description: 'The strong validator of the current representation.',
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            200: {
              description: 'The new canonical representation of the record.',
              headers: { ETag: { schema: { type: 'string' } } },
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            400: errorResponse('The validator is not valid.'),
            404: errorResponse('The record does not exist or is not readable.'),
            412: errorResponse('The record changed since the validator was issued.'),
            428: errorResponse('The validator is required.'),
            422: errorResponse('The body holds invalid values.'),
          },
        },
        delete: {
          summary: 'Deletes one record.',
          parameters: [
            workspaceParameter(),
            collectionParameter(),
            idParameter(),
            {
              name: 'If-Match',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            204: { description: 'The record was deleted.' },
            400: errorResponse('The validator is not valid.'),
            404: errorResponse('The record does not exist or is not readable.'),
            412: errorResponse('The record changed since the validator was issued.'),
            428: errorResponse('The validator is required.'),
          },
        },
      },
      '/ws/{workspaceId}/v1/audit': {
        get: {
          summary: 'The audit metadata of the workspace.',
          parameters: [
            workspaceParameter(),
            queryParameter('limit', 'The size of the page.', 'integer'),
            queryParameter('cursor', 'The cursor of the next page.', 'string'),
          ],
          responses: {
            200: jsonResponse('The page of the audit log.'),
            403: errorResponse('The caller does not hold the audit permission.'),
          },
        },
      },
      '/ws/{workspaceId}/v1/openapi.json': {
        get: {
          summary: 'This document.',
          parameters: [workspaceParameter()],
          responses: { 200: jsonResponse('The description of the API.') },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          required: ['error', 'requestId'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['field', 'code'],
                    properties: { field: { type: 'string' }, code: { type: 'string' } },
                  },
                },
              },
            },
            requestId: { type: 'string' },
          },
        },
      },
    },
  }
}

/** The parameter of the workspace. */
function workspaceParameter(): Record<string, unknown> {
  return {
    name: 'workspaceId',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }
}

/** The parameter of a collection. */
function collectionParameter(): Record<string, unknown> {
  return {
    name: 'collection',
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }
}

/** The parameter of a record. */
function idParameter(): Record<string, unknown> {
  return {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  }
}

/** A parameter of a query. */
function queryParameter(name: string, description: string, type: string): Record<string, unknown> {
  return { name, in: 'query', required: false, description, schema: { type } }
}

/** A response with a json body. */
function jsonResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: { 'application/json': { schema: { type: 'object' } } },
  }
}

/** A response with an error envelope. */
function errorResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Error' } },
    },
  }
}
