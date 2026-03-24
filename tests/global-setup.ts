import { spawn } from "child_process";

export async function setup() {
  await runCommand("docker", ["compose", "up", "-d", "--wait"]);
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
