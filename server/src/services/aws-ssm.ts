import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  SendCommandCommand,
  GetCommandInvocationCommand,
  StartSessionCommand,
  TerminateSessionCommand,
  type InstanceInformation,
} from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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
          command: [input.command?.join(" ") ?? "bash -l"],
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
  stdin?: string;
  timeoutMs?: number;
  /** When true, capture stdout/stderr via S3 to avoid the 24KB GetCommandInvocation limit. */
  largeOutput?: boolean;
  /** S3 bucket for large output capture. Required when largeOutput is true. */
  outputS3Bucket?: string;
}

export interface SsmRunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runSsmCommand(input: SsmRunCommandInput): Promise<SsmRunCommandResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const timeoutSec = Math.max(30, Math.floor(timeoutMs / 1000));

  // For commands that may produce >24KB output, use S3 output capture.
  // This must be checked BEFORE the stdin path since the largeOutput handler
  // also handles stdin (writes it to a file).
  if (input.largeOutput) {
    console.error(`[ssm-largeOutput] activated for instance=${input.instanceId} bucket=${input.outputS3Bucket} hasStdin=${!!(input.stdin?.length)} cmd=${input.command.slice(0, 80)}`);
    return await runSsmCommandLargeOutput(input, timeoutMs, timeoutSec);
  }

  // AWS-RunShellScript doesn't support stdin. When stdin is provided, we
  // upload it to a temp file in chunks first, then redirect it into the command.
  if (input.stdin != null && input.stdin.length > 0) {
    return await runSsmCommandWithStdin(input as SsmRunCommandInput & { stdin: string }, timeoutMs, timeoutSec);
  }


  const client = buildSsmClient(input);
  const command = input.command;

  console.error(`[ssm-run] SendCommand instance=${input.instanceId} timeout=${timeoutSec} cmd=${command.slice(0, 80)}`);

  let commandId: string;
  try {
    const sendResponse = await client.send(
      new SendCommandCommand({
        InstanceIds: [input.instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: {
          commands: [command],
          executionTimeout: [String(timeoutSec)],
        },
        TimeoutSeconds: timeoutSec + 10,
      }),
    );
    commandId = sendResponse.Command?.CommandId ?? "";
    if (!commandId) {
      throw new Error("SendCommand returned no CommandId.");
    }
    console.error(`[ssm-run] CommandId=${commandId}`);
  } catch (error) {
    client.destroy();
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ssm-run] SendCommand FAILED: ${message}`);
    throw unprocessable(
      `Failed to start SSM command session on ${input.instanceId} in ${input.region}: ${message}`,
    );
  }

  const pollIntervalMs = 2000;
  const deadline = Date.now() + timeoutMs + 15_000;
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;

  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let invocation;
      try {
        invocation = await client.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: input.instanceId,
          }),
        );
      } catch (error) {
        const code = (error as { name?: string }).name;
        if (code === "InvocationDoesNotExist") continue;
        throw error;
      }

      const status = invocation.Status;
      if (status === "InProgress" || status === "Pending" || status === "Delayed") {
        continue;
      }

      stdout = invocation.StandardOutputContent ?? "";
      stderr = invocation.StandardErrorContent ?? "";

      if (status === "Success") {
        exitCode = 0;
      } else if (status === "TimedOut") {
        timedOut = true;
      } else if (status === "Failed") {
        exitCode = typeof invocation.ResponseCode === "number" ? invocation.ResponseCode : 1;
      } else {
        exitCode = 1;
      }

      console.error(`[ssm-run] result status=${status} exitCode=${exitCode} timedOut=${timedOut} stdout=${stdout.slice(0, 60)} stderr=${stderr.slice(0, 100)}`);
      break;
    }

    if (exitCode === null && !timedOut) {
      timedOut = true;
    }
  } finally {
    client.destroy();
  }

  return { stdout, stderr, exitCode, timedOut };
}

async function runSsmCommandLargeOutput(
  input: SsmRunCommandInput,
  timeoutMs: number,
  timeoutSec: number,
): Promise<SsmRunCommandResult> {
  const bucket = input.outputS3Bucket;
  if (!bucket) {
    throw new Error("largeOutput requires outputS3Bucket to be set.");
  }

  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const s3Prefix = `ssm-output/${tag}`;
  const client = buildSsmClient(input);

  // Write the command to a script file first (avoids quoting/multiline issues)
  const scriptFile = `/tmp/.paperclip-script-${tag}`;
  const stdinFile = input.stdin ? `/tmp/.paperclip-stdin-${tag}` : null;
  const writeResult = await runSsmCommandWithStdin(
    { ...input, command: `cat > '${scriptFile}' && chmod +x '${scriptFile}'`, stdin: input.command },
    timeoutMs,
    30,
  );
  if (writeResult.exitCode !== 0 || writeResult.timedOut) {
    return writeResult;
  }

  // If stdin is provided, upload it to a file too
  if (stdinFile && input.stdin) {
    const stdinWriteResult = await runSsmCommandWithStdin(
      { ...input, command: `cat > '${stdinFile}'`, stdin: input.stdin },
      timeoutMs,
      30,
    );
    if (stdinWriteResult.exitCode !== 0 || stdinWriteResult.timedOut) {
      return stdinWriteResult;
    }
  }

  // Execute script via SendCommand with S3 output
  const execCommand = stdinFile
    ? `bash '${scriptFile}' < '${stdinFile}'; __rc=$?; rm -f '${scriptFile}' '${stdinFile}'; exit $__rc`
    : `bash '${scriptFile}'; __rc=$?; rm -f '${scriptFile}'; exit $__rc`;
  console.error(`[ssm-largeOutput] executing script=${scriptFile} stdin=${stdinFile} s3Bucket=${bucket} s3Prefix=${s3Prefix} timeoutSec=${timeoutSec}`);
  let commandId: string;
  try {
    const sendResponse = await client.send(
      new SendCommandCommand({
        InstanceIds: [input.instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: {
          commands: [execCommand],
          executionTimeout: [String(timeoutSec)],
        },
        TimeoutSeconds: timeoutSec + 10,
        OutputS3BucketName: bucket,
        OutputS3KeyPrefix: s3Prefix,
      }),
    );
    commandId = sendResponse.Command?.CommandId ?? "";
    if (!commandId) throw new Error("SendCommand returned no CommandId.");
    console.error(`[ssm-largeOutput] commandId=${commandId}`);
  } catch (error) {
    client.destroy();
    const message = error instanceof Error ? error.message : String(error);
    throw unprocessable(`Failed to start SSM command on ${input.instanceId}: ${message}`);
  }

  // Poll for completion
  const pollIntervalMs = 3000;
  const deadline = Date.now() + timeoutMs + 15_000;
  let status = "";
  let responseCode: number | undefined;
  let timedOut = false;

  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let invocation;
      try {
        invocation = await client.send(
          new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: input.instanceId }),
        );
      } catch (error) {
        if ((error as { name?: string }).name === "InvocationDoesNotExist") continue;
        throw error;
      }
      status = invocation.Status ?? "";
      responseCode = invocation.ResponseCode;
      if (status === "InProgress" || status === "Pending" || status === "Delayed") continue;
      break;
    }
    if (!status || status === "InProgress" || status === "Pending" || status === "Delayed") {
      timedOut = true;
    }
  } finally {
    client.destroy();
  }

  if (timedOut) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: true };
  }

  const exitCode = status === "Success" ? 0
    : status === "TimedOut" ? null
    : (typeof responseCode === "number" ? responseCode : 1);

  // Read stdout/stderr from S3
  const s3Client = buildS3Client(input);
  const stdoutKey = `${s3Prefix}/${commandId}/${input.instanceId}/awsrunShellScript/0.awsrunShellScript/stdout`;
  const stderrKey = `${s3Prefix}/${commandId}/${input.instanceId}/awsrunShellScript/0.awsrunShellScript/stderr`;
  console.error(`[ssm-largeOutput] reading S3: bucket=${bucket} stdoutKey=${stdoutKey}`);
  const stdout = await readS3Object(s3Client, bucket, stdoutKey);
  const stderr = await readS3Object(s3Client, bucket, stderrKey);
  s3Client.destroy();
  console.error(`[ssm-largeOutput] S3 read complete: stdout.len=${stdout.length} stderr.len=${stderr.length} exitCode=${exitCode} status=${status}`);

  if (status === "TimedOut") {
    return { stdout, stderr, exitCode: null, timedOut: true };
  }

  return { stdout, stderr, exitCode, timedOut: false };
}

function buildS3Client(input: { region: string; awsProfile: string | null }): S3Client {
  if (input.awsProfile && input.awsProfile.trim().length > 0) {
    return new S3Client({ region: input.region, credentials: fromIni({ profile: input.awsProfile.trim() }) });
  }
  return new S3Client({ region: input.region });
}

async function readS3Object(client: S3Client, bucket: string, key: string): Promise<string> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const content = await response.Body?.transformToString("utf8") ?? "";
    return content;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[ssm-largeOutput] S3 read FAILED: bucket=${bucket} key=${key} error=${msg}`);
    return "";
  }
}

