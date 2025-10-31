import { EventEmitter } from "events";
import pty from "node-pty";
import { AuditTrail } from "@mind-membrane/audit-u4";
import { PolicyEvaluation, validateTerminalRun } from "@mind-membrane/l4";

export interface TerminalStreamEvent {
  type: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  exitCode?: number;
}

export interface TerminalToolContext {
  auditTrail: AuditTrail;
}

export type TerminalToolResponse =
  | {
      mode: "plan";
      evaluation: PolicyEvaluation;
      summary: string;
      requiresApproval: boolean;
    }
  | {
      mode: "denied";
      evaluation: PolicyEvaluation;
    }
  | {
      mode: "execute";
      evaluation: PolicyEvaluation;
      emitter: EventEmitter;
    };

export function createTerminalTool(context: TerminalToolContext) {
  return {
    name: "terminal.run",
    description: "Execute approved commands inside a constrained PTY",
    inputSchema: {
      type: "object",
      properties: {
        bin: { type: "string" },
        args: { type: "array", items: { type: "string" }, default: [] },
        cwd: { type: "string" },
        mode: { type: "string", enum: ["plan", "execute"] },
        timeout_ms: { type: "integer", minimum: 1000, default: 20000 },
        policy_id: { type: "string", default: "policy://terminal/v1/strict" },
        approved: { type: "boolean", default: false }
      },
      required: ["bin", "mode"],
      additionalProperties: false
    },
    async call(rawArgs: unknown): Promise<TerminalToolResponse> {
      const { arguments: args, evaluation } = validateTerminalRun(rawArgs);
      if (evaluation.verdict === "deny") {
        context.auditTrail.recordEvent("terminal.denied", { args, evaluation });
        return { mode: "denied", evaluation };
      }
      if (args.mode === "plan") {
        context.auditTrail.recordEvent("terminal.plan", { args, evaluation });
        const summary = `Binary ${args.bin} with ${args.args.length} args in ${args.cwd ?? "default"}`;
        return {
          mode: "plan",
          evaluation,
          summary,
          requiresApproval: true
        };
      }
      if (!args.approved) {
        const denial: PolicyEvaluation = {
          policyId: evaluation.policyId,
          verdict: "deny",
          reasons: ["Execution requires approved=true"]
        };
        context.auditTrail.recordEvent("terminal.denied", { args, evaluation: denial });
        return { mode: "denied", evaluation: denial };
      }
      const emitter = new EventEmitter();
      const audit = context.auditTrail;
      let timeout: NodeJS.Timeout | undefined;
      try {
        const proc = pty.spawn(args.bin, args.args, {
          name: "xterm-color",
          cols: 120,
          rows: 30,
          cwd: args.cwd,
          env: process.env,
          encoding: "utf8"
        });
        audit.recordEvent("terminal.execute.started", { args });
        timeout = setTimeout(() => {
          audit.recordEvent("terminal.execute.timeout", { args });
          emitter.emit("event", { type: "error", data: "timeout" });
          try {
            proc.kill();
          } catch (error) {
            // ignore
          }
        }, args.timeout_ms);
        proc.onData((data) => {
          emitter.emit("event", { type: "stdout", data });
          audit.recordEvent("terminal.execute.stdout", { length: data.length });
        });
        proc.onExit(({ exitCode }) => {
          if (timeout) {
            clearTimeout(timeout);
          }
          emitter.emit("event", { type: "exit", exitCode: exitCode ?? -1 });
          audit.recordEvent("terminal.execute.exit", { exitCode });
        });
      } catch (error) {
        if (timeout) {
          clearTimeout(timeout);
        }
        const message = error instanceof Error ? error.message : String(error);
        emitter.emit("event", { type: "error", data: message });
        context.auditTrail.recordEvent("terminal.execute.error", { message });
      }
      return { mode: "execute", evaluation, emitter };
    }
  };
}

export type TerminalTool = ReturnType<typeof createTerminalTool>;
