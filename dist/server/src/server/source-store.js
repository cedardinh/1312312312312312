"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSourceSet = createSourceSet;
exports.validateSourceSetForRequest = validateSourceSetForRequest;
exports.stageSourceSet = stageSourceSet;
exports.readStagedSources = readStagedSources;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const validation_js_1 = require("../engine/validation.js");
const projectRoot = node_path_1.default.resolve(process.cwd());
const defaultSourceSetsRoot = node_path_1.default.join(projectRoot, ".runtime", "source-sets");
const sourceIndexRoot = node_path_1.default.join(projectRoot, ".runtime", "source-index");
const activeContractsRoot = node_path_1.default.join(projectRoot, ".runtime", "contracts");
function assertSourceSetId(sourceSetId) {
    if (!/^[0-9a-f-]{36}$/i.test(sourceSetId))
        throw new Error("源码集编号无效");
}
async function resolveStorageRoot(requestedDirectory) {
    const input = requestedDirectory?.trim();
    const selected = input || defaultSourceSetsRoot;
    if (!node_path_1.default.isAbsolute(selected))
        throw new Error("源码存储目录必须是当前系统的绝对路径");
    const resolved = node_path_1.default.resolve(selected);
    if (resolved === node_path_1.default.parse(resolved).root)
        throw new Error("不能把磁盘根目录作为源码存储目录");
    await (0, promises_1.mkdir)(resolved, { recursive: true, mode: 0o700 });
    const canonical = await (0, promises_1.realpath)(resolved);
    const info = await (0, promises_1.stat)(canonical);
    if (!info.isDirectory())
        throw new Error("源码存储位置不是目录");
    return canonical;
}
async function writeSourceIndex(sourceSetId, storageRoot) {
    await (0, promises_1.mkdir)(sourceIndexRoot, { recursive: true, mode: 0o700 });
    await (0, promises_1.writeFile)(node_path_1.default.join(sourceIndexRoot, `${sourceSetId}.json`), JSON.stringify({ storageRoot }, null, 2), { flag: "wx", mode: 0o600 });
}
async function sourceSetDirectory(sourceSetId) {
    assertSourceSetId(sourceSetId);
    try {
        const pointer = JSON.parse(await (0, promises_1.readFile)(node_path_1.default.join(sourceIndexRoot, `${sourceSetId}.json`), "utf8"));
        if (typeof pointer.storageRoot !== "string" || !node_path_1.default.isAbsolute(pointer.storageRoot))
            throw new Error("源码存储索引已损坏");
        const root = await (0, promises_1.realpath)(pointer.storageRoot);
        return node_path_1.default.join(root, sourceSetId);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        return node_path_1.default.join(defaultSourceSetsRoot, sourceSetId);
    }
}
async function createSourceSet(files, requestedDirectory) {
    if (files.length === 0 || files.length > 80)
        throw new Error("每次需上传 1 到 80 个 Solidity 文件");
    const sourceSetId = (0, node_crypto_1.randomUUID)();
    const storageRoot = await resolveStorageRoot(requestedDirectory);
    const directory = node_path_1.default.join(storageRoot, sourceSetId);
    await (0, promises_1.mkdir)(directory, { recursive: false, mode: 0o700 });
    const names = new Set();
    const caseInsensitiveNames = new Set();
    const contracts = [];
    try {
        for (const file of files) {
            if (file.size <= 0 || file.size > 2 * 1024 * 1024)
                throw new Error("单个源码文件不能超过 2 MB");
            const safeName = (0, validation_js_1.sanitizeSolidityRelativePath)(file.originalname);
            if (names.has(safeName))
                throw new Error(`文件名重复：${safeName}`);
            if (caseInsensitiveNames.has(safeName.toLowerCase()))
                throw new Error(`源码路径大小写冲突：${safeName}`);
            names.add(safeName);
            caseInsensitiveNames.add(safeName.toLowerCase());
            contracts.push(...(0, validation_js_1.findSolidityContractDeclarations)(file.buffer.toString("utf8"), safeName));
            await (0, promises_1.mkdir)(node_path_1.default.dirname(node_path_1.default.join(directory, safeName)), { recursive: true, mode: 0o700 });
            await (0, promises_1.writeFile)(node_path_1.default.join(directory, safeName), file.buffer, { flag: "wx", mode: 0o600 });
        }
        // Reject ambiguity immediately, even when the duplicate is not one of the Topaz entry contracts.
        (0, validation_js_1.assertNoDuplicateContractDeclarations)(contracts);
        const manifest = { sourceSetId, files: [...names], contracts };
        await (0, promises_1.writeFile)(node_path_1.default.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
        await writeSourceIndex(sourceSetId, storageRoot);
        return { ...manifest, storageDirectory: storageRoot };
    }
    catch (error) {
        await (0, promises_1.rm)(directory, { recursive: true, force: true });
        throw error;
    }
}
async function readVerifiedSourceSet(sourceSetId) {
    const sourceDirectory = await sourceSetDirectory(sourceSetId);
    const info = await (0, promises_1.stat)(sourceDirectory);
    if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("源码集不存在，请重新上传源码");
    const stored = JSON.parse(await (0, promises_1.readFile)(node_path_1.default.join(sourceDirectory, "manifest.json"), "utf8"));
    if (stored.sourceSetId !== sourceSetId || !Array.isArray(stored.files) || stored.files.length === 0)
        throw new Error("源码清单已损坏，请重新上传源码");
    const declarations = [];
    const files = [];
    for (const name of stored.files) {
        if (typeof name !== "string")
            throw new Error("源码清单已损坏，请重新上传源码");
        const safeName = (0, validation_js_1.sanitizeSolidityRelativePath)(name);
        files.push(safeName);
        const content = await (0, promises_1.readFile)(node_path_1.default.join(sourceDirectory, safeName), "utf8");
        declarations.push(...(0, validation_js_1.findSolidityContractDeclarations)(content, safeName));
    }
    const expected = JSON.stringify(stored.contracts ?? []);
    if (expected !== JSON.stringify(declarations))
        throw new Error("源码文件与上传清单不一致，请重新上传源码");
    return { sourceSetId, files, contracts: declarations };
}
async function validateSourceSetForRequest(sourceSetId, request) {
    const manifest = await readVerifiedSourceSet(sourceSetId);
    (0, validation_js_1.assertRequiredContractsUploaded)(request, manifest.contracts);
    return manifest;
}
async function stageSourceSet(sourceSetId) {
    const sourceDirectory = await sourceSetDirectory(sourceSetId);
    const manifest = await readVerifiedSourceSet(sourceSetId);
    await (0, promises_1.rm)(activeContractsRoot, { recursive: true, force: true });
    await (0, promises_1.mkdir)(activeContractsRoot, { recursive: true, mode: 0o700 });
    for (const name of manifest.files) {
        const safeName = (0, validation_js_1.sanitizeSolidityRelativePath)(name);
        await (0, promises_1.mkdir)(node_path_1.default.dirname(node_path_1.default.join(activeContractsRoot, safeName)), { recursive: true, mode: 0o700 });
        await (0, promises_1.copyFile)(node_path_1.default.join(sourceDirectory, safeName), node_path_1.default.join(activeContractsRoot, safeName));
    }
}
async function readStagedSources() {
    const walk = async (directory) => {
        const entries = await (0, promises_1.readdir)(directory, { withFileTypes: true });
        const results = [];
        for (const entry of entries) {
            const fullPath = node_path_1.default.join(directory, entry.name);
            if (entry.isDirectory())
                results.push(...await walk(fullPath));
            else if (entry.isFile() && entry.name.endsWith(".sol"))
                results.push({ name: node_path_1.default.relative(activeContractsRoot, fullPath), content: await (0, promises_1.readFile)(fullPath, "utf8") });
        }
        return results;
    };
    return walk(activeContractsRoot);
}
