export {
  SCHEMA_VERSION,
  validateConfig,
  validateTemplateManifest,
  type ConfigError,
  type ValidateOptions,
  type ValidationResult,
} from "./config/validate.js";
export { gitFetcher, type GitFetcherOptions } from "./config/fetch.js";
export { loadConfig, type FetchRepo, type Layer, type LoadOptions, type LoadResult, type Root } from "./config/load.js";
export { renderConfig } from "./config/render.js";
