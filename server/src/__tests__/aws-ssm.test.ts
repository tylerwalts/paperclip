import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  StartSessionCommand,
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
    it("rejects when StartSession fails", async () => {
      ssmMock.on(StartSessionCommand).rejects(new Error("SessionLimitExceeded"));
      await expect(
        runSsmCommand({
          region: "us-east-1",
          awsProfile: null,
          instanceId: "i-abc123",
          command: "whoami",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("Failed to start SSM command session"),
      });
    });

    it("rejects when StartSession returns no SessionId", async () => {
      ssmMock.on(StartSessionCommand).resolves({});
      await expect(
        runSsmCommand({
          region: "us-east-1",
          awsProfile: null,
          instanceId: "i-abc123",
          command: "whoami",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("no SessionId"),
      });
    });
  });
});
