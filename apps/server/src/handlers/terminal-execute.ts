import * as pty from "node-pty";
import type { Response } from "express";
import { openSSE } from "../sse";

/**
 * Direct PTY → SSE handler (reference implementation)
 *
 * This bypasses EventEmitter abstraction to eliminate any scope/timing issues.
 * If this works, the problem is in the abstraction layer; if not, it's PTY/env.
 */
export function terminalExecuteDirect(args: any, res: Response): void {
  const bin: string = args.bin || "bash";
  const av: string[] = Array.isArray(args.args) ? args.args : [];
  const cwd: string | undefined = args.cwd;
  const timeout_ms: number = Math.max(1000, Number(args.timeout_ms) || 20000);

  const sse = openSSE(res);

  // 1) Build command for shell execution
  const isShell = bin.endsWith("bash") || bin.endsWith("sh");
  let cmd: string;

  if (isShell && av.length > 0) {
    // If first arg is -c or -lc, extract the actual command
    if (av[0] === "-c" || av[0] === "-lc") {
      cmd = av.slice(1).join(" ");
    } else {
      cmd = av.join(" ");
    }
  } else {
    // For non-shell binaries, build command with escaped args
    cmd = [bin, ...av.map(escapeArg)].join(" ");
  }

  const SHELL = process.env.MCP_SHELL || "/bin/bash";
  const SHELL_ARGS = ["-lc", cmd.length ? cmd : "echo"];

  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8"
  };

  // 2) Spawn PTY BEFORE any return
  let term: pty.IPty;
  try {
    term = pty.spawn(SHELL, SHELL_ARGS, {
      name: "xterm-color",
      cols: 120,
      rows: 30,
      cwd,
      env
    });
  } catch (e: any) {
    sse.send("error", { message: "pty.spawn failed", error: String(e) });
    res.end();
    return;
  }

  sse.send("started", {
    shell: SHELL,
    args: SHELL_ARGS,
    pid: term.pid,
    cwd: cwd || process.cwd()
  });

  // 3) Backpressure: pause/resume when socket saturates
  let paused = false;
  const sendChunk = (data: string) => {
    const ok = sse.send("stdout", { chunk: data });
    if (!ok && !paused) {
      term.pause();
      paused = true;
    }
  };

  res.on("drain", () => {
    if (paused) {
      term.resume();
      paused = false;
    }
  });

  // 4) ATTACH CALLBACKS IMMEDIATELY
  term.onData(sendChunk);

  term.onExit(({ exitCode }) => {
    sse.send("exit", { code: exitCode });
    sse.send("result", {
      content: [{ type: "text", text: `Process exited with code ${exitCode}` }]
    });
    res.end();
  });

  // 5) Timeout kills cleanly
  const killer = setTimeout(() => {
    try {
      term.kill();
    } catch (e) {
      // ignore
    }
    sse.send("exit", { code: 124, reason: "timeout" });
    res.end();
  }, timeout_ms);

  res.on("close", () => {
    clearTimeout(killer);
    try {
      term.kill();
    } catch (e) {
      // ignore
    }
  });

  res.on("error", () => {
    clearTimeout(killer);
    try {
      term.kill();
    } catch (e) {
      // ignore
    }
  });
}

function escapeArg(s: string): string {
  // Basic escaping for -lc; L4 policy already blocks &&, |, ;, `
  return `"${s.replace(/"/g, '\\"')}"`;
}