// Max chars per SendCommand printf chunk. Keep well under 100KB API limit.
const SSM_STDIN_CHUNK_SIZE = 32_000;

async function runSsmCommandWithStdin(
  input: SsmRunCommandInput & { stdin: string },
  timeoutMs: number,
  _timeoutSec: number,
): Promise<SsmRunCommandResult> {
  const tmpFile = `/tmp/.paperclip-stdin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stdinData = input.stdin;

  // Upload stdin text in chunks to a temp file using base64 encoding to avoid
  // shell quoting issues with arbitrary content (scripts with quotes, etc).
  const b64Data = Buffer.from(stdinData, "utf8").toString("base64");
  for (let offset = 0; offset < b64Data.length; offset += SSM_STDIN_CHUNK_SIZE) {
    const chunk = b64Data.slice(offset, offset + SSM_STDIN_CHUNK_SIZE);
    const op = offset === 0 ? ">" : ">>";
    const appendCmd = `printf '%s' '${chunk}' ${op} '${tmpFile}.b64'`;
    const chunkResult = await runSsmCommand({
      region: input.region,
      awsProfile: input.awsProfile,
      instanceId: input.instanceId,
      command: appendCmd,
      timeoutMs,
    });
    if (chunkResult.exitCode !== 0 || chunkResult.timedOut) {
      await runSsmCommand({
        region: input.region,
        awsProfile: input.awsProfile,
        instanceId: input.instanceId,
        command: `rm -f '${tmpFile}' '${tmpFile}.b64'`,
        timeoutMs: 30_000,
      });
      return chunkResult;
    }
  }
  // Decode the base64 file to get the original content
  const decodeResult = await runSsmCommand({
    region: input.region,
    awsProfile: input.awsProfile,
    instanceId: input.instanceId,
    command: `base64 -d < '${tmpFile}.b64' > '${tmpFile}' && rm -f '${tmpFile}.b64'`,
    timeoutMs,
  });
  if (decodeResult.exitCode !== 0 || decodeResult.timedOut) {
    await runSsmCommand({
      region: input.region,
      awsProfile: input.awsProfile,
      instanceId: input.instanceId,
      command: `rm -f '${tmpFile}' '${tmpFile}.b64'`,
      timeoutMs: 30_000,
    });
    return decodeResult;
  }

  // Run the actual command with stdin redirected from the temp file.
  // Wrap in a subshell so the redirect feeds stdin to the entire script,
  // not just the last simple command in the pipeline.
  const result = await runSsmCommand({
    region: input.region,
    awsProfile: input.awsProfile,
    instanceId: input.instanceId,
    command: `(${input.command}) < '${tmpFile}'; __exit=$?; rm -f '${tmpFile}'; exit $__exit`,
    timeoutMs,
  });

  return result;
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
