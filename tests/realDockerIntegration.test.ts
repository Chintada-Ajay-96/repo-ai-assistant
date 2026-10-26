import test from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  LocalDockerExecutor,
  probeLocalNamedPipe,
  spawnDockerCli,
  DOCKER_NAMED_PIPE_WINDOWS,
} from "../src/verification/dockerSandbox.js";
import { parseTapStream, evaluateTapResult } from "../src/verification/tapParser.js";

test("realDockerIntegration - Empirical Docker Desktop Environment Probe & Integration Suite", async (t) => {
  const isPipeAccessible = await probeLocalNamedPipe();

  if (!isPipeAccessible) {
    console.log(
      `\n[ENVIRONMENT CHECK: PENDING / NOT RUN]\nDocker Desktop named pipes are not accessible on this host.\nReal container execution integration tests are skipped until Docker Desktop is installed and running.\n`
    );
    await t.test("fail closed when Docker named pipe is inaccessible", async () => {
      const executor = new LocalDockerExecutor();
      const availability = await executor.checkAvailability();
      assert.strictEqual(availability.available, false);
      assert.ok(availability.reason?.includes("accessible") || availability.reason?.includes("endpoint"));
    });
    return;
  }

  console.log(
    `\n[ENVIRONMENT CHECK: RUNNING]\nDocker Desktop named pipe "${DOCKER_NAMED_PIPE_WINDOWS}" is accessible on this host.\n`
  );

  const executor = new LocalDockerExecutor();

  await t.test("checkAvailability should report available: true and verify Linux container engine", async () => {
    const availability = await executor.checkAvailability();
    assert.strictEqual(availability.available, true);
  });

  // Check if the local image is present
  const inspectRes = await spawnDockerCli(["image", "inspect", "--format={{.Id}}", "repo-assistant-verifier:local"]);
  if (inspectRes.exitCode !== 0) {
    console.log(
      "\n[IMAGE INTEGRATION CHECK: PENDING] Image 'repo-assistant-verifier:local' is not yet built in local Docker daemon.\n"
    );
    return;
  }

  const localId = inspectRes.stdout.trim();
  console.log(`[REAL DOCKER IMAGE DETECTED]: ${localId}`);

  await t.test("inspectImageId should verify exact match with canonical local ID", async () => {
    const check = await executor.inspectImageId(localId);
    assert.strictEqual(check.matches, true);
    assert.strictEqual(check.actualId, localId);
  });

  await t.test("command resolution: verify execution via PATH ('tsx') and absolute path ('/node_modules/.bin/tsx')", async () => {
    // 1. Verify via PATH ("tsx")
    const runViaPath = await spawnDockerCli([
      "run", "--rm", "--network", "none", "--pull", "never",
      localId, "tsx", "/opt/smokeTest.ts",
    ], 10000);
    assert.strictEqual(runViaPath.exitCode, 0, `Failed to execute tsx via container PATH: ${runViaPath.stderr}`);
    assert.ok(runViaPath.stdout.includes("# pass 3"), "Expected 3 passes via tsx");

    // 2. Verify via absolute path ("/node_modules/.bin/tsx")
    const runViaAbsolute = await spawnDockerCli([
      "run", "--rm", "--network", "none", "--pull", "never",
      localId, "/node_modules/.bin/tsx", "/opt/smokeTest.ts",
    ], 10000);
    assert.strictEqual(runViaAbsolute.exitCode, 0, `Failed to execute tsx via absolute path: ${runViaAbsolute.stderr}`);
    assert.ok(runViaAbsolute.stdout.includes("# pass 3"), "Expected 3 passes via /node_modules/.bin/tsx");
  });

  await t.test("runCanaryWriteProbe should verify UID 1000 can write to staged workspace", async () => {
    const tempStaging = path.join(os.tmpdir(), `canary-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tempStaging, { recursive: true });

    try {
      const probe = await executor.runCanaryWriteProbe(tempStaging, localId);
      assert.strictEqual(probe.success, true, `Canary probe failed: ${probe.reason}`);
    } finally {
      try {
        fs.rmSync(tempStaging, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  await t.test("executeTestRun should execute real containerized test and parse TAP v13 output", async () => {
    const tempStaging = path.join(os.tmpdir(), `real-run-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(tempStaging, "tests"), { recursive: true });

    // Write a real passing test file
    fs.writeFileSync(
      path.join(tempStaging, "tests", "math.test.ts"),
      `import test from "node:test";
import * as assert from "node:assert";

test("real container math test", async (t) => {
  await t.test("adds numbers correctly", () => {
    assert.strictEqual(2 + 2, 4);
  });
});
`
    );

    try {
      const runResult = await executor.executeTestRun({
        stagingPath: tempStaging,
        imageId: localId,
        command: {
          runnerId: "tsx-node-test",
          executable: "/node_modules/.bin/tsx",
          args: ["--test", "--test-reporter=tap", "tests/math.test.ts"],
          targetTestFiles: ["tests/math.test.ts"],
        },
      });

      assert.strictEqual(runResult.exitCode, 0, `Container run exited non-zero: ${runResult.stderr}`);
      assert.strictEqual(runResult.timedOut, false);
      assert.strictEqual(runResult.outputLimitExceeded, false);
      assert.strictEqual(runResult.containerStoppedConfirmed, true);

      // Parse and evaluate the actual real TAP output
      const parsedTap = parseTapStream(runResult.stdout);
      assert.strictEqual(parsedTap.isWellFormed, true);
      assert.ok(parsedTap.discretePassed >= 1, `Expected at least 1 passed assertion, received ${parsedTap.discretePassed}`);

      const evaluation = evaluateTapResult(parsedTap, runResult.exitCode, ["tests/math.test.ts"]);
      assert.strictEqual(evaluation.isPassed, true);
      assert.strictEqual(evaluation.summary.failed, 0);
    } finally {
      try {
        fs.rmSync(tempStaging, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  await t.test("security isolation: verify root filesystem is read-only (EROFS)", async () => {
    const res = await spawnDockerCli([
      "run", "--rm", "--network", "none", "--pull", "never",
      "--read-only",
      localId, "node", "-e", "require('node:fs').writeFileSync('/test_readonly.txt', 'fail');",
    ]);
    assert.notStrictEqual(res.exitCode, 0, "Writing to root filesystem should fail");
    assert.ok(
      res.stderr.includes("EROFS") || res.stderr.includes("read-only file system"),
      `Expected EROFS in stderr, received: ${res.stderr}`
    );
  });

  await t.test("security isolation: verify network is disabled (--network none / ENETUNREACH)", async () => {
    const res = await spawnDockerCli([
      "run", "--rm", "--network", "none", "--pull", "never",
      localId, "node", "-e", `
        const http = require('node:http');
        const req = http.get('http://1.1.1.1', () => { process.exit(1); });
        req.on('error', (err) => {
          if (err.code === 'ENETUNREACH' || err.code === 'EHOSTUNREACH' || err.message.includes('unreachable')) {
            process.exit(0);
          }
          process.exit(2);
        });
      `,
    ]);
    assert.strictEqual(res.exitCode, 0, `Expected network unreachable inside container, got stderr: ${res.stderr}`);
  });

  await t.test("security isolation: verify non-root user execution (UID:GID 1000:1000)", async () => {
    const res = await spawnDockerCli([
      "run", "--rm", "--network", "none", "--pull", "never",
      "--user", "1000:1000",
      localId, "node", "-e", "console.log(process.getuid() + ':' + process.getgid());",
    ]);
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.stdout.trim(), "1000:1000");
  });

  await t.test("security isolation: verify Linux capabilities dropped (CapEff 0) and NoNewPrivs", async () => {
    const res = await spawnDockerCli([
      "run", "--rm", "--network", "none", "--pull", "never",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true",
      localId, "node", "-e", `
        const fs = require('node:fs');
        const status = fs.readFileSync('/proc/self/status', 'utf8');
        const capEff = status.match(/^CapEff:\\s*([0-9a-fA-F]+)/m)?.[1];
        const noNewPrivs = status.match(/^NoNewPrivs:\\s*([0-9]+)/m)?.[1];
        console.log(capEff + ',' + noNewPrivs);
      `,
    ]);
    assert.strictEqual(res.exitCode, 0);
    const [capEff, noNewPrivs] = res.stdout.trim().split(",");
    assert.strictEqual(capEff, "0000000000000000", `Expected all capabilities dropped, got ${capEff}`);
    assert.strictEqual(noNewPrivs, "1", `Expected NoNewPrivs: 1, got ${noNewPrivs}`);
  });

  await t.test("security policy: reject unauthorized runner executable (/workspace/tsx)", async () => {
    const tempStaging = path.join(os.tmpdir(), `unauth-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tempStaging, { recursive: true });
    try {
      const res = await executor.executeTestRun({
        stagingPath: tempStaging,
        imageId: localId,
        command: {
          runnerId: "tsx-node-test",
          executable: "/workspace/tsx",
          args: ["--test"],
          targetTestFiles: ["tests/sample.test.ts"],
        },
      });
      assert.strictEqual(res.exitCode, -1);
      assert.ok(res.stderr.includes("Security policy violation"));
      assert.ok(res.warnings.some((w) => w.includes("unauthorized or workspace-local runner executable")));
    } finally {
      try {
        fs.rmSync(tempStaging, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  await t.test("security policy: reject stale or non-existent canonical image ID", async () => {
    const fakeId = "sha256:" + "0".repeat(64);
    const check = await executor.inspectImageId(fakeId);
    assert.strictEqual(check.matches, false);

    const tempStaging = path.join(os.tmpdir(), `fakeid-test-${crypto.randomUUID()}`);
    fs.mkdirSync(tempStaging, { recursive: true });
    try {
      const run = await executor.executeTestRun({
        stagingPath: tempStaging,
        imageId: fakeId,
        command: {
          runnerId: "tsx-node-test",
          executable: "/node_modules/.bin/tsx",
          args: ["--test"],
          targetTestFiles: ["tests/sample.test.ts"],
        },
      });
      assert.notStrictEqual(run.exitCode, 0);
      assert.ok(
        run.stderr.includes("No such image") ||
          run.stderr.includes("not found") ||
          run.exitCode === -1
      );
    } finally {
      try {
        fs.rmSync(tempStaging, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  await t.test("process supervision: terminate container when wall-clock timeout is exceeded", async () => {
    const tempStaging = path.join(os.tmpdir(), `timeout-test-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(tempStaging, "tests"), { recursive: true });

    fs.writeFileSync(
      path.join(tempStaging, "tests", "hang.test.ts"),
      `import test from "node:test";
test("hanging test", async () => {
  await new Promise((resolve) => setTimeout(resolve, 15000));
});
`
    );

    try {
      const runResult = await executor.executeTestRun({
        stagingPath: tempStaging,
        imageId: localId,
        command: {
          runnerId: "tsx-node-test",
          executable: "/node_modules/.bin/tsx",
          args: ["--test", "tests/hang.test.ts"],
          targetTestFiles: ["tests/hang.test.ts"],
        },
        limits: {
          timeoutMs: 2000,
          maxOutputBytes: 524288,
          memoryLimit: "512m",
          pidsLimit: 128,
        },
      });

      assert.strictEqual(runResult.timedOut, true, "Expected runResult.timedOut to be true");
      assert.strictEqual(runResult.containerStoppedConfirmed, true, "Expected containerStoppedConfirmed: true");
      assert.strictEqual(runResult.exitCode, null);
    } finally {
      try {
        fs.rmSync(tempStaging, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  await t.test("process supervision: terminate container when output limit is exceeded", async () => {
    const tempStaging = path.join(os.tmpdir(), `output-test-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(tempStaging, "tests"), { recursive: true });

    fs.writeFileSync(
      path.join(tempStaging, "tests", "flood.test.ts"),
      `import test from "node:test";
test("flooding test", () => {
  for (let i = 0; i < 50000; i++) {
    console.log("flood line of data " + i);
  }
});
`
    );

    try {
      const runResult = await executor.executeTestRun({
        stagingPath: tempStaging,
        imageId: localId,
        command: {
          runnerId: "tsx-node-test",
          executable: "/node_modules/.bin/tsx",
          args: ["--test", "tests/flood.test.ts"],
          targetTestFiles: ["tests/flood.test.ts"],
        },
        limits: {
          timeoutMs: 15000,
          maxOutputBytes: 10000,
          memoryLimit: "512m",
          pidsLimit: 128,
        },
      });

      assert.strictEqual(runResult.outputLimitExceeded, true, "Expected outputLimitExceeded: true");
      assert.strictEqual(runResult.outputTruncated, true);
      assert.strictEqual(runResult.containerStoppedConfirmed, true);
    } finally {
      try {
        fs.rmSync(tempStaging, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
