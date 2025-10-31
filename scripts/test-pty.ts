#!/usr/bin/env ts-node
/**
 * Isolated PTY test to validate node-pty emits data correctly
 * Run: npx ts-node scripts/test-pty.ts
 */
import pty from "node-pty";

console.log("Starting PTY test: progressive output (1-2-3) then exit 7");

const sh = pty.spawn("/bin/bash", ["-lc", "printf 1; sleep 1; printf 2; sleep 1; printf 3; exit 7"], {
  cols: 80,
  rows: 24,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    LANG: "C.UTF-8"
  }
});

sh.onData((data) => {
  process.stdout.write(`[PTY data] ${JSON.stringify(data)}\n`);
});

sh.onExit(({ exitCode, signal }) => {
  console.log(`[PTY exit] code=${exitCode}, signal=${signal}`);
  process.exit(0);
});

// Timeout safety
setTimeout(() => {
  console.error("[TIMEOUT] PTY did not exit in 10s");
  process.exit(1);
}, 10000);
