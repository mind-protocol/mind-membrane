import { z } from "zod";

export type PolicyEvaluation = {
  policyId: string;
  verdict: "allow" | "deny";
  reasons: string[];
};

// Linux-native binary allowlist (L4 policy v1/strict)
const BINARY_ALLOWLIST = new Set([
  "bash",
  "sh",
  "git",
  "node",
  "npm",
  "python",
  "python3",
  "ls",
  "cat",
  "echo",
  "pwd",
  "cd",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "grep",
  "find",
  "sed",
  "awk",
  "curl",
  "wget",
  "tar",
  "gzip",
  "unzip",
  "docker",
  "kubectl",
  "terraform",
  "ansible",
  "systemctl",
  "journalctl",
  "ps",
  "top",
  "htop",
  "df",
  "du",
  "free",
  "uname",
  "hostname",
  "whoami",
  "which",
  "env",
  "export",
  "source",
  "make",
  "gcc",
  "g++",
  "cargo",
  "rustc",
  "go",
  "java",
  "javac",
  "mvn",
  "gradle",
  "pip",
  "pip3",
  "virtualenv",
  "poetry",
  "composer",
  "ruby",
  "gem",
  "bundle",
  "rails",
  "dotnet",
  "mono",
  "claude"
]);

// Linux/Unix path allowlist (L4 policy v1/strict)
const CWD_ALLOWLIST = [
  /^\/home\/[a-z0-9_-]+/i,           // /home/username or /home/username/*
  /^\/workspace(\/|$)/,              // /workspace or /workspace/*
  /^\/tmp(\/|$)/,                    // /tmp or /tmp/*
  /^\/var\/tmp(\/|$)/,               // /var/tmp or /var/tmp/*
  /^\/opt(\/|$)/,                    // /opt or /opt/*
  /^\/usr\/local(\/|$)/,             // /usr/local or /usr/local/*
  /^\/srv(\/|$)/,                    // /srv or /srv/*
  /^\.\/?[A-Za-z0-9_.\/-]+$/,        // relative paths like ./foo or foo/bar
  /^~\/[A-Za-z0-9_.\/-]+$/           // ~/foo (tilde expansion)
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
  workdir: z.string().optional(), // If not provided, use MCP_CITIZEN_WORKDIR env
  continue: z.boolean().default(true),
  policy_id: z.string().default("policy://citizen/v1/strict")
});

export type CitizenCallArguments = z.infer<typeof citizenCallSchema>;

const CITIZEN_NAME_REGEX = /^[a-z0-9_-]+$/i;

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
  if (SHELL_META_CHARS.test(args.message)) {
    reasons.push("Message contains disallowed shell metacharacters");
  }
  // Validate workdir if provided
  if (args.workdir) {
    const allowed = CWD_ALLOWLIST.some((pattern) => pattern.test(args.workdir ?? ""));
    if (!allowed) {
      reasons.push(`Working directory ${args.workdir} is not allowed`);
    }
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
