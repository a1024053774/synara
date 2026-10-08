import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createSourceDesktopEnvironment } from "../../apps/desktop/scripts/source-desktop-launch.mjs";

const repo = resolve(import.meta.dirname, "../..");
const home = process.env.A2A_WORKBENCH_DATA_DIR;
if (!home) throw new Error("A2A_WORKBENCH_DATA_DIR is required");
const require = createRequire(join(repo, "apps/desktop/package.json"));
const executable = require("electron");
const args = [join(repo, "apps/desktop/dist-electron/main.js")];
const env = createSourceDesktopEnvironment({
  environment: {
    ...process.env,
    SYNARA_HOME: home,
    SYNARA_DESKTOP_SMOKE_USER_DATA: join(home, "electron-profile"),
    A2A_WORKBENCH: "1",
  },
});
const child = spawn(executable, args, {
  cwd: join(repo, "apps/desktop"),
  env,
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
child.once("spawn", () => {
  const identity = execFileSync(
    "ps",
    ["-p", String(child.pid), "-o", "lstart=", "-o", "command="],
    { encoding: "utf8" },
  ).trim();
  writeFileSync(
    join(home, "workbench-process.json"),
    `${JSON.stringify({ pid: child.pid, identity, executable, args })}\n`,
    { mode: 0o600 },
  );
  child.unref();
});
child.once("error", (error) => {
  throw error;
});
