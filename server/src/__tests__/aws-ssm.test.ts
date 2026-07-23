import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { HttpError } from "../errors.js";
import { resolveSsmInstanceByTag, runSsmCommand } from "../services/aws-ssm.js";

const ssmMock = mockClient(SSMClient);

describe("aws-ssm helpers", () => {
  beforeEach(() => {
    ssmMock.reset();
  });
  afterEach(() => {
    ssmMock.reset();
  });

  describe("resolveSsmInstanceByTag", () => {
    const baseInput = {
      region: "us-east-1",
      awsProfile: null,
      tagKey: "Paperclip",
      tagValue: "runner-prod",
    } as const;

    it("returns the single matching online instance", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [
          {
            InstanceId: "i-deadbeef",
            PingStatus: "Online",
            PlatformType: "Linux",
            ComputerName: "ip-10-0-0-1",
          },
        ],
      });

      const resolved = await resolveSsmInstanceByTag(baseInput);
      expect(resolved.instanceId).toBe("i-deadbeef");
      expect(resolved.platformType).toBe("Linux");
      expect(resolved.pingStatus).toBe("Online");
    });

    it("rejects with unprocessable when no instances match", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [],
      });

      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toBeInstanceOf(HttpError);
      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("No online SSM-managed instance"),
      });
    });

    it("rejects with unprocessable when multiple instances match", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [
          { InstanceId: "i-aaa", PingStatus: "Online" },
          { InstanceId: "i-bbb", PingStatus: "Online" },
        ],
      });

      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("Multiple SSM-managed instances"),
      });
    });

    it("rejects when tagKey or tagValue is empty", async () => {
      await expect(
        resolveSsmInstanceByTag({ ...baseInput, tagKey: "" }),
      ).rejects.toBeInstanceOf(HttpError);
      await expect(
        resolveSsmInstanceByTag({ ...baseInput, tagValue: "   " }),
      ).rejects.toBeInstanceOf(HttpError);
    });

    it("wraps SDK errors in unprocessable with context", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).rejects(new Error("AccessDenied"));
      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("Failed to query AWS SSM"),
      });
    });
  });

  describe("runSsmCommand", () => {
    it("rejects when SendCommand fails", async () => {
      ssmMock.on(SendCommandCommand).rejects(new Error("AccessDenied"));
      await expect(
        runSsmCommand({
          region: "us-east-1",
          awsProfile: null,
          instanceId: "i-abc123",
          command: "whoami",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("Failed to start SSM command"),
      });
    });

    it("rejects when SendCommand returns no CommandId", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: {} });
      await expect(
        runSsmCommand({
          region: "us-east-1",
          awsProfile: null,
          instanceId: "i-abc123",
          command: "whoami",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("SendCommand returned no CommandId"),
      });
    });

    it("returns stdout/stderr when command succeeds", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-123" } });
      ssmMock.on(GetCommandInvocationCommand).resolves({
        Status: "Success",
        StandardOutputContent: "ubuntu\n",
        StandardErrorContent: "",
        ResponseCode: 0,
      });

      const result = await runSsmCommand({
        region: "us-east-1",
        awsProfile: null,
        instanceId: "i-abc123",
        command: "whoami",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ubuntu\n");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
    });

    it("returns exit code when command fails", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-456" } });
      ssmMock.on(GetCommandInvocationCommand).resolves({
        Status: "Failed",
        StandardOutputContent: "",
        StandardErrorContent: "command not found\n",
        ResponseCode: 127,
      });

      const result = await runSsmCommand({
        region: "us-east-1",
        awsProfile: null,
        instanceId: "i-abc123",
        command: "unknown-command",
      });

      expect(result.exitCode).toBe(127);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("command not found\n");
      expect(result.timedOut).toBe(false);
    });

    it("reports timeout when command times out", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-789" } });
      ssmMock.on(GetCommandInvocationCommand).resolves({
        Status: "TimedOut",
        StandardOutputContent: "",
        StandardErrorContent: "",
        ResponseCode: null,
      });

      const result = await runSsmCommand({
        region: "us-east-1",
        awsProfile: null,
        instanceId: "i-abc123",
        command: "sleep 100",
        timeoutMs: 1000,
      });

      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(true);
    });
  });
});
