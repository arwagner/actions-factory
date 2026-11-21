import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { type ConfigError, validateConfig, validateTemplateManifest } from "./validate.js";

/** Fetches `owner/repo` at `ref` and returns the path of a local checkout. */
export type FetchRepo = (repo: { owner: string; repo: string; ref: string }) => Promise<string>;

export interface LoadOptions {
  /** The client repo's checkout. `factory.yml` is at its root. */
  clientRoot: string;
  /** This repo's checkout at the stub's pinned commit. Shipped templates are in `templates/`. */
  factoryRoot: string;
  fetchRepo: FetchRepo;
}

/** One layer of the stack, lowest first. */
export interface Layer {
  /** How errors and the run summary name it, e.g. `template default` or `factory.yml`. */
  name: string;
  /** The folder its relative paths are resolved against. */
  dir: string;
}

export interface LoadResult {
  ok: boolean;
  /** The merged, validated config with defaults filled in. Empty when the stack can't be built. */
  config: Record<string, unknown>;
  errors: ConfigError[];
  /** Dotted field path → name of the layer that last set it. */
  provenance: Record<string, string>;
  layers: Layer[];
  /** Each checkout the stack read from, and the short name paths inside it are shown with. */
  roots: Root[];
}

export interface Root {
  path: string;
  /** `@factory`, `.` for the client repo, or `owner/repo@ref`. */
  label: string;
}

const MAX_DEPTH = 10;
const MANIFEST_FIELDS = ["name", "description", "schemaVersions", "extends"];

type Data = Record<string, unknown>;

/** Where a template's files live: which repo checkout, and the folder inside it. */
interface Place {
  /** Root of the checkout the folder is in; a template can't reach outside it. */
  root: string;
  rootLabel: string;
  dir: string;
  /** How a folder in this checkout is named in messages, given its path from `root`. */
  label: (pathFromRoot: string) => string;
}

