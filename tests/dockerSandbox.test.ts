import test from "node:test";
import * as assert from "node:assert";
import {
  buildMinimalDockerEnv,
  LocalDockerExecutor,
  resolveContainerRunnerExecutable,
  buildVerificationDockerRunArgs,
  pipePathToDockerHost,
  DOCKER_HOST_CLI_ARG,
  DOCKER_DESKTOP_LINUX_PIPE,
  DOCKER_CLASSIC_ENGINE_PIPE,
  type IDockerExecutor,
  type ContainerRunOptions,
  type ContainerRunResult,
} from "../src/verification/dockerSandbox.js";
import { DEFAULT_VERIFICATION_LIMITS } from "../src/verification/types.js";

test("dockerSandbox - Minimal Environment & Mocked Sandbox Supervision Suite", async (t) => {
  await t.test("buildMinimalDockerEnv should strictly omit API keys and custom DOCKER_* variables", () => {
    // Set dummy environment variables to simulate host secrets
    process.env.GEMINI_API_KEY = "super-secret-gemini-key";
    process.env.DOCKER_HOST = "tcp://malicious-remote-server:2375";
    process.env.DOCKER_CONTEXT = "remote-context";
    process.env.DOCKER_TLS_VERIFY = "1";

    const cleanEnv = buildMinimalDockerEnv();

    assert.strictEqual(cleanEnv.GEMINI_API_KEY, undefined);
    assert.strictEqual(cleanEnv.DOCKER_HOST, undefined);
    assert.strictEqual(cleanEnv.DOCKER_CONTEXT, undefined);
    assert.strictEqual(cleanEnv.DOCKER_TLS_VERIFY, undefined);

    // Assert essential system paths are present
    assert.ok(cleanEnv.SystemRoot, "Expected SystemRoot to be defined");
    assert.ok(cleanEnv.SystemDrive, "Expected SystemDrive to be defined");
    assert.ok(cleanEnv.PATH, "Expected PATH to be defined");
  });

  await t.test("mock executor should simulate output limit termination and buffer truncation", async () => {
    const mockExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: true };
      },
      async inspectImageId() {
        return { matches: true, actualId: "sha256:mock" };
      },
      async runCanaryWriteProbe() {
        return { success: true };
      },
      async executeTestRun(options: ContainerRunOptions): Promise<ContainerRunResult> {
        return {
          exitCode: null,
          stdout: "[VERIFIER WARNING: Output limit of 524288 bytes exceeded. Process terminated.]",
          stderr: "",
          outputTruncated: true,
          durationMs: 500,
          timedOut: false,
          outputLimitExceeded: true,
          containerStoppedConfirmed: true,
          warnings: ["Output limit exceeded"],
        };
      },
    };

    const runResult = await mockExecutor.executeTestRun({
      stagingPath: "/tmp/staged",
      imageId: "sha256:mock",
      command: {
        runnerId: "tsx-node-test",
        executable: "/node_modules/.bin/tsx",
        args: ["--test"],
        targetTestFiles: ["tests/sample.test.ts"],
      },
    });

    assert.strictEqual(runResult.outputLimitExceeded, true);
    assert.strictEqual(runResult.outputTruncated, true);
    assert.ok(runResult.stdout.includes("Output limit of 524288 bytes exceeded"));
  });

  await t.test("mock executor should simulate timeout termination", async () => {
    const mockExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: true };
      },
      async inspectImageId() {
        return { matches: true };
      },
      async runCanaryWriteProbe() {
        return { success: true };
      },
      async executeTestRun(): Promise<ContainerRunResult> {
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          durationMs: 30000,
          timedOut: true,
          outputLimitExceeded: false,
          containerStoppedConfirmed: true,
          warnings: ["Execution timed out"],
        };
      },
    };

    const result = await mockExecutor.executeTestRun({
      stagingPath: "/tmp/staged",
      imageId: "sha256:mock",
      command: {
        runnerId: "tsx-node-test",
        executable: "/node_modules/.bin/tsx",
        args: ["--test"],
        targetTestFiles: ["tests/sample.test.ts"],
      },
    });

    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.exitCode, null);
  });

  await t.test("mock executor should record unconfirmed container termination warning", async () => {
    const mockExecutor: IDockerExecutor = {
      async checkAvailability() {
        return { available: true };
      },
      async inspectImageId() {
        return { matches: true };
      },
      async runCanaryWriteProbe() {
        return { success: true };
      },
      async executeTestRun(): Promise<ContainerRunResult> {
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          outputTruncated: false,
          durationMs: 30000,
          timedOut: true,
          outputLimitExceeded: false,
          containerStoppedConfirmed: false,
          warnings: [
            "Warning: Container termination or removal could not be confirmed with the Docker daemon. A residual container may still be running in the background.",
          ],
        };
      },
    };

    const result = await mockExecutor.executeTestRun({
      stagingPath: "/tmp/staged",
      imageId: "sha256:mock",
      command: {
        runnerId: "tsx-node-test",
        executable: "/node_modules/.bin/tsx",
        args: ["--test"],
        targetTestFiles: ["tests/sample.test.ts"],
      },
    });

    assert.strictEqual(result.containerStoppedConfirmed, false);
    assert.ok(result.warnings.some((w) => w.includes("Container termination or removal could not be confirmed")));
  });

  await t.test("LocalDockerExecutor should strictly reject mutable image tags in inspectImageId", async () => {
    const executor = new LocalDockerExecutor();
    const result = await executor.inspectImageId("repo-assistant-verifier:local");
    assert.strictEqual(result.matches, false);
    assert.ok(result.reason?.includes("Expected canonical 64-character SHA-256 local Image ID"));
  });

  await t.test("LocalDockerExecutor should strictly reject mutable image tags in runCanaryWriteProbe", async () => {
    const executor = new LocalDockerExecutor();
    const result = await executor.runCanaryWriteProbe("C:\\fake\\staging", "node:20-slim");
    assert.strictEqual(result.success, false);
    assert.ok(result.reason?.includes("Security policy violation"));
  });

  await t.test("LocalDockerExecutor should strictly reject mutable image tags in executeTestRun", async () => {
    const executor = new LocalDockerExecutor();
    const result = await executor.executeTestRun({
      stagingPath: "C:\\fake\\staging",
      imageId: "repo-assistant-verifier:latest",
      command: {
        runnerId: "tsx-node-test",
        executable: "/node_modules/.bin/tsx",
        args: ["--test"],
        targetTestFiles: ["tests/sample.test.ts"],
      },
    });

    assert.strictEqual(result.exitCode, -1);
    assert.ok(result.stderr.includes("Execution with mutable tags is strictly forbidden"));
    assert.ok(result.warnings.some((w) => w.includes("Refused container execution")));
  });

  await t.test("resolveContainerRunnerExecutable should strictly canonicalize runner and reject workspace-local paths", () => {
    // Valid forms
    assert.strictEqual(resolveContainerRunnerExecutable("tsx"), "/node_modules/.bin/tsx");
    assert.strictEqual(resolveContainerRunnerExecutable("/node_modules/.bin/tsx"), "/node_modules/.bin/tsx");

    // Rejected forms
    assert.throws(
      () => resolveContainerRunnerExecutable("/workspace/tsx"),
      (err: any) => err.message.includes("Security policy violation") && err.message.includes("/workspace/tsx")
    );
    assert.throws(
      () => resolveContainerRunnerExecutable("./tsx"),
      (err: any) => err.message.includes("Security policy violation")
    );
    assert.throws(
      () => resolveContainerRunnerExecutable("bash"),
      (err: any) => err.message.includes("Security policy violation")
    );
  });

  await t.test("buildVerificationDockerRunArgs should inject container PATH and enforce root runner binary", () => {
    const args = buildVerificationDockerRunArgs(
      {
        stagingPath: "C:\\staged\\workspace",
        imageId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        command: {
          runnerId: "tsx-node-test",
          executable: "tsx", // Passes "tsx", must be canonicalized
          args: ["--test", "tests/foo.test.ts"],
          targetTestFiles: ["tests/foo.test.ts"],
        },
      },
      "test-container-123",
      DEFAULT_VERIFICATION_LIMITS
    );

    // Verify container PATH injection
    const envIndex = args.indexOf("--env");
    assert.ok(envIndex !== -1, "Expected --env flag in docker args");
    assert.strictEqual(
      args[envIndex + 1],
      "PATH=/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    );

    // Verify executable is root-level /node_modules/.bin/tsx and NOT relative or /workspace/tsx
    assert.ok(args.includes("/node_modules/.bin/tsx"), "Expected /node_modules/.bin/tsx in args");
    assert.ok(!args.includes("/workspace/tsx"), "Did not expect /workspace/tsx in args");

    // Verify sandbox isolation flags
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--network") && args[args.indexOf("--network") + 1] === "none");
    assert.ok(args.includes("--pull") && args[args.indexOf("--pull") + 1] === "never");
    assert.ok(args.includes("--user") && args[args.indexOf("--user") + 1] === "1000:1000");
  });

  await t.test("LocalDockerExecutor should reject unauthorized or workspace-local runner executable", async () => {
    const executor = new LocalDockerExecutor();
    const result = await executor.executeTestRun({
      stagingPath: "C:\\staged\\workspace",
      imageId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      command: {
        runnerId: "tsx-node-test",
        executable: "/workspace/tsx", // Attempt to execute from workspace
        args: ["--test"],
        targetTestFiles: ["tests/foo.test.ts"],
      },
    });

    assert.strictEqual(result.exitCode, -1);
    assert.ok(result.stderr.includes("Security policy violation"));
    assert.ok(result.warnings.some((w) => w.includes("unauthorized or workspace-local runner executable")));
  });

  await t.test("pipePathToDockerHost should canonicalize Windows named pipes and Unix domain sockets", () => {
    assert.strictEqual(
      pipePathToDockerHost("\\\\.\\pipe\\dockerDesktopLinuxEngine"),
      "npipe:////./pipe/dockerDesktopLinuxEngine"
    );
    assert.strictEqual(
      pipePathToDockerHost("//./pipe/dockerDesktopLinuxEngine"),
      "npipe:////./pipe/dockerDesktopLinuxEngine"
    );
    assert.strictEqual(
      pipePathToDockerHost("\\\\.\\pipe\\docker_engine"),
      "npipe:////./pipe/docker_engine"
    );
    assert.strictEqual(
      pipePathToDockerHost("/var/run/docker.sock"),
      "unix:///var/run/docker.sock"
    );
    // Already formatted URLs should pass through unchanged
    assert.strictEqual(
      pipePathToDockerHost("npipe:////./pipe/dockerDesktopLinuxEngine"),
      "npipe:////./pipe/dockerDesktopLinuxEngine"
    );
    assert.strictEqual(
      pipePathToDockerHost("unix:///var/run/docker.sock"),
      "unix:///var/run/docker.sock"
    );
  });

  await t.test("buildVerificationDockerRunArgs should pin -H endpoint before run command when hostTarget is provided", () => {
    const pinnedHost = "npipe:////./pipe/dockerDesktopLinuxEngine";
    const args = buildVerificationDockerRunArgs(
      {
        stagingPath: "C:\\staged\\workspace",
        imageId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        command: {
          runnerId: "tsx-node-test",
          executable: "tsx",
          args: ["--test", "tests/foo.test.ts"],
          targetTestFiles: ["tests/foo.test.ts"],
        },
      },
      "test-container-456",
      DEFAULT_VERIFICATION_LIMITS,
      pinnedHost
    );

    // Assert -H flag is explicitly prepended before "run"
    assert.strictEqual(args[0], "-H");
    assert.strictEqual(args[1], pinnedHost);
    assert.strictEqual(args[2], "run");
    assert.strictEqual(args[3], "--rm");
    assert.strictEqual(args[4], "--name");
    assert.strictEqual(args[5], "test-container-456");

    // Assert unpinned args (without hostTarget) start with "run"
    const unpinnedArgs = buildVerificationDockerRunArgs(
      {
        stagingPath: "C:\\staged\\workspace",
        imageId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        command: {
          runnerId: "tsx-node-test",
          executable: "tsx",
          args: ["--test", "tests/foo.test.ts"],
          targetTestFiles: ["tests/foo.test.ts"],
        },
      },
      "test-container-789",
      DEFAULT_VERIFICATION_LIMITS
    );
    assert.strictEqual(unpinnedArgs[0], "run");
  });

  await t.test("LocalDockerExecutor should pin explicit host target and fail closed when endpoint is unreachable", async () => {
    const fakePipe = "\\\\.\\pipe\\repo_assistant_nonexistent_pipe_12345";
    const executor = new LocalDockerExecutor(fakePipe);

    // Confirm the endpoint was canonicalized in the executor configuration
    assert.strictEqual(
      executor.getConfiguredHostTarget(),
      "npipe:////./pipe/repo_assistant_nonexistent_pipe_12345"
    );
    assert.strictEqual(executor.getValidatedHostTarget(), undefined);

    // checkAvailability must fail closed without attempting fallback
    const availability = await executor.checkAvailability();
    assert.strictEqual(availability.available, false);
    assert.strictEqual(executor.getValidatedHostTarget(), undefined);
    assert.ok(
      availability.reason?.includes("not accessible"),
      `Expected 'not accessible' in reason, got: ${availability.reason}`
    );

    // executeTestRun must fail closed rather than falling back to active context
    const runResult = await executor.executeTestRun({
      stagingPath: "C:\\fake\\staging",
      imageId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      command: {
        runnerId: "tsx-node-test",
        executable: "/node_modules/.bin/tsx",
        args: ["--test"],
        targetTestFiles: ["tests/sample.test.ts"],
      },
    });

    assert.strictEqual(runResult.exitCode, -1);
    assert.ok(
      runResult.stderr.includes("Security policy violation") ||
        runResult.stderr.includes("unavailable or unvalidated"),
      `Expected endpoint violation message in stderr, got: ${runResult.stderr}`
    );
    assert.ok(
      runResult.warnings.some((w) => w.includes("unavailable or unvalidated")),
      "Expected warning regarding unvalidated local endpoint"
    );
  });
});
