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
export { COMMANDS, route, type Command, type Decision, type RefusalCode, type RouteInput, type Subject } from "./router/route.js";
export { MIN_STUB_VERSION, STUB_VERSION } from "./router/version.js";
export { gitHubApi, type GitHubApi, type Label } from "./router/github.js";
export { runRouter, type RouterIO } from "./router/run.js";
