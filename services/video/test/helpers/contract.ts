// Response validation against the bundled contract (ADR 0004): the body of an operation's response
// is checked with Ajv (JSON Schema 2020-12, as OpenAPI 3.1) against the schema in dist/openapi.json.
// The test copy of the spec is stricter than the contract: object schemas reject undeclared
// properties (unevaluatedProperties: false), so a field the server sends but the contract lacks fails.
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { SPEC_PATH } from '../../src/app/server.ts';

interface ResponseObject {
  $ref?: string;
  content?: Record<string, unknown>;
}

type JsonSchema = Record<string, unknown>;

interface Spec {
  paths: Record<string, Record<string, { operationId?: string; responses?: Record<string, ResponseObject> }>>;
  components: { responses?: Record<string, ResponseObject>; schemas: Record<string, JsonSchema> };
}

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Inlines an allOf of object schemas (ItemDetail = ItemSummary + more) into one object schema. */
function mergeAllOf(node: JsonSchema, schemas: Record<string, JsonSchema>): JsonSchema {
  const parts = (node.allOf as unknown[]).map((p) => {
    const ref = isObj(p) && typeof p.$ref === 'string' ? p.$ref.replace('#/components/schemas/', '') : null;
    return ref ? schemas[ref] : p;
  });
  if (!parts.every((p) => isObj(p) && p.type === 'object' && !p.allOf)) return node;
  const objs = parts as JsonSchema[];
  const rest = Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'allOf'));
  return {
    ...rest,
    type: 'object',
    required: [...new Set(objs.flatMap((p) => (p.required as string[] | undefined) ?? []))],
    properties: Object.assign({}, ...objs.map((p) => p.properties ?? {})) as JsonSchema,
  };
}

function strict(node: unknown, schemas: Record<string, JsonSchema>): unknown {
  if (Array.isArray(node)) return node.map((n) => strict(n, schemas));
  if (!isObj(node)) return node;
  const merged = node.allOf ? mergeAllOf(node, schemas) : node;
  const out = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, strict(v, schemas)]));
  if (isObj(out.properties) && out.additionalProperties === undefined && out.unevaluatedProperties === undefined) {
    out.unevaluatedProperties = false;
  }
  return out;
}

const raw = JSON.parse(readFileSync(SPEC_PATH, 'utf8')) as Spec & Record<string, unknown>;
const spec = strict(raw, raw.components.schemas) as Spec & Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats is CommonJS: depending on the loader the default import is the plugin or wraps it.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (a: Ajv2020) => void;
addFormats(ajv);
ajv.addSchema({ ...spec, $id: 'spec.json' });

/** Statuses any route may answer without declaring them (ADR 0004): request validation and the security handler. */
const IMPLICIT: Record<number, string> = { 400: 'VALIDATION_FAILED', 401: 'UNAUTHORIZED' };
const PROBLEM = { ref: 'spec.json#/components/schemas/Problem', contentType: 'application/problem+json' };

const pointer = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');

function locate(operationId: string, status: number): { ref: string; contentType: string; implicitCode?: string } {
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.operationId !== operationId) continue;
      const response = op.responses?.[String(status)];
      if (!response) {
        const code = IMPLICIT[status];
        if (code) return { ...PROBLEM, implicitCode: code };
        throw new Error(`${operationId} does not declare a ${status} response in the contract`);
      }
      const shared = response.$ref?.replace('#/components/responses/', '');
      const content = shared ? spec.components.responses?.[shared]?.content : response.content;
      if (!content) throw new Error(`${operationId} has no ${status} response body in the contract`);
      const contentType = Object.keys(content)[0]!;
      const base = shared ? `#/components/responses/${pointer(shared)}` : `#/paths/${pointer(path)}/${method}/responses/${status}`;
      return { ref: `spec.json${base}/content/${pointer(contentType)}/schema`, contentType };
    }
  }
  throw new Error(`unknown operation ${operationId}`);
}

/** Errors of a body against the contract response of operationId with that status; [] when valid. */
export function contractErrors(operationId: string, status: number, body: unknown): string[] {
  const { ref, implicitCode } = locate(operationId, status);
  const validate = ajv.getSchema(ref) ?? ajv.compile({ $ref: ref });
  const errors = validate(body) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''} ${JSON.stringify(e.params)}`);
  const code = isObj(body) ? body.code : undefined;
  if (implicitCode && code !== implicitCode) {
    errors.push(`/code: an undeclared ${status} is only allowed as ${implicitCode}, got ${JSON.stringify(code)}`);
  }
  return errors;
}
