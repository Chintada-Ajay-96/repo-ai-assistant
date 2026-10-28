import * as net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import {
  type ApprovedTestCommand,
  type VerificationLimits,
  DEFAULT_VERIFICATION_LIMITS,
} from "./types.js";

export interface ContainerRunOptions {
  stagingPath: string;
  imageId: string;
  command: ApprovedTestCommand;
  limits?: Partial<VerificationLimits> | undefined;
}

export interface ContainerRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  containerStoppedConfirmed: boolean;
  warnings: string[];
}

export interface IDockerExecutor {
  checkAvailability(): Promise<{ available: boolean; reason?: string }>;
  inspectImageId(expectedImageId: string): Promise<{ matches: boolean; actualId?: string; reason?: string }>;
  runCanaryWriteProbe(stagingPath: string, imageId: string): Promise<{ success: boolean; reason?: string }>;
  executeTestRun(options: ContainerRunOptions): Promise<ContainerRunResult>;
}

export const DOCKER_DESKTOP_LINUX_PIPE = "\\\\.\\pipe\\dockerDesktopLinuxEngine";
export const DOCKER_CLASSIC_ENGINE_PIPE = "\\\\.\\pipe\\docker_engine";
export const DOCKER_NAMED_PIPE_WINDOWS = DOCKER_DESKTOP_LINUX_PIPE;
export const DOCKER_HOST_CLI_ARG = "npipe:////./pipe/dockerDesktopLinuxEngine";
export const DOCKER_UNIX_SOCKET = "/var/run/docker.sock";

export const KNOWN_DOCKER_WINDOWS_PIPES = [
  DOCKER_DESKTOP_LINUX_PIPE,
  DOCKER_CLASSIC_ENGINE_PIPE,
  "\\\\.\\pipe\\docker_engine_linux",
];

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Constructs a minimal, strictly sanitized environment for spawning docker.exe on Windows.
 * Leaked credentials, API keys, and custom DOCKER_* overrides are completely omitted.
 */
