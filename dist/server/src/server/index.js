"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const express_1 = __importDefault(require("express"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const helmet_1 = __importDefault(require("helmet"));
const multer_1 = __importDefault(require("multer"));
const pino_http_1 = __importDefault(require("pino-http"));
const ethers_1 = require("ethers");
const zod_1 = require("zod");
const types_js_1 = require("../engine/types.js");
const records_js_1 = require("../engine/records.js");
const validation_js_1 = require("../engine/validation.js");
const job_queue_js_1 = require("./job-queue.js");
const source_store_js_1 = require("./source-store.js");
const projectRoot = node_path_1.default.resolve(process.cwd());
const host = process.env.TOPAZ_CONSOLE_HOST ?? "127.0.0.1";
const port = Number(process.env.TOPAZ_CONSOLE_PORT ?? "4174");
if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host))
    throw new Error("为防止部署接口暴露到局域网，TOPAZ_CONSOLE_HOST 只允许 loopback 地址");
if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("TOPAZ_CONSOLE_PORT 无效");
const app = (0, express_1.default)();
const queue = new job_queue_js_1.SerialJobQueue();
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    preservePath: true,
    limits: { files: 80, fileSize: 2 * 1024 * 1024, fieldSize: 32 * 1024, parts: 90 },
    fileFilter: (_request, file, callback) => callback(null, file.originalname.toLowerCase().endsWith(".sol")),
});
app.disable("x-powered-by");
app.use((0, helmet_1.default)({ crossOriginResourcePolicy: { policy: "same-origin" } }));
app.use((0, pino_http_1.default)({ redact: ["req.headers.authorization", "req.headers.cookie"] }));
app.use((request, response, next) => {
    const origin = request.get("origin");
    if (origin) {
        try {
            const hostname = new URL(origin).hostname;
            if (!new Set(["127.0.0.1", "::1", "localhost"]).has(hostname))
                return response.status(403).json({ error: "只接受本机页面发起的请求" });
        }
        catch {
            return response.status(403).json({ error: "Origin 无效" });
        }
    }
    next();
});
app.use(express_1.default.json({ limit: "256kb", strict: true }));
app.use("/api", (0, express_rate_limit_1.default)({ windowMs: 60_000, limit: 180, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/sources", (0, express_rate_limit_1.default)({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }));
app.use("/api/jobs", (0, express_rate_limit_1.default)({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));
app.get("/api/health", (_request, response) => response.json({ ok: true, service: "topaz-contract-console" }));
app.get("/api/deploy-plan", (_request, response) => response.json({ steps: (0, validation_js_1.buildDeployPlan)() }));
app.post("/api/network/check", async (request, response, next) => {
    try {
        const input = types_js_1.networkSchema.parse(request.body);
        const provider = new ethers_1.JsonRpcProvider(input.rpcUrl, undefined, { staticNetwork: false });
        const network = await provider.getNetwork();
        const actualChainId = Number(network.chainId);
        const accounts = (await provider.send("eth_accounts", [])).map((account) => account.toLowerCase());
        const environmentKey = process.env.TOPAZ_PRIVATE_KEY;
        const environmentSigner = environmentKey ? (0, ethers_1.getAddress)(new ethers_1.Wallet(environmentKey).address) : undefined;
        response.json({
            ok: actualChainId === input.chainId,
            expectedChainId: input.chainId,
            actualChainId,
            latestBlock: await provider.getBlockNumber(),
            signer: environmentSigner
                ? { mode: "environment", address: environmentSigner, matchesAdmin: environmentSigner === (0, ethers_1.getAddress)(input.admin) }
                : { mode: "rpc-unlocked", address: (0, ethers_1.getAddress)(input.admin), matchesAdmin: accounts.includes(input.admin.toLowerCase()) },
        });
        provider.destroy();
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/sources", upload.array("files", 80), async (request, response, next) => {
    try {
        const files = (request.files ?? []);
        const storageDirectory = typeof request.body?.storageDirectory === "string" ? request.body.storageDirectory : "";
        const sourceSet = await (0, source_store_js_1.createSourceSet)(files.map((file) => ({ originalname: file.originalname, buffer: file.buffer, size: file.size })), storageDirectory);
        response.status(201).json(sourceSet);
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/jobs/deploy-suite", (request, response, next) => {
    try {
        const payload = types_js_1.deploySuiteSchema.parse(request.body);
        response.status(202).json(queue.enqueue({ action: "deploy-suite", payload }));
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/jobs/import-baseline", (request, response, next) => {
    try {
        const payload = types_js_1.importBaselineSchema.parse(request.body);
        response.status(202).json(queue.enqueue({ action: "import-baseline", payload }));
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/jobs/upgrade-batch", (request, response, next) => {
    try {
        const payload = types_js_1.upgradeBatchSchema.parse(request.body);
        response.status(202).json(queue.enqueue({ action: "upgrade-batch", payload }));
    }
    catch (error) {
        next(error);
    }
});
app.post("/api/jobs", (request, response, next) => {
    try {
        const action = request.body?.action;
        const rawPayload = request.body?.payload;
        if (action === "deploy-suite")
            return response.status(202).json(queue.enqueue({ action, payload: types_js_1.deploySuiteSchema.parse(rawPayload) }));
        if (action === "import-baseline")
            return response.status(202).json(queue.enqueue({ action, payload: types_js_1.importBaselineSchema.parse(rawPayload) }));
        if (action === "upgrade-batch")
            return response.status(202).json(queue.enqueue({ action, payload: types_js_1.upgradeBatchSchema.parse(rawPayload) }));
        return response.status(400).json({ error: "不支持的任务类型" });
    }
    catch (error) {
        next(error);
    }
});
app.get("/api/jobs", (_request, response) => response.json({ jobs: queue.list() }));
app.get("/api/jobs/:id", async (request, response) => {
    const job = await queue.get(request.params.id);
    if (!job)
        return response.status(404).json({ error: "任务不存在" });
    response.json(job);
});
app.get("/api/records", async (_request, response, next) => {
    try {
        response.json({ records: await (0, records_js_1.listEngineRecords)() });
    }
    catch (error) {
        next(error);
    }
});
const clientDirectory = node_path_1.default.join(projectRoot, "dist", "client");
if ((0, node_fs_1.existsSync)(clientDirectory)) {
    app.use(express_1.default.static(clientDirectory, { index: false, dotfiles: "deny", fallthrough: true, maxAge: "1h" }));
    app.use((request, response, next) => {
        if (request.method === "GET" && !request.path.startsWith("/api/")) {
            return response.sendFile(node_path_1.default.join(clientDirectory, "index.html"));
        }
        next();
    });
}
app.use((_request, response) => response.status(404).json({ error: "接口不存在" }));
app.use((error, request, response, _next) => {
    request.log.error({ err: error }, "request failed");
    if (error instanceof zod_1.ZodError)
        return response.status(400).json({ error: "配置校验失败", details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
    if (error instanceof multer_1.default.MulterError)
        return response.status(400).json({ error: `上传失败：${error.message}` });
    response.status(500).json({ error: error instanceof Error ? error.message : "服务器内部错误" });
});
app.listen(port, host, () => {
    console.log(`Topaz Contract Console: http://${host}:${port}`);
});
