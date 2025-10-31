import { EventEmitter } from "events";
import { spawn } from "child_process";
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
  return {
    name: "citizen.call",
    description: "Invoke a Mind citizen via claude CLI inside WSL",
    inputSchema: {
      type: "object",
      properties: {
        citizen: { type: "string" },
        message: { type: "string" },
        distro: { type: "string", default: "Ubuntu" },
        workdir: { type: "string", default: "~/mindprotocol/consciousness/citizens" },
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
      const escapedMessage = escapeMessage(args.message);
      const continueFlag = args.continue ? "" : " --no-continue";
      const script = `cd ${args.workdir}/${args.citizen} && claude -p "${escapedMessage}"${continueFlag}`;
      audit.recordEvent("citizen.execute.started", { args });
      const proc = spawn("wsl.exe", ["-d", args.distro, "--", "bash", "-lc", script], {
        env: process.env
      });
      proc.stdout?.on("data", (chunk: Buffer) => {
        const data = chunk.toString();
        emitter.emit("event", { type: "stdout", data });
        audit.recordEvent("citizen.execute.stdout", { length: data.length });
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        const data = chunk.toString();
        emitter.emit("event", { type: "stderr", data });
        audit.recordEvent("citizen.execute.stderr", { length: data.length });
      });
      proc.on("close", (code) => {
        emitter.emit("event", { type: "exit", exitCode: code ?? null });
        audit.recordEvent("citizen.execute.exit", { exitCode: code ?? null });
      });
      proc.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        emitter.emit("event", { type: "error", data: message });
        audit.recordEvent("citizen.execute.error", { message });
      });
      return { mode: "execute", evaluation, emitter };
    }
  };
}

export type CitizenTool = ReturnType<typeof createCitizenTool>;
