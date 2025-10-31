import { z } from "zod";

export type PolicyEvaluation = {
  policyId: string;
  verdict: "allow" | "deny";
  reasons: string[];
};

const BINARY_ALLOWLIST = new Set([
  "git",
  "powershell",
  "pwsh",
  "cmd",
  "node",
  "npm",
  "wsl.exe",
  "bash",
  "sh"
]);

const CWD_ALLOWLIST = [
  /^C:\\[\\\\A-Za-z0-9_. -]+$/i,
  /^D:\\[\\\\A-Za-z0-9_. -]+$/i,
  /^\/workspace\//,
  /^\/[A-Za-z0-9_.-]+/,
  /^\.\/?[A-Za-z0-9_.\/-]+$/
];

const SHELL_META_CHARS = /[;&|`]/;

export const terminalRunSchema = z.object({
  bin: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  mode: z.enum(["plan", "execute"]),
  timeout_ms: z.number().int().min(1000).max(300000).default(20000),
  policy_id: z.string().default("policy://terminal/v1/strict"),
  approved: z.boolean().optional()
});

export type TerminalRunArguments = z.infer<typeof terminalRunSchema>;

export const citizenCallSchema = z.object({
  citizen: z.string().min(1),
  message: z.string().min(1),
  distro: z.string().default("Ubuntu"),
  workdir: z.string().default("~/mindprotocol/consciousness/citizens"),
  continue: z.boolean().default(true),
  policy_id: z.string().default("policy://citizen/v1/strict")
});

export type CitizenCallArguments = z.infer<typeof citizenCallSchema>;

const CITIZEN_NAME_REGEX = /^[a-z0-9-]+$/i;
const DISTRO_ALLOWLIST = new Set(["Ubuntu", "Debian", "Alpine", "MindOS"]);

export function evaluateTerminalPolicy(args: TerminalRunArguments): PolicyEvaluation {
  const reasons: string[] = [];
  if (!BINARY_ALLOWLIST.has(args.bin)) {
    reasons.push(`Binary ${args.bin} is not in allowlist`);
  }
  if (args.args.some((value) => SHELL_META_CHARS.test(value))) {
    reasons.push("Arguments contain shell metacharacters");
  }
  if (args.cwd) {
    const allowed = CWD_ALLOWLIST.some((pattern) => pattern.test(args.cwd ?? ""));
    if (!allowed) {
      reasons.push(`Working directory ${args.cwd} is not allowed`);
    }
  }
  if (!args.approved && args.mode === "execute") {
    reasons.push("Execution requires explicit approval flag");
  }
  const verdict: PolicyEvaluation["verdict"] = reasons.length === 0 ? "allow" : "deny";
  return {
    policyId: args.policy_id,
    verdict,
    reasons
  };
}

export function evaluateCitizenPolicy(args: CitizenCallArguments): PolicyEvaluation {
  const reasons: string[] = [];
  if (!CITIZEN_NAME_REGEX.test(args.citizen)) {
    reasons.push("Citizen name contains invalid characters");
  }
  if (!DISTRO_ALLOWLIST.has(args.distro)) {
    reasons.push(`Distribution ${args.distro} is not in allowlist`);
  }
  if (SHELL_META_CHARS.test(args.message)) {
    reasons.push("Message contains disallowed shell metacharacters");
  }
  return {
    policyId: args.policy_id,
    verdict: reasons.length === 0 ? "allow" : "deny",
    reasons
  };
}

export function validateTerminalRun(input: unknown): {
  arguments: TerminalRunArguments;
  evaluation: PolicyEvaluation;
} {
  const argumentsResult = terminalRunSchema.parse(input);
  const evaluation = evaluateTerminalPolicy(argumentsResult);
  return { arguments: argumentsResult, evaluation };
}

export function validateCitizenCall(input: unknown): {
  arguments: CitizenCallArguments;
  evaluation: PolicyEvaluation;
} {
  const argumentsResult = citizenCallSchema.parse(input);
  const evaluation = evaluateCitizenPolicy(argumentsResult);
  return { arguments: argumentsResult, evaluation };
}
