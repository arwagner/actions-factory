import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import defs from "./schema/defs.schema.json" with { type: "json" };
import factorySchema from "./schema/factory.schema.json" with { type: "json" };
import templateSchema from "./schema/template.schema.json" with { type: "json" };
import { checkHardRules, type SchemaValidConfig } from "./rules.js";

/** One validation problem in a merged config. */
export interface ConfigError {
  /** Dotted field path, e.g. `tasks.review.agent`. Empty for the root. */
  path: string;
  /** The layer that set the field, when a provenance map was supplied. */
  layer?: string;
  message: string;
}

export interface ValidateOptions {
  /** Dotted field path → name of the layer that last set it. */
  provenance?: Record<string, string>;
}

export interface ValidationResult {
  ok: boolean;
  errors: ConfigError[];
  /** A copy of the input with the spec's defaults filled in. */
  config: Record<string, unknown>;
}

/** The only `schemaVersion` this release understands. */
export const SCHEMA_VERSION = 1;

const ajv = new Ajv2020({ allErrors: true, useDefaults: true, strict: false, verbose: true });
ajv.addSchema(defs).addSchema(templateSchema);
const validateFactory = ajv.compile(factorySchema);

/**
 * A template layer is a partial overlay, so only its manifest fields and its
 * top-level key names are checked here, with no defaults filled in. The rest
 * is checked once all layers are merged.
 */
const layerKeys = Object.fromEntries(Object.keys(defs.$defs.topLevel.properties).map((key) => [key, {}]));
const validateManifest = new Ajv2020({ allErrors: true, strict: false }).compile({
  ...templateSchema,
  $id: undefined,
  allOf: undefined,
  properties: { ...templateSchema.properties, ...layerKeys, extends: defs.$defs.templateRef },
});

/** Validates a merged config (all layers applied) against `schemaVersion: 1`. */
export function validateConfig(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const config = structuredClone(input) as Record<string, unknown>;
  const errors: ConfigError[] = [];
  const version = (config as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version !== undefined && version !== SCHEMA_VERSION) {
    const message = `unsupported schemaVersion ${JSON.stringify(version)}; this factory supports ${SCHEMA_VERSION}`;
    errors.push({ path: "schemaVersion", message });
    return { ok: false, errors: withLayers(errors, options.provenance), config };
  }
  if (!validateFactory(config)) {
    errors.push(...collapseAlternatives(validateFactory.errors ?? []).map(toConfigError).sort(byPath));
  } else {
    errors.push(...checkHardRules(config as unknown as SchemaValidConfig));
  }
  return { ok: errors.length === 0, errors: withLayers(errors, options.provenance), config };
}

/** Checks a `template.yml` manifest's own fields and top-level keys. */
export function validateTemplateManifest(input: unknown): ValidationResult {
  const config = structuredClone(input) as Record<string, unknown>;
  const errors = validateManifest(config)
    ? []
    : collapseAlternatives(validateManifest.errors ?? []).map(toConfigError).sort(byPath);
  return { ok: errors.length === 0, errors, config };
}

function toConfigError(e: ErrorObject): ConfigError {
  const segments = e.instancePath.split("/").slice(1).map(unescapePointer);
  if (e.keyword === "required") {
    return { path: [...segments, e.params.missingProperty].join("."), message: "required" };
  }
  if (e.keyword === "oneOf" || e.keyword === "pattern") {
    const description = (e.parentSchema as { description?: string } | undefined)?.description;
    return { path: segments.join("."), message: description ? `invalid: ${description}` : "has an invalid format" };
  }
  if (e.keyword === "enum") {
    return { path: segments.join("."), message: `must be one of: ${e.params.allowedValues.join(", ")}` };
  }
  const unknown = e.params.additionalProperty ?? e.params.unevaluatedProperty;
  if (unknown !== undefined) {
    return { path: [...segments, unknown].join("."), message: "unknown field" };
  }
  return { path: segments.join("."), message: e.message ?? "is invalid" };
}

/** Keeps a failed `oneOf` as one error, dropping the errors from each branch it tried. */
function collapseAlternatives(errors: ErrorObject[]): ErrorObject[] {
  const failed = errors.filter((e) => e.keyword === "oneOf");
  const isBranchOf = (e: ErrorObject, alt: ErrorObject) =>
    e.schemaPath.startsWith(`${alt.schemaPath}/`) && e.instancePath.startsWith(alt.instancePath);
  return errors.filter((e) => !failed.some((alt) => isBranchOf(e, alt)));
}

function unescapePointer(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function byPath(a: ConfigError, b: ConfigError): number {
  return a.path.localeCompare(b.path);
}

function withLayers(errors: ConfigError[], provenance?: Record<string, string>): ConfigError[] {
  if (!provenance) return errors;
  return errors.map((error) => {
    const layer = closestLayer(error.path, provenance);
    return layer === undefined ? error : { path: error.path, layer, message: error.message };
  });
}

/** The layer recorded for the path itself, or else for its nearest ancestor. */
function closestLayer(path: string, provenance: Record<string, string>): string | undefined {
  const segments = path.split(".");
  for (let n = segments.length; n > 0; n--) {
    const layer = provenance[segments.slice(0, n).join(".")];
    if (layer !== undefined) return layer;
  }
  return undefined;
}
