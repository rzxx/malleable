import { spawn } from "node:child_process";

const pnpmCli = process.env.npm_execpath;

if (!pnpmCli) {
  throw new Error("pnpm dev must be run through pnpm so npm_execpath is available");
}

function spawnPnpm(args) {
  const isJavaScriptCli =
    pnpmCli.endsWith(".cjs") || pnpmCli.endsWith(".mjs") || pnpmCli.endsWith(".js");
  return spawn(
    isJavaScriptCli ? process.execPath : pnpmCli,
    isJavaScriptCli ? [pnpmCli, ...args] : args,
    {
      stdio: "inherit"
    }
  );
}

const children = [
  spawnPnpm(["--filter", "@malleable/daemon", "dev"]),
  spawnPnpm(["--filter", "@malleable/shell", "dev"])
];

let shuttingDown = false;

function stopChildren() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    stopChildren();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

process.on("SIGINT", () => {
  stopChildren();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopChildren();
  process.exit(143);
});
