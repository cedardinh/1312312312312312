"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upgradeBatchSchema = exports.upgradeItemSchema = exports.deploySuiteSchema = exports.networkSchema = void 0;
const zod_1 = require("zod");
const address = zod_1.z.string().regex(/^0x[0-9a-fA-F]{40}$/, "必须是 20 字节以太坊地址").refine((value) => !/^0x0{40}$/i.test(value), "地址不能为零地址");
const rpcUrl = zod_1.z.string().url().superRefine((value, context) => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) {
        context.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: "RPC 仅支持 http/https" });
    }
    if (url.username || url.password) {
        context.addIssue({ code: zod_1.z.ZodIssueCode.custom, message: "RPC URL 不允许内嵌账号或密码" });
    }
});
exports.networkSchema = zod_1.z.object({
    rpcUrl,
    chainId: zod_1.z.number().int().positive().safe(),
    admin: address,
});
exports.deploySuiteSchema = zod_1.z.object({
    network: exports.networkSchema,
    sourceSetId: zod_1.z.string().uuid(),
    dryRun: zod_1.z.boolean().default(false),
});
exports.upgradeItemSchema = zod_1.z.object({
    contractName: zod_1.z.enum(["TopazPayment", "TopazLifecycle", "TopazContacts"]),
    proxyAddress: address,
});
exports.upgradeBatchSchema = zod_1.z.object({
    network: exports.networkSchema,
    sourceSetId: zod_1.z.string().uuid(),
    items: zod_1.z.array(exports.upgradeItemSchema).min(1).max(12),
    dryRun: zod_1.z.boolean().default(false),
});
