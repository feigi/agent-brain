import { spawn } from "child_process";

export async function setup() {
  // Tolerate docker compose failures (e.g., port already bound by another worktree)
  await runCommand("docker", ["compose", "up", "-d", "--wait"]).catch(() => {
    console.error(
      "docker compose up failed (port may be in use) -- assuming DB is already running",
    );
  });
  await runCommand("npx", ["drizzle-kit", "migrate"]);
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit" });
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)),
    );
  });
}
