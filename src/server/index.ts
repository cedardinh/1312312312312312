import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import multer from "multer";
import pinoHttp from "pino-http";
import { JsonRpcProvider, Wallet, getAddress } from "ethers";
import { ZodError } from "zod";
import { deploySuiteSchema, networkSchema, upgradeBatchSchema } from "../engine/types.js";
import { listEngineRecords } from "../engine/records.js";
import { buildDeployPlan } from "../engine/validation.js";
import { SerialJobQueue } from "./job-queue.js";
import { createSourceSet } from "./source-store.js";

const projectRoot = path.resolve(process.cwd());
const host = process.env.CONTRACT_CONSOLE_HOST ?? "127.0.0.1";
const port = Number(process.env.CONTRACT_CONSOLE_PORT ?? "4174");
if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) throw new Error("为防止部署接口暴露到局域网，CONTRACT_CONSOLE_HOST 只允许 loopback 地址");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("CONTRACT_CONSOLE_PORT 无效");

const app = express();
const queue = new SerialJobQueue();
const upload = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: { files: 80, fileSize: 2 * 1024 * 1024, fieldSize: 32 * 1024, parts: 90 },
  fileFilter: (_request, file, callback) => callback(null, file.originalname.toLowerCase().endsWith(".sol")),
});

app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use(pinoHttp({ redact: ["req.headers.authorization", "req.headers.cookie"] }));
app.use((request, response, next) => {
  const origin = request.get("origin");
  if (origin) {
    try {
      const hostname = new URL(origin).hostname;
      if (!new Set(["127.0.0.1", "::1", "localhost"]).has(hostname)) return response.status(403).json({ error: "只接受本机页面发起的请求" });
    } catch {
      return response.status(403).json({ error: "Origin 无效" });
    }
  }
  next();
});
app.use(express.json({ limit: "256kb", strict: true }));
app.get("/api/health", (_request, response) => response.json({ ok: true, service: "contract-console" }));
app.get("/api/deploy-plan", (_request, response) => response.json({ steps: buildDeployPlan() }));

app.post("/api/network/check", async (request, response, next) => {
  try {
    const input = networkSchema.parse(request.body);
    const provider = new JsonRpcProvider(input.rpcUrl, undefined, { staticNetwork: false });
    const network = await provider.getNetwork();
    const actualChainId = Number(network.chainId);
    const accounts = (await provider.send("eth_accounts", []) as string[]).map((account) => account.toLowerCase());
    const environmentKey = process.env.CONTRACT_CONSOLE_PRIVATE_KEY;
    const environmentSigner = environmentKey ? getAddress(new Wallet(environmentKey).address) : undefined;
    response.json({
      ok: actualChainId === input.chainId,
      expectedChainId: input.chainId,
      actualChainId,
      latestBlock: await provider.getBlockNumber(),
      signer: environmentSigner
        ? { mode: "environment", address: environmentSigner, matchesAdmin: environmentSigner === getAddress(input.admin) }
        : { mode: "rpc-unlocked", address: getAddress(input.admin), matchesAdmin: accounts.includes(input.admin.toLowerCase()) },
    });
    provider.destroy();
  } catch (error) {
    next(error);
  }
});

app.post("/api/sources", upload.array("files", 80), async (request, response, next) => {
  try {
    const files = (request.files ?? []) as Express.Multer.File[];
    const storageDirectory = typeof request.body?.storageDirectory === "string" ? request.body.storageDirectory : "";
    const sourceSet = await createSourceSet(files.map((file) => ({ originalname: file.originalname, buffer: file.buffer, size: file.size })), storageDirectory);
    response.status(201).json(sourceSet);
  } catch (error) {
    next(error);
  }
});

app.post("/api/jobs/deploy-suite", (request, response, next) => {
  try {
    const payload = deploySuiteSchema.parse(request.body);
    response.status(202).json(queue.enqueue({ action: "deploy-suite", payload }));
  } catch (error) { next(error); }
});

app.post("/api/jobs/upgrade-batch", (request, response, next) => {
  try {
    const payload = upgradeBatchSchema.parse(request.body);
    response.status(202).json(queue.enqueue({ action: "upgrade-batch", payload }));
  } catch (error) { next(error); }
});

app.post("/api/jobs", (request, response, next) => {
  try {
    const action = request.body?.action;
    const rawPayload = request.body?.payload;
    if (action === "deploy-suite") return response.status(202).json(queue.enqueue({ action, payload: deploySuiteSchema.parse(rawPayload) }));
    if (action === "upgrade-batch") return response.status(202).json(queue.enqueue({ action, payload: upgradeBatchSchema.parse(rawPayload) }));
    return response.status(400).json({ error: "不支持的任务类型" });
  } catch (error) { next(error); }
});

app.get("/api/jobs", (_request, response) => response.json({ jobs: queue.list() }));
app.get("/api/jobs/:id", async (request, response) => {
  const job = await queue.get(request.params.id);
  if (!job) return response.status(404).json({ error: "任务不存在" });
  response.json(job);
});
app.get("/api/records", async (_request, response, next) => {
  try { response.json({ records: await listEngineRecords() }); } catch (error) { next(error); }
});

const clientDirectory = path.join(projectRoot, "dist", "client");
if (existsSync(clientDirectory)) {
  app.use(express.static(clientDirectory, { index: false, dotfiles: "deny", fallthrough: true, maxAge: "1h" }));
  app.use((request, response, next) => {
    if (request.method === "GET" && !request.path.startsWith("/api/")) {
      return response.sendFile(path.join(clientDirectory, "index.html"));
    }
    next();
  });
}

app.use((_request, response) => response.status(404).json({ error: "接口不存在" }));

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  request.log.error({ err: error }, "request failed");
  if (error instanceof ZodError) return response.status(400).json({ error: "配置校验失败", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
  if (error instanceof multer.MulterError) return response.status(400).json({ error: `上传失败：${error.message}` });
  response.status(500).json({ error: error instanceof Error ? error.message : "服务器内部错误" });
});

app.listen(port, host, () => {
  console.log(`Contract Console: http://${host}:${port}`);
});
