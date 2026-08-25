import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { EngineRequest, EngineResult, JobJournal, PublicJob } from "../engine/types.js";
import { buildJobNodes, updateProgress } from "../engine/progress.js";
import { persistEngineRecord } from "../engine/records.js";
import { redactRecord } from "../engine/validation.js";
import { stageSourceSet, validateSourceSetForRequest } from "./source-store.js";

const projectRoot = path.resolve(process.cwd());
const jobsDirectory = path.join(projectRoot, ".runtime", "jobs");
const hardhatCli = path.join(projectRoot, "node_modules", "hardhat", "internal", "cli", "cli.js");
const workerScript = path.join(projectRoot, "dist", "server", "src", "engine", "worker.js");
const timeoutMs = Number(process.env.CONTRACT_CONSOLE_JOB_TIMEOUT_MS ?? "600000");

interface InternalJob extends PublicJob {
  request: EngineRequest;
}

export class SerialJobQueue {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly pending: string[] = [];
  private busy = false;

  enqueue(request: EngineRequest): PublicJob {
    const id = randomUUID();
    const job: InternalJob = {
      id, action: request.action, status: "queued", createdAt: new Date().toISOString(), request,
      stage: "等待执行", progress: 0, nodes: buildJobNodes(request), logs: [],
    };
    this.jobs.set(id, job);
    this.pending.push(id);
    void this.drain();
    return this.publicJob(job);
  }

  async get(id: string): Promise<PublicJob | undefined> {
    const job = this.jobs.get(id);
    if (job?.status === "running") await this.syncJournal(job);
    return job ? this.publicJob(job) : undefined;
  }

  list(): PublicJob[] {
    return [...this.jobs.values()].map((job) => this.publicJob(job)).reverse();
  }

  private publicJob(job: InternalJob): PublicJob {
    const { request: _request, ...visible } = job;
    return redactRecord(structuredClone(visible));
  }

  private async syncJournal(job: InternalJob): Promise<void> {
    try {
      const current = JSON.parse(await readFile(path.join(jobsDirectory, `${job.id}.journal.json`), "utf8")) as JobJournal;
      job.stage = current.stage;
      job.progress = current.progress;
      job.nodes = current.nodes;
      job.logs = current.logs;
    } catch {
      // The atomic journal may be between renames; the next poll will retry.
    }
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.pending.length > 0) {
        const id = this.pending.shift()!;
        const job = this.jobs.get(id)!;
        await this.execute(job);
      }
    } finally {
      this.busy = false;
    }
  }

  private async execute(job: InternalJob): Promise<void> {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    const sourceSetId = job.request.payload.sourceSetId;
    const requestPath = path.join(jobsDirectory, `${job.id}.request.json`);
    const resultPath = path.join(jobsDirectory, `${job.id}.result.json`);
    const journalPath = path.join(jobsDirectory, `${job.id}.journal.json`);
    let journalPersisted = false;

    try {
      await mkdir(jobsDirectory, { recursive: true, mode: 0o700 });
      const initialJournal: JobJournal = {
        action: job.action,
        status: "running",
        startedAt: job.startedAt,
        dryRun: job.request.payload.dryRun,
        transactions: [],
        deployments: [],
        upgrades: [],
        knownContracts: [],
        stage: "校验本次上传源码",
        progress: 0,
        nodes: buildJobNodes(job.request),
        logs: [{ at: new Date().toISOString(), level: "info", message: "开始校验本次上传源码" }],
      };
      await writeFile(journalPath, JSON.stringify(initialJournal), { mode: 0o600, flag: "wx" });
      // Every operation compiles only the immutable source set uploaded for this job.
      await validateSourceSetForRequest(sourceSetId, job.request);
      await stageSourceSet(sourceSetId);
      updateProgress(initialJournal, "compile", "running", "源码上传清单已确认，开始编译本次源码");
      await writeFile(journalPath, JSON.stringify(initialJournal), { mode: 0o600 });
      await writeFile(requestPath, JSON.stringify(job.request), { mode: 0o600, flag: "wx" });
      await this.spawnWorker(requestPath, resultPath, journalPath, job.request.payload.network);
      job.result = JSON.parse(await readFile(resultPath, "utf8")) as EngineResult;
      job.status = "succeeded";
      await this.syncJournal(job);
      await persistEngineRecord(job.id, job.result);
      journalPersisted = true;
    } catch (error) {
      job.status = "failed";
      job.error = { message: error instanceof Error ? error.message : "部署引擎发生未知错误" };
      job.completedAt = new Date().toISOString();
      try {
        const partial = JSON.parse(await readFile(journalPath, "utf8")) as JobJournal;
        if (!partial.nodes.some((node) => node.status === "failed")) {
          const running = partial.nodes.find((node) => node.status === "running") ?? partial.nodes.find((node) => node.status === "pending");
          if (running) updateProgress(partial, running.id, "failed", job.error.message);
        }
        const failureRecord: JobJournal = {
          ...partial,
          action: job.action,
          status: "failed",
          completedAt: job.completedAt,
          error: job.error,
        };
        await persistEngineRecord(job.id, failureRecord);
        job.stage = failureRecord.stage;
        job.progress = failureRecord.progress;
        job.nodes = failureRecord.nodes;
        job.logs = failureRecord.logs;
        journalPersisted = true;
      } catch {
        // Keep the runtime journal when durable persistence itself fails.
      }
    } finally {
      job.completedAt ??= new Date().toISOString();
      await Promise.all([
        rm(requestPath, { force: true }),
        rm(resultPath, { force: true }),
        ...(journalPersisted ? [rm(journalPath, { force: true })] : []),
      ]);
    }
  }

  private spawnWorker(requestPath: string, resultPath: string, journalPath: string, network: EngineRequest["payload"]["network"]): Promise<void> {
    return new Promise((resolve, reject) => {
      const output: string[] = [];
      const child = spawn(process.execPath, [hardhatCli, "run", workerScript, "--network", "target"], {
        cwd: projectRoot,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CONTRACT_CONSOLE_RPC_URL: network.rpcUrl,
          CONTRACT_CONSOLE_CHAIN_ID: String(network.chainId),
          CONTRACT_CONSOLE_ADMIN: network.admin,
          CONTRACT_CONSOLE_JOB_REQUEST: requestPath,
          CONTRACT_CONSOLE_JOB_RESULT: resultPath,
          CONTRACT_CONSOLE_JOB_JOURNAL: journalPath,
        },
      });
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error("任务执行超时，已停止子进程；请先确认 RPC 与交易回执状态"));
      }, timeoutMs);
      const collect = (chunk: Buffer) => {
        output.push(chunk.toString("utf8"));
        if (output.join("").length > 32_000) output.shift();
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(output.join("").trim().slice(-6000) || `部署子进程异常退出（${code ?? "unknown"}）`));
      });
    });
  }
}
