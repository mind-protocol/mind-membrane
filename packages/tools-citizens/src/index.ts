import { EventEmitter } from "events";
import pty from "node-pty";
import { AuditTrail } from "@mind-membrane/audit-u4";
import { PolicyEvaluation, validateCitizenCall } from "@mind-membrane/l4";

export interface CitizenStreamEvent {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number | null;
}

export interface CitizenToolContext {
  auditTrail: AuditTrail;
}

export type CitizenToolResponse =
  | {
      mode: "denied";
      evaluation: PolicyEvaluation;
    }
  | {
      mode: "execute";
      evaluation: PolicyEvaluation;
      emitter: EventEmitter;
    };

function escapeMessage(message: string): string {
  return message
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

export function createCitizenTool(context: CitizenToolContext) {
  const defaultWorkdir = process.env.MCP_CITIZEN_WORKDIR || `${process.env.HOME}/mindprotocol/consciousness/citizens`;
  const shell = process.env.MCP_SHELL || "/bin/bash";

  return {
    name: "citizen.call",
    description: "Invoke a Mind citizen via claude CLI (Linux-native execution)",
    inputSchema: {
      type: "object",
      properties: {
        citizen: { type: "string" },
        message: { type: "string" },
        workdir: { type: "string" },
        continue: { type: "boolean", default: true },
        policy_id: { type: "string", default: "policy://citizen/v1/strict" }
      },
      required: ["citizen", "message"],
      additionalProperties: false
    },
    async call(rawArgs: unknown): Promise<CitizenToolResponse> {
      const { arguments: args, evaluation } = validateCitizenCall(rawArgs);
      if (evaluation.verdict === "deny") {
        context.auditTrail.recordEvent("citizen.denied", { args, evaluation });
        return { mode: "denied", evaluation };
      }
      const emitter = new EventEmitter();
      const audit = context.auditTrail;

      // Use workdir from args or default from env
      const workdir = args.workdir || defaultWorkdir;
      const citizenPath = `${workdir}/${args.citizen}`;

      const escapedMessage = escapeMessage(args.message);
      const continueFlag = args.continue ? "-c" : "";
      const cmd = `cd "${citizenPath}" && claude -p "${escapedMessage}" ${continueFlag}`.trim();

      audit.recordEvent("citizen.execute.started", { args, workdir, citizenPath });

      try {
        // Use node-pty for better TTY support (colors, interactive prompts, etc.)
        const proc = pty.spawn(shell, ["-lc", cmd], {
          name: "xterm-color",
          cols: 120,
          rows: 30,
          cwd: workdir,
          env: process.env,
          encoding: "utf8"
        });

        proc.onData((data) => {
          emitter.emit("event", { type: "stdout", data });
          audit.recordEvent("citizen.execute.stdout", { length: data.length });
        });

        proc.onExit(({ exitCode }) => {
          emitter.emit("event", { type: "exit", exitCode: exitCode ?? null });
          audit.recordEvent("citizen.execute.exit", { exitCode: exitCode ?? null });
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitter.emit("event", { type: "error", data: message });
        audit.recordEvent("citizen.execute.error", { message });
      }

      return { mode: "execute", evaluation, emitter };
    }
  };
}

export type CitizenTool = ReturnType<typeof createCitizenTool>;
