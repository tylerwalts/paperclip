import type { Db } from "@paperclipai/db";
import type { Environment, EnvironmentLease } from "@paperclipai/shared";
import {
  adapterExecutionTargetToRemoteSpec,
  type AdapterExecutionTarget,
} from "@paperclipai/adapter-utils/execution-target";
import { parseObject } from "../adapters/utils.js";
import { resolveEnvironmentDriverConfigForRuntime } from "./environment-config.js";
import type { EnvironmentRuntimeService } from "./environment-runtime.js";
import { resolveSsmInstanceByTag, runSsmCommand } from "./aws-ssm.js";

export const DEFAULT_SANDBOX_REMOTE_CWD = "/tmp";

// Adapter types that know how to dispatch through AdapterExecutionTarget for
// remote drivers (ssh, ssm, sandbox). Kept as a single source of truth so the
// list does not drift between branches.
const REMOTE_CAPABLE_ADAPTER_TYPES = new Set([
  "acpx_local",
  "codex_local",
  "claude_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
]);

export async function resolveEnvironmentExecutionTarget(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  environment: {
    id?: string;
    driver: string;
    config: Record<string, unknown> | null;
  };
  leaseId?: string | null;
  leaseMetadata: Record<string, unknown> | null;
  lease?: EnvironmentLease | null;
  environmentRuntime?: EnvironmentRuntimeService | null;
}): Promise<AdapterExecutionTarget | null> {
  if (input.environment.driver === "local") {
    return {
      kind: "local",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
    };
  }

  if (input.environment.driver === "sandbox") {
    if (!REMOTE_CAPABLE_ADAPTER_TYPES.has(input.adapterType)) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      id: input.environment.id,
      driver: input.environment.driver as "sandbox",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "sandbox") {
      return null;
    }

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : DEFAULT_SANDBOX_REMOTE_CWD;
    const timeoutMs = "timeoutMs" in parsed.config ? parsed.config.timeoutMs : null;
    const shellCommand =
      input.leaseMetadata?.shellCommand === "bash" || input.leaseMetadata?.shellCommand === "sh"
        ? input.leaseMetadata.shellCommand
        : null;

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: parsed.config.provider,
      shellCommand,
      remoteCwd,
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      timeoutMs,
      // Run-log streaming defaults ON for sandbox environments so agent CLI
      // output reaches the UI mid-run; `streamRunLogs: false` is an explicit
      // opt-out back to batch-at-end delivery.
      streamRunLogs: parsed.config.streamRunLogs !== false,
      runner: input.environmentRuntime && input.lease
        ? {
            supportsSingleStreamStdinProgress: false,
            execute: async (commandInput) => {
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
              });
              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
            // Expose the native file-sync capability only when the provider's
            // worker advertises BOTH sync verbs; otherwise leave syncIn/syncOut
            // undefined so the orchestrator keeps the byte-identical base64 path.
            ...(input.environmentRuntime.supportsSync({
              environment: input.environment as Environment,
              lease: input.lease,
            })
              ? {
                  syncIn: (operations) =>
                    input.environmentRuntime!.syncIn({
                      environment: input.environment as Environment,
                      lease: input.lease!,
                      operations,
                    }),
                  syncOut: (operations) =>
                    input.environmentRuntime!.syncOut({
                      environment: input.environment as Environment,
                      lease: input.lease!,
                      operations,
                    }),
                }
              : {}),
          }
        : undefined,
    };
  }

  if (input.environment.driver === "ssm") {
    if (!REMOTE_CAPABLE_ADAPTER_TYPES.has(input.adapterType)) {
      return null;
    }

    const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
      driver: "ssm",
      config: parseObject(input.environment.config),
    });
    if (parsed.driver !== "ssm") {
      return null;
    }

    const cachedInstanceId =
      typeof input.leaseMetadata?.instanceId === "string" && input.leaseMetadata.instanceId.trim().length > 0
        ? input.leaseMetadata.instanceId.trim()
        : null;
    const instanceId =
      cachedInstanceId ??
      (await resolveSsmInstanceByTag({
        region: parsed.config.region,
        awsProfile: parsed.config.awsProfile,
        tagKey: parsed.config.tagKey,
        tagValue: parsed.config.tagValue,
      })).instanceId;

    const remoteCwd =
      typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
        ? input.leaseMetadata.remoteCwd.trim()
        : parsed.config.remoteWorkspacePath;

    const region = parsed.config.region;
    const awsProfile = parsed.config.awsProfile;

    return {
      kind: "remote",
      transport: "sandbox",
      providerKey: "ssm",
      environmentId: input.environment.id ?? null,
      leaseId: input.leaseId ?? null,
      remoteCwd,
      runner: input.environmentRuntime && input.lease
        ? {
            execute: async (commandInput) => {
              const startedAt = new Date().toISOString();
              const result = await input.environmentRuntime!.execute({
                environment: input.environment as Environment,
                lease: input.lease!,
                command: commandInput.command,
                args: commandInput.args,
                cwd: commandInput.cwd ?? remoteCwd,
                env: commandInput.env,
                stdin: commandInput.stdin,
                timeoutMs: commandInput.timeoutMs,
              });
              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: result.signal ?? null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
          }
        : {
            execute: async (commandInput) => {
              const startedAt = new Date().toISOString();
              const cwd = commandInput.cwd ?? remoteCwd;
              const envPrefix = commandInput.env
                ? Object.entries(commandInput.env).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'"'"'`)}';`).join(" ")
                : "";
              // AWS-RunShellScript already executes through /bin/sh, so when the
              // caller wants `bash -c <script>` or `sh -c <script>`, emit the
              // script directly to avoid double-shell quoting issues.
              let scriptBody: string;
              const cmd = commandInput.command;
              const args = commandInput.args ?? [];
              if ((cmd === "bash" || cmd === "sh") && args[0] === "-c" && args.length >= 2) {
                scriptBody = args.slice(1).join(" ");
              } else {
                const argsStr = args.length
                  ? " " + args.map((a) => `'${a.replace(/'/g, `'"'"'`)}'`).join(" ")
                  : "";
                scriptBody = `${cmd}${argsStr}`;
              }
              const fullCommand = `cd '${cwd.replace(/'/g, `'"'"'`)}' && ${envPrefix}${scriptBody}`;

              const useLargeOutput =
                (commandInput.timeoutMs ?? 60_000) > 300_000 &&
                /\bclaude\b/.test(scriptBody) &&
                /output-format/.test(scriptBody);
              const result = await runSsmCommand({
                region,
                awsProfile,
                instanceId,
                command: fullCommand,
                stdin: commandInput.stdin,
                largeOutput: useLargeOutput,
                outputS3Bucket: useLargeOutput ? (process.env.PAPERCLIP_SSM_OUTPUT_BUCKET || process.env.CONFIG_BUCKET_NAME || "") : undefined,
                timeoutMs: commandInput.timeoutMs ?? 60_000,
              });

              if (result.stdout) await commandInput.onLog?.("stdout", result.stdout);
              if (result.stderr) await commandInput.onLog?.("stderr", result.stderr);
              return {
                exitCode: result.exitCode,
                signal: null,
                timedOut: result.timedOut,
                stdout: result.stdout,
                stderr: result.stderr,
                pid: null,
                startedAt,
              };
            },
          },
    };
  }

  if (
    (
      input.adapterType !== "codex_local" &&
      input.adapterType !== "claude_local" &&
      input.adapterType !== "gemini_local" &&
      input.adapterType !== "opencode_local" &&
      input.adapterType !== "pi_local" &&
      input.adapterType !== "cursor"
    ) ||
    input.environment.driver !== "ssh"
  ) {
    return null;
  }

  const parsed = await resolveEnvironmentDriverConfigForRuntime(input.db, input.companyId, {
    id: input.environment.id,
    driver: input.environment.driver as "ssh",
    config: parseObject(input.environment.config),
  });
  if (parsed.driver !== "ssh") {
    return null;
  }

  const remoteCwd =
    typeof input.leaseMetadata?.remoteCwd === "string" && input.leaseMetadata.remoteCwd.trim().length > 0
      ? input.leaseMetadata.remoteCwd.trim()
      : parsed.config.remoteWorkspacePath;

  return {
    kind: "remote",
    transport: "ssh",
    environmentId: input.environment.id ?? null,
    leaseId: input.leaseId ?? null,
    remoteCwd,
    spec: {
      host: parsed.config.host,
      port: parsed.config.port,
      username: parsed.config.username,
      remoteWorkspacePath: parsed.config.remoteWorkspacePath,
      privateKey: parsed.config.privateKey,
      knownHosts: parsed.config.knownHosts,
      strictHostKeyChecking: parsed.config.strictHostKeyChecking,
      remoteCwd,
    },
  };
}

export async function resolveEnvironmentExecutionTransport(
  input: Parameters<typeof resolveEnvironmentExecutionTarget>[0],
): Promise<Record<string, unknown> | null> {
  return adapterExecutionTargetToRemoteSpec(await resolveEnvironmentExecutionTarget(input)) as Record<string, unknown> | null;
}
