import { describe, expect, it } from "@effect/vitest";

import { buildKimchiAcpSpawnInput, kimchiAcpPermissionArgs } from "./KimchiAcpSupport.ts";

describe("kimchiAcpPermissionArgs", () => {
  it("passes no flag for the default/approval-required and auto-accept-edits modes", () => {
    expect(kimchiAcpPermissionArgs()).toEqual([]);
    expect(kimchiAcpPermissionArgs("approval-required")).toEqual([]);
    expect(kimchiAcpPermissionArgs("auto-accept-edits")).toEqual([]);
  });

  it("maps Auto and Full access onto Kimchi's --auto and --yolo flags", () => {
    expect(kimchiAcpPermissionArgs("auto")).toEqual(["--auto"]);
    expect(kimchiAcpPermissionArgs("full-access")).toEqual(["--yolo"]);
  });
});

describe("buildKimchiAcpSpawnInput", () => {
  it("defaults to the `kimchi` binary and plain ACP mode", () => {
    const spawn = buildKimchiAcpSpawnInput(undefined, "/tmp/project", undefined, undefined);
    expect(spawn).toEqual({
      command: "kimchi",
      args: ["--mode", "acp"],
      cwd: "/tmp/project",
    });
  });

  it("uses a configured binary path and forwards the environment", () => {
    const spawn = buildKimchiAcpSpawnInput(
      { binaryPath: "/usr/local/bin/kimchi" },
      "/tmp/project",
      { KIMCHI_API_KEY: "secret" },
      "auto",
    );
    expect(spawn).toEqual({
      command: "/usr/local/bin/kimchi",
      args: ["--mode", "acp", "--auto"],
      cwd: "/tmp/project",
      env: { KIMCHI_API_KEY: "secret" },
    });
  });

  it("puts full-access on the argv as --yolo", () => {
    const spawn = buildKimchiAcpSpawnInput(
      { binaryPath: "kimchi" },
      "/tmp/project",
      undefined,
      "full-access",
    );
    expect(spawn.args).toEqual(["--mode", "acp", "--yolo"]);
  });
});