class StackError extends Error {
  constructor(
    readonly path: string,
    readonly layer: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads `factory.yml`, resolves its template stack, merges every layer and validates the result. */
export async function loadConfig(options: LoadOptions): Promise<LoadResult> {
  const factoryLayer: Layer = { name: "factory.yml", dir: options.clientRoot };
  try {
    const factoryData = readYaml(join(options.clientRoot, "factory.yml"), "", factoryLayer.name);
    const clientPlace: Place = {
      root: options.clientRoot,
      rootLabel: ".",
      dir: options.clientRoot,
      label: (p) => `./${p}`,
    };
    const templateRef = typeof factoryData.template === "string" ? factoryData.template : "default";
    const templates = await resolveStack(templateRef, clientPlace, options, factoryLayer.name, "template");

    const errors = checkTemplates(templates, factoryData.schemaVersion);
    const layers = [...templates.map((t) => t.layer), factoryLayer];
    const roots = uniqueRoots([
      { path: options.factoryRoot, label: "@factory" },
      { path: options.clientRoot, label: "." },
      ...templates.map((t) => ({ path: t.place.root, label: t.place.rootLabel })),
    ]);
    if (errors.length > 0) return { ok: false, config: {}, errors, provenance: {}, layers, roots };

    const config: Data = {};
    const provenance: Record<string, string> = {};
    for (const t of templates) {
      mergeLayer(config, prepareLayer(stripManifest(t.data), t.layer), t.layer.name, provenance);
    }
    mergeLayer(config, prepareLayer(factoryData, factoryLayer), factoryLayer.name, provenance);

    const validated = validateConfig(config, { provenance });
    return { ...validated, provenance, layers, roots };
  } catch (error) {
    if (!(error instanceof StackError)) throw error;
    const errors = [{ path: error.path, layer: error.layer, message: error.message }];
    return { ok: false, config: {}, errors, provenance: {}, layers: [], roots: [] };
  }
}

interface ResolvedTemplate {
  layer: Layer;
  place: Place;
  data: Data;
}

/** Resolves `ref` and everything it `extends`, returning the stack lowest layer first. */
async function resolveStack(
  ref: string,
  from: Place,
  options: LoadOptions,
  referrer: string,
  field: string,
  seen: string[] = [],
): Promise<ResolvedTemplate[]> {
  const place = await locate(ref, from, options, referrer, field);
  const name = `template ${place.label(relative(place.root, place.dir))}`;
  if (seen.includes(place.dir)) {
    throw new StackError(field, referrer, `extends loops back to ${name}`);
  }
  if (seen.length >= MAX_DEPTH) {
    throw new StackError(field, referrer, `templates extend more than ${MAX_DEPTH} deep`);
  }
  const manifest = join(place.dir, "template.yml");
  if (!existsSync(manifest)) {
    throw new StackError(field, referrer, `no template at ${JSON.stringify(ref)} (expected ${name}/template.yml)`);
  }
  const data = readYaml(manifest, "", name);
  const self: ResolvedTemplate = { layer: { name, dir: place.dir }, place, data };
  if (typeof data.extends !== "string") return [self];
  const below = await resolveStack(data.extends, place, options, name, "extends", [...seen, place.dir]);
  return [...below, self];
}

const REMOTE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([^@]+))?@([^@]+)$/;

async function locate(ref: string, from: Place, options: LoadOptions, referrer: string, field: string): Promise<Place> {
  if (ref.startsWith("./")) {
    const dir = resolve(from.dir, ref);
    const fromRoot = relative(from.root, dir);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new StackError(field, referrer, `${JSON.stringify(ref)} points outside its repo`);
    }
    return { ...from, dir };
  }
  const remote = REMOTE.exec(ref);
  if (remote) {
    const [, owner, repo, path = "", gitRef] = remote;
    let root: string;
    try {
      root = await options.fetchRepo({ owner, repo, ref: gitRef });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new StackError(field, referrer, `couldn't fetch ${owner}/${repo}@${gitRef}: ${reason}`);
    }
    const label = (p: string) => `${owner}/${repo}${p ? `/${p}` : ""}@${gitRef}`;
    return { root, rootLabel: `${owner}/${repo}@${gitRef}`, dir: join(root, path), label };
  }
  const root = options.factoryRoot;
  const label = (p: string) => p.replace(/^templates\//, "");
  return { root, rootLabel: "@factory", dir: join(root, "templates", ref), label };
}

/** Each template must support the config's `schemaVersion`, and its manifest must be well formed. */
function checkTemplates(templates: ResolvedTemplate[], schemaVersion: unknown): ConfigError[] {
  const errors: ConfigError[] = [];
  for (const t of templates) {
    const result = validateTemplateManifest(t.data);
    errors.push(...result.errors.map((e) => ({ ...e, layer: t.layer.name })));
    const supported = t.data.schemaVersions;
    if (result.ok && typeof schemaVersion === "number" && Array.isArray(supported) && !supported.includes(schemaVersion)) {
      errors.push({
        path: "schemaVersions",
        layer: t.layer.name,
        message: `doesn't support schemaVersion ${schemaVersion} (supports ${supported.join(", ")})`,
      });
    }
  }
  return errors;
}

function uniqueRoots(roots: Root[]): Root[] {
  return roots.filter((root, i) => roots.findIndex((r) => r.path === root.path) === i);
}

function stripManifest(data: Data): Data {
  return Object.fromEntries(Object.entries(data).filter(([k]) => !MANIFEST_FIELDS.includes(k)));
}

/** Makes a layer's paths absolute against its folder and reads `instructions` files in. */
function prepareLayer(data: Data, layer: Layer): Data {
  const out = structuredClone(data);
  const abs = (p: unknown) => (typeof p === "string" ? resolve(layer.dir, p) : p);
  if (typeof out.instructions === "string") out.instructions = readInstructions(out.instructions, layer.dir);
  const tasks = out.tasks;
  if (isMap(tasks)) {
    for (const task of Object.values(tasks)) {
      if (!isMap(task)) continue;
      if ("prompt" in task) task.prompt = abs(task.prompt);
      if ("planSchema" in task) task.planSchema = abs(task.planSchema);
      if (typeof task.instructions === "string") task.instructions = readInstructions(task.instructions, layer.dir);
      if (isMap(task.skills)) {
        for (const skill of Object.keys(task.skills)) task.skills[skill] = abs(task.skills[skill]);
      }
      if (isMap(task.hooks)) {
        for (const hook of Object.keys(task.hooks)) task.hooks[hook] = abs(task.hooks[hook]);
      }
    }
  }
  return out;
}

/** `instructions` is a path when that file exists next to the layer; otherwise it is the text itself. */
function readInstructions(value: string, dir: string): string {
  if (value.includes("\n")) return value;
  const path = resolve(dir, value);
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : value;
}

/** True for `instructions` at the top level or directly on a task: those append instead of replacing. */
function appends(path: string): boolean {
  return path === "instructions" || /^tasks\.[^.]+\.instructions$/.test(path);
}

/** Applies one layer: maps merge by key, scalars and lists replace, `null` removes. */
function mergeLayer(base: Data, overlay: Data, layer: string, provenance: Record<string, string>, prefix = ""): void {
  for (const [key, value] of Object.entries(overlay)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value === null) {
      delete base[key];
      forget(provenance, path);
    } else if (appends(path) && typeof base[key] === "string" && typeof value === "string") {
      base[key] = `${base[key]}\n\n${value}`;
      provenance[path] = layer;
    } else if (isMap(value)) {
      if (!isMap(base[key])) {
        base[key] = {};
        forget(provenance, path);
      }
      mergeLayer(base[key] as Data, value, layer, provenance, path);
    } else {
      base[key] = structuredClone(value);
      forget(provenance, path);
      provenance[path] = layer;
    }
  }
}

function forget(provenance: Record<string, string>, path: string): void {
  for (const key of Object.keys(provenance)) {
    if (key === path || key.startsWith(`${path}.`)) delete provenance[key];
  }
}

function readYaml(file: string, path: string, layer: string): Data {
  let data: unknown;
  try {
    data = parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new StackError(path, layer, `couldn't read ${relativeName(file)}: ${reason}`);
  }
  if (data === null || data === undefined) return {};
  if (!isMap(data)) throw new StackError(path, layer, `${relativeName(file)} must be a map of fields`);
  return data;
}

function relativeName(file: string): string {
  return file.endsWith("factory.yml") ? "factory.yml" : "template.yml";
}

function isMap(value: unknown): value is Data {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