export function buildMinimalDockerEnv(): NodeJS.ProcessEnv {
  const system32 = "C:\\Windows\\System32";
  const windows = "C:\\Windows";
  const programFilesDocker = "C:\\Program Files\\Docker\\Docker\\resources\\bin";
  const localAppData =
    process.env.LOCALAPPDATA ??
    (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
  const userDocker = localAppData
    ? path.join(localAppData, "Programs", "DockerDesktop", "resources", "bin")
    : "";

  const hostPath = process.env.PATH ?? "";
  const hostDockerDirs = hostPath
    .split(";")
    .filter((d) => d && d.toLowerCase().includes("docker"));

  const candidateDockerDirs = [userDocker, programFilesDocker].filter(Boolean);
  const allDockerBins = Array.from(new Set([...hostDockerDirs, ...candidateDockerDirs]));
  const cleanPath = [...allDockerBins, system32, windows].join(";");

  return {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: cleanPath,
    TEMP: process.env.TEMP ?? "C:\\Windows\\Temp",
    TMP: process.env.TMP ?? "C:\\Windows\\Temp",
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
  };
}

/**
 * Canonicalizes a local Windows named pipe path or Unix domain socket into a Docker CLI -H endpoint URL.
 * Bypasses the active Docker context by providing an explicit endpoint target.
 */
export function pipePathToDockerHost(pipeOrSocketPath: string): string {
  if (
    pipeOrSocketPath.startsWith("npipe://") ||
    pipeOrSocketPath.startsWith("unix://") ||
    pipeOrSocketPath.startsWith("tcp://")
  ) {
    return pipeOrSocketPath;
  }

  // Windows named pipe: \\.\pipe\<name> or //./pipe/<name>
  const normalized = pipeOrSocketPath.replace(/\\/g, "/");
  if (normalized.startsWith("//./pipe/")) {
    const pipeName = normalized.slice("//./pipe/".length);
    return `npipe:////./pipe/${pipeName}`;
  }

  // Unix domain socket
  if (normalized.startsWith("/")) {
    return `unix://${normalized}`;
  }

  return `npipe:////./pipe/${normalized.replace(/^\/+/, "")}`;
}

/**
 * Probes a single Windows named pipe endpoint via native IPC with a strict timeout.
 */
function probeSingleNamedPipe(pipePath: string, timeoutMs: number = 1000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    let socket: net.Socket | undefined;

    timer = setTimeout(() => {
      if (socket) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      finish(false);
    }, timeoutMs);

    try {
      socket = net.connect(pipePath);

      socket.on("connect", () => {
        try {
          socket?.destroy();
        } catch {
          // ignore
        }
        finish(true);
      });

      socket.on("error", () => {
        finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

export interface LocalDockerEndpointResolution {
  reachable: boolean;
  pipePath?: string;
  hostTarget?: string;
}

/**
 * Resolves the active local Docker daemon endpoint by probing local named pipes (Windows)
 * or Unix sockets (Linux/macOS) in priority order.
 */
export async function resolveLocalDockerEndpoint(
  candidatePipes?: string[]
): Promise<LocalDockerEndpointResolution> {
  const candidates =
    candidatePipes ??
    (process.platform === "win32"
      ? KNOWN_DOCKER_WINDOWS_PIPES
      : [DOCKER_UNIX_SOCKET]);

  for (const candidate of candidates) {
    const reachable = await probeSingleNamedPipe(candidate);
    if (reachable) {
      return {
        reachable: true,
        pipePath: candidate,
        hostTarget: pipePathToDockerHost(candidate),
      };
    }
  }

  return { reachable: false };
}

/**
 * Probes local Windows Docker named pipes using non-blocking native IPC.
 * Checks candidate Docker Desktop named pipes (e.g. dockerDesktopLinuxEngine, docker_engine).
 */
export async function probeLocalNamedPipe(pipePath?: string): Promise<boolean> {
  const result = await resolveLocalDockerEndpoint(pipePath ? [pipePath] : undefined);
  return result.reachable;
}

/**
 * Spawns a docker command using the sanitized environment and an execution timeout.
 * When hostTarget is provided, Docker CLI binds explicitly to that endpoint (-H hostTarget),
 * completely bypassing active Docker contexts.
 */
export function spawnDockerCli(
  args: string[],
  timeoutMs: number = 5000,
  hostTarget?: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdoutData = "";
    let stderrData = "";
    let timedOut = false;
    let proc: ChildProcess | undefined;

    const fullArgs = hostTarget ? ["-H", hostTarget, ...args] : args;

    try {
      proc = spawn("docker", fullArgs, {
        shell: false,
        windowsVerbatimArguments: false,
        env: buildMinimalDockerEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      resolve({
        exitCode: -1,
        stdout: "",
        stderr: `Failed to spawn docker CLI: ${err?.message ?? String(err)}`,
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (proc && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }
    }, timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString("utf8");
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString("utf8");
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdoutData,
        stderr: stderrData,
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: stdoutData,
        stderr: stderrData + `\n${err.message}`,
        timedOut: false,
      });
    });
  });
}

/**
 * Resolves the verification runner executable to an absolute container-root binary path.
 * Canonicalizes "tsx" or "/node_modules/.bin/tsx" to "/node_modules/.bin/tsx".
 * Rejects any relative, arbitrary, or workspace-local executables (e.g. "/workspace/tsx", "bash", "./tsx").
 */
export function resolveContainerRunnerExecutable(executable: string): string {
  if (executable === "tsx" || executable === "/node_modules/.bin/tsx") {
    return "/node_modules/.bin/tsx";
  }
  throw new Error(
    `Security policy violation: Runner executable must be "/node_modules/.bin/tsx" (or "tsx"), received: "${executable}". Relative, arbitrary, or workspace-local executables are strictly forbidden.`
  );
}

/**
 * Builds the hardened, isolated Docker container arguments for verification test execution.
 * When hostTarget is provided, explicitly binds the Docker CLI to that endpoint (-H hostTarget).
 */
export function buildVerificationDockerRunArgs(
  options: ContainerRunOptions,
  containerName: string,
  limits: VerificationLimits,
  hostTarget?: string
): string[] {
  const resolvedExecutable = resolveContainerRunnerExecutable(options.command.executable);

  const runArgs = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--pull",
    "never",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    "1000:1000",
    "--env",
    "PATH=/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--memory",
    limits.memoryLimit,
    "--memory-swap",
    limits.memoryLimit,
    "--cpus",
    limits.cpuLimit,
    "--pids-limit",
    String(limits.pidsLimit),
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "-v",
    `${options.stagingPath}:/workspace:rw`,
    "-w",
    "/workspace",
    options.imageId,
    resolvedExecutable,
    ...options.command.args,
  ];

  return hostTarget ? ["-H", hostTarget, ...runArgs] : runArgs;
}

/**
 * Concrete Docker executor interacting with the validated local Docker Desktop engine on Windows.
 * Enforces pinned local endpoint binding across all operations to avoid reliance on active Docker contexts.
 */
export class LocalDockerExecutor implements IDockerExecutor {
  private validatedHostTarget?: string;
  private readonly configuredHostTarget?: string;

  constructor(explicitHostTarget?: string) {
    if (explicitHostTarget) {
      this.configuredHostTarget = pipePathToDockerHost(explicitHostTarget);
    }
  }

  /**
   * Returns the explicitly configured Docker host endpoint, if provided.
   */
  getConfiguredHostTarget(): string | undefined {
    return this.configuredHostTarget;
  }

  /**
   * Returns the explicitly validated Docker host endpoint currently pinned for this executor.
   */
  getValidatedHostTarget(): string | undefined {
    return this.validatedHostTarget;
  }

  /**
   * Ensures that a local Docker endpoint has been probed and validated.
   * If checkAvailability() was not previously called, resolves and validates the endpoint now.
   * Fails closed if no local endpoint can be reached or validated.
   */
  private async ensureHostTarget(): Promise<string> {
    if (this.validatedHostTarget) {
      return this.validatedHostTarget;
    }

    const availability = await this.checkAvailability();
    if (!availability.available || !this.validatedHostTarget) {
      throw new Error(
        `Local Docker endpoint is unavailable or unvalidated. Execution refused. Reason: ${availability.reason || "endpoint unreachable"}`
      );
    }

    return this.validatedHostTarget;
  }

  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    let targetHost: string | undefined = this.configuredHostTarget;

    if (targetHost) {
      // If explicit host was configured, verify its underlying pipe/socket is reachable
      if (targetHost.startsWith("npipe:////./pipe/")) {
        const pipeName = targetHost.replace("npipe:////./pipe/", "");
        const winPipe = `\\\\.\\pipe\\${pipeName}`;
        const reachable = await probeSingleNamedPipe(winPipe);
        if (!reachable) {
          return {
            available: false,
            reason: `Configured Docker named pipe "${winPipe}" is not accessible. Verification requires a running local Docker Desktop engine.`,
          };
        }
      } else if (targetHost.startsWith("unix://")) {
        const socketPath = targetHost.replace("unix://", "");
        const reachable = await probeSingleNamedPipe(socketPath);
        if (!reachable) {
          return {
            available: false,
            reason: `Configured Docker Unix socket "${socketPath}" is not accessible.`,
          };
        }
      }
    } else {
      // 1. Native named pipe probe across known local endpoints
      const resolution = await resolveLocalDockerEndpoint();
      if (!resolution.reachable || !resolution.hostTarget) {
        return {
          available: false,
          reason: `Docker endpoint validation failed: Neither ${DOCKER_DESKTOP_LINUX_PIPE} nor ${DOCKER_CLASSIC_ENGINE_PIPE} is accessible. Verification requires a running local Docker Desktop engine.`,
        };
      }
      targetHost = resolution.hostTarget;
    }

    // 2. CLI probe using the explicitly pinned local host endpoint (-H)
    const infoResult = await spawnDockerCli(["info", "--format={{.OSType}}"], 4000, targetHost);
    if (infoResult.exitCode !== 0) {
      return {
        available: false,
        reason: `Docker daemon did not respond on validated local endpoint (${targetHost}). Exit code: ${infoResult.exitCode}. Details: ${infoResult.stderr.trim() || infoResult.stdout.trim()}`,
      };
    }

    const osType = infoResult.stdout.trim().toLowerCase();
    if (osType !== "linux") {
      return {
        available: false,
        reason: `Docker engine OS type is "${osType}", but Linux container execution is required for isolated verification. Please ensure Docker Desktop is running in Linux container mode.`,
      };
    }

    this.validatedHostTarget = targetHost;
    return { available: true };
  }

  async inspectImageId(expectedImageId: string): Promise<{ matches: boolean; actualId?: string; reason?: string }> {
    if (!expectedImageId || !/^sha256:[a-f0-9]{64}$/i.test(expectedImageId)) {
      return {
        matches: false,
        reason: `Invalid image ID: "${expectedImageId}". Expected canonical 64-character SHA-256 local Image ID (sha256:<64_hex_digits>). Mutable tags are strictly rejected.`,
      };
    }

    let host: string;
    try {
      host = await this.ensureHostTarget();
    } catch (err: any) {
      return {
        matches: false,
        reason: err?.message ?? String(err),
      };
    }

    const inspectResult = await spawnDockerCli(["image", "inspect", "--format={{.Id}}", expectedImageId], 4000, host);
    if (inspectResult.exitCode !== 0) {
      return {
        matches: false,
        reason: `Local verification image (${expectedImageId}) not found in Docker daemon store. Auto-pull is disabled for security.`,
      };
    }

    const actualId = inspectResult.stdout.trim();
    if (actualId.toLowerCase() !== expectedImageId.toLowerCase()) {
      return {
        matches: false,
        actualId,
        reason: `Image ID mismatch: expected "${expectedImageId}", but local Docker daemon reported "${actualId}".`,
      };
    }

    return { matches: true, actualId };
  }

  async runCanaryWriteProbe(stagingPath: string, imageId: string): Promise<{ success: boolean; reason?: string }> {
    if (!imageId || !/^sha256:[a-f0-9]{64}$/i.test(imageId)) {
      return {
        success: false,
        reason: `Security policy violation: Canary write probe requires canonical 64-character SHA-256 local Image ID, received: "${imageId}".`,
      };
    }

    let host: string;
    try {
      host = await this.ensureHostTarget();
    } catch (err: any) {
      return {
        success: false,
        reason: err?.message ?? String(err),
      };
    }

    const canaryArgs = [
      "run",
      "--rm",
      "--network",
      "none",
      "--pull",
      "never",
      "--user",
      "1000:1000",
      "-v",
      `${stagingPath}:/workspace:rw`,
      "-w",
      "/workspace",
      imageId,
      "/bin/sh",
      "-c",
      "touch /workspace/.canary_test && rm /workspace/.canary_test",
    ];

    const result = await spawnDockerCli(canaryArgs, 8000, host);
    if (result.exitCode !== 0) {
      return {
        success: false,
        reason: `Docker Desktop mount permission check failed. UID 1000 cannot write to staged workspace. Error: ${result.stderr.trim() || result.stdout.trim()}`,
      };
    }

    return { success: true };
  }

  async executeTestRun(options: ContainerRunOptions): Promise<ContainerRunResult> {
    const limits: VerificationLimits = {
      ...DEFAULT_VERIFICATION_LIMITS,
      ...(options.limits || {}),
    };

    const containerName = `repo-verify-${crypto.randomUUID()}`;
    const startTime = Date.now();

    if (!options.imageId || !/^sha256:[a-f0-9]{64}$/i.test(options.imageId)) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `Security policy violation: Image must be referenced exclusively by its canonical 64-character SHA-256 local Image ID (sha256:<64_hex_digits>), received: "${options.imageId}". Execution with mutable tags is strictly forbidden.`,
        outputTruncated: false,
        durationMs: 0,
        timedOut: false,
        outputLimitExceeded: false,
        containerStoppedConfirmed: true,
        warnings: ["Refused container execution with mutable or non-canonical image identifier."],
      };
    }

    try {
      resolveContainerRunnerExecutable(options.command.executable);
    } catch (err: any) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: err?.message ?? String(err),
        outputTruncated: false,
        durationMs: 0,
        timedOut: false,
        outputLimitExceeded: false,
        containerStoppedConfirmed: true,
        warnings: ["Refused container execution with unauthorized or workspace-local runner executable."],
      };
    }

    let host: string;
    try {
      host = await this.ensureHostTarget();
    } catch (err: any) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `Security policy violation: ${err?.message ?? String(err)}`,
        outputTruncated: false,
        durationMs: 0,
        timedOut: false,
        outputLimitExceeded: false,
        containerStoppedConfirmed: true,
        warnings: ["Refused container execution: local Docker endpoint is unavailable or unvalidated."],
      };
    }

    let dockerRunArgs: string[];
    try {
      dockerRunArgs = buildVerificationDockerRunArgs(options, containerName, limits, host);
    } catch (err: any) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: err?.message ?? String(err),
        outputTruncated: false,
        durationMs: 0,
        timedOut: false,
        outputLimitExceeded: false,
        containerStoppedConfirmed: true,
        warnings: ["Refused container execution with unauthorized or workspace-local runner executable."],
      };
    }

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let totalOutputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let containerStoppedConfirmed = true;
    const warnings: string[] = [];

    // Atomic CAS termination state: "running" | "terminating" | "terminated"
    let terminationState: "running" | "terminating" | "terminated" = "running";
    let proc: ChildProcess | undefined;

    const fullCliArgs = dockerRunArgs;

    try {
      proc = spawn("docker", fullCliArgs, {
        shell: false,
        windowsVerbatimArguments: false,
        env: buildMinimalDockerEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      return {
        exitCode: -1,
        stdout: "",
        stderr: `Failed to spawn docker execution process: ${err?.message ?? String(err)}`,
        outputTruncated: false,
        durationMs: Date.now() - startTime,
        timedOut: false,
        outputLimitExceeded: false,
        containerStoppedConfirmed: false,
        warnings: [`Process spawn error: ${err.message}`],
      };
    }

    // Helper to terminate container with hard bounded timeout
    const terminateContainer = async (reason: "timeout" | "output_limit") => {
      if (terminationState !== "running") {
        return;
      }
      terminationState = "terminating";

      if (reason === "timeout") {
        timedOut = true;
      } else {
        outputLimitExceeded = true;
      }

      // 1. Issue docker kill with hard 5000ms timeout on validated local host
      const killResult = await spawnDockerCli(["kill", containerName], 5000, host);

      // Check if container was already stopped or successfully killed
      const alreadyStopped =
        killResult.exitCode === 0 ||
        killResult.stderr.toLowerCase().includes("is not running") ||
        killResult.stderr.toLowerCase().includes("no such container");

      if (!alreadyStopped) {
        // Attempt forced remove with 5000ms timeout on validated local host
        const rmResult = await spawnDockerCli(["rm", "-f", containerName], 5000, host);
        const rmSuccess =
          rmResult.exitCode === 0 ||
          rmResult.stderr.toLowerCase().includes("no such container");

        if (!rmSuccess) {
          containerStoppedConfirmed = false;
          warnings.push(
            "Warning: Container termination or removal could not be confirmed with the Docker daemon. A residual container may still be running in the background."
          );
        }
      }

      // 2. Kill the host child process
      if (proc && !proc.killed) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore kill errors
        }
      }

      terminationState = "terminated";
    };

    // Wall-clock execution timer
    const timeoutTimer = setTimeout(() => {
      terminateContainer("timeout").catch(() => {});
    }, limits.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      totalOutputBytes += chunk.length;
      if (totalOutputBytes > limits.maxOutputBytes && terminationState === "running") {
        const allowedBytes = Math.max(0, limits.maxOutputBytes - (stdoutBuffer.length + stderrBuffer.length));
        if (allowedBytes > 0) {
          stdoutBuffer += chunk.subarray(0, allowedBytes).toString("utf8");
        }
        stdoutBuffer += `\n[VERIFIER WARNING: Output limit of ${limits.maxOutputBytes} bytes exceeded. Process terminated.]\n`;
        terminateContainer("output_limit").catch(() => {});
        return;
      }

      if (totalOutputBytes <= limits.maxOutputBytes) {
        stdoutBuffer += chunk.toString("utf8");
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      totalOutputBytes += chunk.length;
      if (totalOutputBytes > limits.maxOutputBytes && terminationState === "running") {
        const allowedBytes = Math.max(0, limits.maxOutputBytes - (stdoutBuffer.length + stderrBuffer.length));
        if (allowedBytes > 0) {
          stderrBuffer += chunk.subarray(0, allowedBytes).toString("utf8");
        }
        stderrBuffer += `\n[VERIFIER WARNING: Output limit of ${limits.maxOutputBytes} bytes exceeded. Process terminated.]\n`;
        terminateContainer("output_limit").catch(() => {});
        return;
      }

      if (totalOutputBytes <= limits.maxOutputBytes) {
        stderrBuffer += chunk.toString("utf8");
      }
    });

    const exitResult = await new Promise<{ exitCode: number | null }>((resolve) => {
      proc?.on("close", (code) => {
        clearTimeout(timeoutTimer);
        resolve({ exitCode: code });
      });

      proc?.on("error", (err) => {
        clearTimeout(timeoutTimer);
        stderrBuffer += `\nChild process execution error: ${err.message}`;
        resolve({ exitCode: -1 });
      });
    });

    clearTimeout(timeoutTimer);

    return {
      exitCode: exitResult.exitCode,
      stdout: stdoutBuffer,
      stderr: stderrBuffer,
      outputTruncated: outputLimitExceeded || totalOutputBytes > limits.maxOutputBytes,
      durationMs: Date.now() - startTime,
      timedOut,
      outputLimitExceeded,
      containerStoppedConfirmed,
      warnings,
    };
  }
}
