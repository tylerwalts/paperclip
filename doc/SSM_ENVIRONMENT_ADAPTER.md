# SSM Environment Adapter

The SSM environment adapter allows Paperclip agents to execute on remote EC2 instances via AWS Systems Manager, without requiring SSH keys, open ports, or VPN connectivity.

## Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│  Paperclip Server   │         │   Target EC2 (Agent) │
│  (EC2 instance)     │         │   (ai-bastion)       │
│                     │         │                      │
│  ┌───────────────┐  │  SSM    │  ┌────────────────┐  │
│  │ Claude Adapter │──┼────────┼──│ Claude Code CLI│  │
│  └───────────────┘  │SendCmd  │  └────────────────┘  │
│         │           │         │         │            │
│  ┌──────┴────────┐  │         │  ┌──────┴─────────┐  │
│  │Callback Bridge│◄─┼─────────┼──│ Bridge Client  │  │
│  └───────────────┘  │  HTTP   │  └────────────────┘  │
│         │           │  queue  │                      │
│  ┌──────┴────────┐  │         │                      │
│  │ Paperclip API │  │         │                      │
│  └───────────────┘  │         │                      │
└─────────────────────┘         └──────────────────────┘
         │
    ┌────┴────┐
    │   S3    │  (stdout/stderr capture for large output)
    └─────────┘
```

## How Commands Execute

All commands on the target instance are executed via `AWS-RunShellScript` using the `SendCommand` / `GetCommandInvocation` API:

1. **Paperclip server** calls `SendCommand` targeting the agent's EC2 instance
2. **SSM agent** on the target runs the command through `/bin/sh`
3. **Paperclip server** polls `GetCommandInvocation` until completion
4. **stdout/stderr** are returned (up to 24KB per stream)

### Command Types

| Command | Path | Notes |
|---------|------|-------|
| Short utility (mkdir, bridge setup) | Standard `SendCommand` | Direct stdout/stderr from `GetCommandInvocation` |
| With stdin (file uploads, bridge entrypoint) | `runSsmCommandWithStdin` | Base64-encodes stdin, uploads in chunks, decodes on remote, redirects to command |
| Main Claude process | `runSsmCommandLargeOutput` | Uploads script to file, executes with S3 output capture |

### Shell Script Extraction

When the adapter passes `command: "sh", args: ["-c", "<script>"]`, the SSM runtime extracts the script body directly (since `AWS-RunShellScript` already runs through a shell). This avoids double-shell interpretation issues.

When the adapter passes `command: "claude", args: ["--print", ...]`, the runtime builds the full command with quoted args.

## Large Output Capture (S3)

`GetCommandInvocation` truncates stdout at 24KB. For the main Claude process (which can produce 100KB+ of JSON stream output), the adapter uses `SendCommand`'s `OutputS3BucketName` parameter:

1. The command script is uploaded to a temp file on the target (`/tmp/.paperclip-script-*`)
2. If stdin is needed (prompt text), it's also uploaded to a temp file
3. `SendCommand` is called with `OutputS3BucketName` and `OutputS3KeyPrefix`
4. SSM agent writes full stdout/stderr to S3 after execution
5. Paperclip reads the output from S3 using `GetObjectCommand`

**Detection**: A command triggers the S3 path when:
- `timeoutMs > 300,000` (5 min — indicates a long-running process)
- `scriptBody` matches `/\bclaude\b/` (contains the CLI binary name)
- `scriptBody` matches `/output-format/` (is the main JSON-streaming invocation)

### S3 Key Structure

```
s3://{bucket}/ssm-output/{timestamp-tag}/{commandId}/{instanceId}/awsrunShellScript/0.awsrunShellScript/stdout
s3://{bucket}/ssm-output/{timestamp-tag}/{commandId}/{instanceId}/awsrunShellScript/0.awsrunShellScript/stderr
```

## Stdin Handling

`AWS-RunShellScript` does not support piping stdin to commands. The adapter works around this by:

1. Base64-encoding the stdin content
2. Uploading in chunks via `printf '%s' '<b64chunk>' >> /tmp/file.b64`
3. Decoding on the remote: `base64 -d < /tmp/file.b64 > /tmp/file`
4. Redirecting into the command: `(command) < /tmp/file`

This supports arbitrary content (shell scripts with quotes, binary data, etc.) without shell quoting issues.

## Callback Bridge

The Claude process communicates with the Paperclip API via a file-based queue bridge:

1. Paperclip uploads a bridge entrypoint script to the target
2. The bridge server starts as a background process (Node.js HTTP server on localhost)
3. Claude Code uses `PAPERCLIP_API_URL=http://127.0.0.1:{port}` for API calls
4. The bridge queues requests as files, Paperclip polls and forwards them to the real API
5. Responses flow back through the same queue mechanism

