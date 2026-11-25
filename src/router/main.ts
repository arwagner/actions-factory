import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gitHubPoolStore } from "../pool/store.js";
import { gitHubApi } from "./github.js";
import { runRouter } from "./run.js";

/** The route job's entrypoint: wires `runRouter` to the Actions environment. */
async function main(): Promise<void> {
  const env = (name: string) => process.env[name] || undefined;
  const required = (name: string) => {
    const value = env(name);
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const [owner, repo] = required("GITHUB_REPOSITORY").split("/");
  const temp = required("RUNNER_TEMP");
  await runRouter({
    eventName: required("GITHUB_EVENT_NAME"),
    payload: JSON.parse(readFileSync(required("GITHUB_EVENT_PATH"), "utf8")),
    clientRoot: required("GITHUB_WORKSPACE"),
    factoryRoot: required("FACTORY_ROOT"),
    cacheDir: join(temp, "factory-templates"),
    stubVersion: env("STUB_VERSION"),
    factorySha: env("FACTORY_SHA"),
    factoryToken: env("FACTORY_TOKEN"),
    githubToken: required("GITHUB_TOKEN"),
    api: (token) => gitHubApi(token, owner, repo, env("GITHUB_API_URL")),
    poolEnrolled: env("FACTORY_TOKEN")
      ? async () => Object.keys((await gitHubPoolStore(env("FACTORY_TOKEN")!, owner, repo, env("GITHUB_API_URL")).read()).state.accounts).length > 0
      : undefined,
    runId: Number(env("GITHUB_RUN_ID")) || undefined,
    runUrl: `${env("GITHUB_SERVER_URL")}/${owner}/${repo}/actions/runs/${env("GITHUB_RUN_ID")}`,
    summary: (markdown) => appendFileSync(required("GITHUB_STEP_SUMMARY"), `${markdown}\n`),
    setFailed: (message) => {
      console.log(`::error title=actions-factory doctor::${message}`);
      process.exitCode = 1;
    },
    setOutput: (name, value) => {
      const delimiter = `EOF_${randomUUID()}`;
      appendFileSync(required("GITHUB_OUTPUT"), `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    },
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error title=actions-factory router::${message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")}`);
  process.exit(1);
});
