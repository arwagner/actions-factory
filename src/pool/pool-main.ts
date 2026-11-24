import { main } from "./cli.js";

main(process.argv.slice(2), process.env, console.log).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