This avoids needing direct network connectivity from the target to the Paperclip server.

## IAM Requirements

### Paperclip Server Instance Role

```
ssm:SendCommand
ssm:GetCommandInvocation
ssm:DescribeInstanceInformation
ssm:StartSession          (for interactive probe)
ssm:TerminateSession
s3:GetObject              (for reading command output from S3)
```

Resources: target EC2 instances, `AWS-RunShellScript` document, S3 bucket.

### Target Instance (Agent) Role

```
AmazonSSMManagedInstanceCore    (managed policy — SSM agent connectivity)
s3:PutObject                    (for writing command output to S3)
```

The target's S3 permission must cover: `arn:aws:s3:::{bucket}/ssm-output/*`

## Environment Configuration

### Paperclip Server

The following environment variable must be set on the Paperclip server:

```
CONFIG_BUCKET_NAME=skynet-paperclip-config-{stage}-{accountId}
```

This bucket is used for S3 output capture.

### Target Instance

The target needs:
- SSM Agent installed and running
- The CLI binary (`claude`) on `PATH`
- AWS credentials (instance role) with Bedrock access for LLM calls

### Claude Code Settings

For Bedrock-based execution, the Paperclip server needs a Claude config seed at `/home/ubuntu/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_USE_BEDROCK": "1",
    "AWS_REGION": "us-west-2"
  }
}
```

This gets materialized into the remote config directory by the adapter.

## Environment Setup (Paperclip UI)

1. Create an environment with driver **SSM**
2. Set:
   - **Region**: AWS region of the target (e.g. `us-west-2`)
   - **Tag Key**: EC2 tag to identify the target (e.g. `Name`)
   - **Tag Value**: Tag value (e.g. `ai-bastion-twalters`)
   - **Remote Workspace Path**: Absolute path for workspace (e.g. `/paperclip/ai-bastion`)
3. **Test Connection** verifies SSM connectivity and workspace path
4. Assign the environment to an agent

## Timeout Behavior

- `executionTimeout` on `SendCommand`: minimum 30 seconds (AWS requirement)
- Main Claude process: 1800 seconds (30 minutes) default from the adapter
- Utility commands: inherit from caller, typically 30-60 seconds
- Polling interval: 2-3 seconds between `GetCommandInvocation` checks

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Failed to start SSM command session` | IAM permissions or instance not online | Check instance SSM agent status and IAM role |
| `Validation error` on environment save | Extra fields in config | Clear and re-save environment with only SSM fields |
| `mkdir: missing operand` | Shell quoting issue in script | Ensure `sh -c` scripts are extracted correctly |
| `Syntax error: "(" unexpected` | Content with special chars in printf upload | Use base64 encoding for uploads |
| `Failed to parse claude JSON output` | stdout >24KB truncated | Ensure S3 output capture is active (check `CONFIG_BUCKET_NAME` env var) |
| `Sandbox callback bridge entrypoint upload sha mismatch` | stdin upload corruption | Verify base64 encode/decode roundtrip |
| Bridge `Unexpected token` errors | Session noise in output | Ensure `AWS-RunShellScript` is used (not interactive sessions) |

## Code Locations

- SSM command execution: `server/src/services/aws-ssm.ts`
- Environment runtime (execute, lease): `server/src/services/environment-runtime.ts`
- Execution target (fallback runner): `server/src/services/environment-execution-target.ts`
- Environment probe: `server/src/services/environment-probe.ts`
- Config validation: `server/src/services/environment-config.ts`
- UI form: `ui/src/pages/CompanyEnvironments.tsx`
