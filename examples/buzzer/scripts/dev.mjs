// Lance le serveur de jeu (rechargé à chaque modification) et Vite, et les arrête ensemble.
// Les arguments sont transmis à Vite : `pnpm dev:buzzer --host` pour jouer depuis un vrai téléphone.
import { spawn } from "node:child_process";

const run = (args) => spawn("pnpm", ["exec", ...args], { stdio: "inherit" });
const children = [
  run(["tsx", "watch", "--conditions=source", "server/index.ts"]),
  run(["vite", ...process.argv.slice(2)]),
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
};
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
for (const child of children) child.on("exit", (code) => stop(code ?? 0));
