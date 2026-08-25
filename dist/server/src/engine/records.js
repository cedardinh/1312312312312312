"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.persistEngineRecord = persistEngineRecord;
exports.listEngineRecords = listEngineRecords;
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const validation_1 = require("./validation");
const projectRoot = node_path_1.default.resolve(process.cwd());
const recordsDirectory = node_path_1.default.join(projectRoot, "data", "records");
async function persistEngineRecord(jobId, result) {
    await (0, promises_1.mkdir)(recordsDirectory, { recursive: true, mode: 0o700 });
    const finalPath = node_path_1.default.join(recordsDirectory, `${jobId}.json`);
    const temporaryPath = `${finalPath}.tmp`;
    await (0, promises_1.writeFile)(temporaryPath, `${JSON.stringify((0, validation_1.redactRecord)(result), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await (0, promises_1.rename)(temporaryPath, finalPath);
}
async function listEngineRecords() {
    try {
        const files = (await (0, promises_1.readdir)(recordsDirectory)).filter((file) => file.endsWith(".json"));
        const records = await Promise.all(files.map(async (file) => JSON.parse(await (0, promises_1.readFile)(node_path_1.default.join(recordsDirectory, file), "utf8"))));
        return records.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    }
    catch {
        return [];
    }
}
