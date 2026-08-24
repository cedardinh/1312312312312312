"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findSolidityContractDeclarations = findSolidityContractDeclarations;
exports.requiredUploadedContracts = requiredUploadedContracts;
exports.assertNoDuplicateContractDeclarations = assertNoDuplicateContractDeclarations;
exports.assertRequiredContractsUploaded = assertRequiredContractsUploaded;
exports.validateAddress = validateAddress;
exports.validateNetworkConfig = validateNetworkConfig;
exports.sanitizeSolidityRelativePath = sanitizeSolidityRelativePath;
exports.buildDeployPlan = buildDeployPlan;
exports.runSequentialFailFast = runSequentialFailFast;
exports.redactRecord = redactRecord;
exports.assertConstructorOnlyDisablesInitializers = assertConstructorOnlyDisablesInitializers;
const ethers_1 = require("ethers");
const types_1 = require("./types");
const RESERVED_FILENAMES = new Set([".", "..", "node_modules", "artifacts", "cache"]);
function sourceWithoutCommentsOrStrings(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, (value) => " ".repeat(value.length))
        .replace(/\/\/[^\r\n]*/g, (value) => " ".repeat(value.length))
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (value) => " ".repeat(value.length));
}
/** Finds deployable Solidity contract declarations, excluding interfaces and libraries. */
function findSolidityContractDeclarations(source, file) {
    const declarations = [];
    const code = sourceWithoutCommentsOrStrings(source);
    for (const match of code.matchAll(/\bcontract\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
        declarations.push({ name: match[1], file });
    }
    return declarations;
}
function requiredUploadedContracts(request) {
    if (request.action === "deploy-suite")
        return ["TopazPayment", "TopazLifecycle", "TopazContacts"];
    if (request.action === "import-baseline")
        return [request.payload.contractName];
    return [...new Set(request.payload.items.map((item) => item.contractName))];
}
function assertNoDuplicateContractDeclarations(declarations) {
    const byName = new Map();
    for (const declaration of declarations) {
        const matches = byName.get(declaration.name) ?? [];
        matches.push(declaration);
        byName.set(declaration.name, matches);
    }
    const duplicates = [...byName.entries()].filter(([, matches]) => matches.length > 1);
    if (duplicates.length > 0) {
        const details = duplicates.map(([name, matches]) => `${name}（${matches.map((item) => item.file).join("、")}）`).join("；");
        throw new Error(`本次上传源码存在重复合约声明：${details}。请只保留每个合约的一份源码`);
    }
}
function assertRequiredContractsUploaded(request, declarations) {
    assertNoDuplicateContractDeclarations(declarations);
    const names = new Set(declarations.map((item) => item.name));
    const missing = requiredUploadedContracts(request).filter((name) => !names.has(name));
    if (missing.length > 0) {
        const actionLabel = request.action === "deploy-suite" ? "部署整套" : request.action === "upgrade-batch" ? "升级" : "导入基线";
        throw new Error(`${actionLabel}前必须在本次上传源码中包含合约声明：${missing.join("、")}。请同时上传目标合约及其全部本地依赖`);
    }
}
function validateAddress(value) {
    try {
        return (0, ethers_1.getAddress)(value);
    }
    catch {
        throw new Error("无效的以太坊地址");
    }
}
function validateNetworkConfig(input) {
    const parsed = types_1.networkSchema.parse(input);
    return { ...parsed, admin: validateAddress(parsed.admin) };
}
function sanitizeSolidityRelativePath(input) {
    if (input.startsWith("/") || input.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(input)) {
        throw new Error("源码路径必须是相对路径");
    }
    const normalized = input.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (!normalized.endsWith(".sol") ||
        parts.length === 0 ||
        parts.some((part) => !part || RESERVED_FILENAMES.has(part) || part.startsWith(".") || !/^[A-Za-z0-9_.-]+$/.test(part))) {
        throw new Error("只允许安全的 .sol 相对路径");
    }
    return parts.join("/");
}
function buildDeployPlan() {
    return [
        { order: 1, id: "payment", label: "部署 TopazPayment 实现与代理", dependsOn: [] },
        { order: 2, id: "lifecycle", label: "部署 TopazLifecycle 实现与代理", dependsOn: ["payment"] },
        { order: 3, id: "contacts", label: "部署 TopazContacts 实现与代理", dependsOn: [] },
        { order: 4, id: "grant-role", label: "授予 Lifecycle 调用 Payment 的角色", dependsOn: ["payment", "lifecycle"] },
        { order: 5, id: "verify", label: "复核代理实现地址并保存记录", dependsOn: ["payment", "lifecycle", "contacts", "grant-role"] },
    ];
}
async function runSequentialFailFast(items, operation) {
    const results = [];
    for (let index = 0; index < items.length; index += 1) {
        results.push(await operation(items[index], index));
    }
    return results;
}
function redactRecord(value) {
    const visit = (item) => {
        if (Array.isArray(item))
            return item.map(visit);
        if (item && typeof item === "object") {
            return Object.fromEntries(Object.entries(item).filter(([key]) => !/private.?key|mnemonic|secret/i.test(key)).map(([key, child]) => [key, visit(child)]));
        }
        return item;
    };
    return visit(value);
}
function assertConstructorOnlyDisablesInitializers(source, contractName) {
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const contractIndex = withoutComments.search(new RegExp(`\\bcontract\\s+${contractName}\\b`));
    if (contractIndex < 0)
        throw new Error(`源码中未找到 ${contractName}`);
    const contractSource = withoutComments.slice(contractIndex);
    const constructor = contractSource.match(/constructor\s*\([^)]*\)\s*\{([^}]*)\}/s);
    if (!constructor || !/^\s*_disableInitializers\s*\(\s*\)\s*;\s*$/.test(constructor[1])) {
        throw new Error(`${contractName} 构造函数必须且只能调用 _disableInitializers()`);
    }
}
