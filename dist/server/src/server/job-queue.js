"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SerialJobQueue = void 0;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_child_process_1 = require("node:child_process");
const node_path_1 = __importDefault(require("node:path"));
const progress_js_1 = require("../engine/progress.js");
const records_js_1 = require("../engine/records.js");
const validation_js_1 = require("../engine/validation.js");
const source_store_js_1 = require("./source-store.js");
const projectRoot = node_path_1.default.resolve(process.cwd());
const jobsDirectory = node_path_1.default.join(projectRoot, ".runtime", "jobs");
const hardhatCli = node_path_1.default.join(projectRoot, "node_modules", "hardhat", "internal", "cli", "cli.js");
const workerScript = node_path_1.default.join(projectRoot, "dist", "server", "src", "engine", "worker.js");
const timeoutMs = Number(process.env.CONTRACT_CONSOLE_JOB_TIMEOUT_MS ?? "600000");
class SerialJobQueue {
    jobs = new Map();
    pending = [];
    busy = false;
    enqueue(request) {
        const id = (0, node_crypto_1.randomUUID)();
        const job = {
            id, action: request.action, status: "queued", createdAt: new Date().toISOString(), request,
            stage: "等待执行", progress: 0, nodes: (0, progress_js_1.buildJobNodes)(request), logs: [],
        };
        this.jobs.set(id, job);
        this.pending.push(id);
        void this.drain();
        return this.publicJob(job);
    }
    async get(id) {
        const job = this.jobs.get(id);
        if (job?.status === "running")
            await this.syncJournal(job);
        return job ? this.publicJob(job) : undefined;
    }
    list() {
        return [...this.jobs.values()].map((job) => this.publicJob(job)).reverse();
    }
    publicJob(job) {
        const { request: _request, ...visible } = job;
        return (0, validation_js_1.redactRecord)(structuredClone(visible));
    }
    async syncJournal(job) {
        try {
            const current = JSON.parse(await (0, promises_1.readFile)(node_path_1.default.join(jobsDirectory, `${job.id}.journal.json`), "utf8"));
            job.stage = current.stage;
            job.progress = current.progress;
            job.nodes = current.nodes;
            job.logs = current.logs;
        }
        catch {
            // The atomic journal may be between renames; the next poll will retry.
        }
    }
    async drain() {
        if (this.busy)
            return;
        this.busy = true;
        try {
            while (this.pending.length > 0) {
                const id = this.pending.shift();
                const job = this.jobs.get(id);
                await this.execute(job);
            }
        }
        finally {
            this.busy = false;
        }
    }
    async execute(job) {
        job.status = "running";
        job.startedAt = new Date().toISOString();
        const sourceSetId = job.request.payload.sourceSetId;
        const requestPath = node_path_1.default.join(jobsDirectory, `${job.id}.request.json`);
        const resultPath = node_path_1.default.join(jobsDirectory, `${job.id}.result.json`);
        const journalPath = node_path_1.default.join(jobsDirectory, `${job.id}.journal.json`);
        let journalPersisted = false;
        try {
            await (0, promises_1.mkdir)(jobsDirectory, { recursive: true, mode: 0o700 });
            const initialJournal = {
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
                nodes: (0, progress_js_1.buildJobNodes)(job.request),
                logs: [{ at: new Date().toISOString(), level: "info", message: "开始校验本次上传源码" }],
            };
            await (0, promises_1.writeFile)(journalPath, JSON.stringify(initialJournal), { mode: 0o600, flag: "wx" });
            // Every operation compiles only the immutable source set uploaded for this job.
            await (0, source_store_js_1.validateSourceSetForRequest)(sourceSetId, job.request);
            await (0, source_store_js_1.stageSourceSet)(sourceSetId);
            (0, progress_js_1.updateProgress)(initialJournal, "compile", "running", "源码上传清单已确认，开始编译本次源码");
            await (0, promises_1.writeFile)(journalPath, JSON.stringify(initialJournal), { mode: 0o600 });
            await (0, promises_1.writeFile)(requestPath, JSON.stringify(job.request), { mode: 0o600, flag: "wx" });
            await this.spawnWorker(requestPath, resultPath, journalPath, job.request.payload.network);
            job.result = JSON.parse(await (0, promises_1.readFile)(resultPath, "utf8"));
            job.status = "succeeded";
            await this.syncJournal(job);
            await (0, records_js_1.persistEngineRecord)(job.id, job.result);
            journalPersisted = true;
        }
        catch (error) {
            job.status = "failed";
            job.error = { message: error instanceof Error ? error.message : "部署引擎发生未知错误" };
            job.completedAt = new Date().toISOString();
            try {
                const partial = JSON.parse(await (0, promises_1.readFile)(journalPath, "utf8"));
                if (!partial.nodes.some((node) => node.status === "failed")) {
                    const running = partial.nodes.find((node) => node.status === "running") ?? partial.nodes.find((node) => node.status === "pending");
                    if (running)
                        (0, progress_js_1.updateProgress)(partial, running.id, "failed", job.error.message);
                }
                const failureRecord = {
                    ...partial,
                    action: job.action,
                    status: "failed",
                    completedAt: job.completedAt,
                    error: job.error,
                };
                await (0, records_js_1.persistEngineRecord)(job.id, failureRecord);
                job.stage = failureRecord.stage;
                job.progress = failureRecord.progress;
                job.nodes = failureRecord.nodes;
                job.logs = failureRecord.logs;
                journalPersisted = true;
            }
            catch {
                // Keep the runtime journal when durable persistence itself fails.
            }
        }
        finally {
            job.completedAt ??= new Date().toISOString();
            await Promise.all([
                (0, promises_1.rm)(requestPath, { force: true }),
                (0, promises_1.rm)(resultPath, { force: true }),
                ...(journalPersisted ? [(0, promises_1.rm)(journalPath, { force: true })] : []),
            ]);
        }
    }
    spawnWorker(requestPath, resultPath, journalPath, network) {
        return new Promise((resolve, reject) => {
            const output = [];
            const child = (0, node_child_process_1.spawn)(process.execPath, [hardhatCli, "run", workerScript, "--network", "target"], {
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
            const collect = (chunk) => {
                output.push(chunk.toString("utf8"));
                if (output.join("").length > 32_000)
                    output.shift();
            };
            child.stdout.on("data", collect);
            child.stderr.on("data", collect);
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("exit", (code) => {
                clearTimeout(timer);
                if (code === 0)
                    resolve();
                else
                    reject(new Error(output.join("").trim().slice(-6000) || `部署子进程异常退出（${code ?? "unknown"}）`));
            });
        });
    }
}
exports.SerialJobQueue = SerialJobQueue;
