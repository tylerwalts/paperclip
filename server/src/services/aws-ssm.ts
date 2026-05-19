import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  StartSessionCommand,
  TerminateSessionCommand,
  type InstanceInformation,
} from "@aws-sdk/client-ssm";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { unprocessable } from "../errors.js";

const execFileP = promisify(execFile);

export interface SsmResolveTagInput {
  region: string;
  awsProfile: string | null;
  tagKey: string;
  tagValue: string;
}

export interface SsmResolvedInstance {
  instanceId: string;
  pingStatus: string;
  computerName: string | null;
  platformType: string | null;
}

export interface SsmSessionHandle {
  sessionId: string;
  process: ChildProcess;
  region: string;
  instanceId: string;
  terminate(): Promise<void>;
}

function buildSsmClient(input: { region: string; awsProfile: string | null }): SSMClient {
  if (input.awsProfile && input.awsProfile.trim().length > 0) {
    return new SSMClient({
      region: input.region,
      credentials: fromIni({ profile: input.awsProfile.trim() }),
    });
  }
  return new SSMClient({ region: input.region });
}

export async function resolveSsmInstanceByTag(
  input: SsmResolveTagInput,
): Promise<SsmResolvedInstance> {
  const tagKey = input.tagKey.trim();
  const tagValue = input.tagValue.trim();
  if (!tagKey || !tagValue) {
    throw unprocessable("SSM tag key and tag value are both required.");
  }

  const client = buildSsmClient(input);
  let response;
  try {
    response = await client.send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: `tag:${tagKey}`, Values: [tagValue] }],
        MaxResults: 50,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw unprocessable(`Failed to query AWS SSM for tag ${tagKey}=${tagValue}: ${message}`);
  } finally {
    client.destroy();
  }

  const matches = (response.InstanceInformationList ?? []).filter(
    (entry): entry is InstanceInformation & { InstanceId: string } =>
      typeof entry.InstanceId === "string" &&
      entry.InstanceId.length > 0 &&
      entry.PingStatus === "Online",
  );

  if (matches.length === 0) {
    throw unprocessable(
      `No online SSM-managed instance matches tag ${tagKey}=${tagValue} in ${input.region}.`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((entry) => entry.InstanceId).join(", ");
    throw unprocessable(
      `Multiple SSM-managed instances match tag ${tagKey}=${tagValue} in ${input.region}: ${ids}. Narrow the tag value to a single host.`,
    );
  }

  const match = matches[0];
  return {
    instanceId: match.InstanceId,
    pingStatus: match.PingStatus ?? "Online",
    computerName: match.ComputerName ?? null,
    platformType: match.PlatformType ?? null,
  };
}

export interface SsmStartSessionInput {
  region: string;
  awsProfile: string | null;
  instanceId: string;
  command?: string[];
}

export async function startSsmSession(input: SsmStartSessionInput): Promise<SsmSessionHandle> {
  const client = buildSsmClient(input);
  let sessionResponse;
  try {
    sessionResponse = await client.send(
      new StartSessionCommand({
        Target: input.instanceId,
        DocumentName: "AWS-StartInteractiveCommand",
        Parameters: {
          command: input.command ?? ["bash", "-l"],
        },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw unprocessable(
      `Failed to start SSM session on ${input.instanceId} in ${input.region}: ${message}`,
    );
  } finally {
    client.destroy();
  }

  if (!sessionResponse.SessionId) {
    throw unprocessable(
      `SSM StartSession returned no SessionId for ${input.instanceId} in ${input.region}.`,
    );
  }

  const endpoint = `https://ssm.${input.region}.amazonaws.com`;
  const requestParams = JSON.stringify({ Target: input.instanceId });

  const child = spawn(
    "session-manager-plugin",
    [
      JSON.stringify(sessionResponse),
      input.region,
      "StartSession",
      input.awsProfile ?? "",
      requestParams,
      endpoint,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const sessionId = sessionResponse.SessionId;

  return {
    sessionId,
    process: child,
    region: input.region,
    instanceId: input.instanceId,
    async terminate() {
      child.kill("SIGTERM");
      const terminateClient = buildSsmClient({ region: input.region, awsProfile: input.awsProfile });
      try {
        await terminateClient.send(
          new TerminateSessionCommand({ SessionId: sessionId }),
        );
      } catch {
        // Best-effort cleanup — the session will expire on its own
      } finally {
        terminateClient.destroy();
      }
    },
  };
}

export interface SsmRunCommandInput {
  region: string;
  awsProfile: string | null;
  instanceId: string;
  command: string;
  timeoutMs?: number;
}

export interface SsmRunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runSsmCommand(input: SsmRunCommandInput): Promise<SsmRunCommandResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const client = buildSsmClient(input);
  let sessionResponse;
  try {
    sessionResponse = await client.send(
      new StartSessionCommand({
        Target: input.instanceId,
        DocumentName: "AWS-StartNonInteractiveCommand",
        Parameters: {
          command: [input.command],
        },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw unprocessable(
      `Failed to start SSM command session on ${input.instanceId} in ${input.region}: ${message}`,
    );
  } finally {
    client.destroy();
  }

  if (!sessionResponse.SessionId) {
    throw unprocessable(
      `SSM StartSession returned no SessionId for ${input.instanceId} in ${input.region}.`,
    );
  }

  const endpoint = `https://ssm.${input.region}.amazonaws.com`;
  const requestParams = JSON.stringify({ Target: input.instanceId });

  const child = spawn(
    "session-manager-plugin",
    [
      JSON.stringify(sessionResponse),
      input.region,
      "StartSession",
      input.awsProfile ?? "",
      requestParams,
      endpoint,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  return new Promise<SsmRunCommandResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: timedOut ? null : code,
        timedOut,
      });
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: error.message,
        exitCode: null,
        timedOut: false,
      });
    });
  });
}

let cliCheckCache: { ok: true } | { ok: false; reason: string } | null = null;

export async function assertSsmCliAvailable(): Promise<void> {
  if (cliCheckCache?.ok === true) return;

  const errors: string[] = [];
  try {
    await execFileP("session-manager-plugin", ["--version"], { timeout: 5_000 });
  } catch (error) {
    errors.push(
      `session-manager-plugin is not installed or not on PATH (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (errors.length > 0) {
    const reason = `${errors.join(" ")} See SSM_AGENT_SETUP.md for install instructions.`;
    cliCheckCache = { ok: false, reason };
    throw unprocessable(reason);
  }
  cliCheckCache = { ok: true };
}
