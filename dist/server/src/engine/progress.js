"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildJobNodes = buildJobNodes;
exports.updateProgress = updateProgress;
const base = [
    { id: "compile", label: "编译本次上传源码" },
    { id: "preflight", label: "核对网络与签名权限" },
];
function buildJobNodes(request) {
    const actionNodes = request.action === "deploy-suite"
        ? [
            { id: "payment_impl", label: "部署 Payment 实现" },
            { id: "payment_proxy", label: "部署并初始化 Payment 代理" },
            { id: "lifecycle_impl", label: "部署 Lifecycle 实现" },
            { id: "lifecycle_proxy", label: "部署并初始化 Lifecycle 代理" },
            { id: "contacts_impl", label: "部署 Contacts 实现" },
            { id: "contacts_proxy", label: "部署并初始化 Contacts 代理" },
            { id: "grant_role", label: "授权 Lifecycle 调用 Payment" },
            { id: "verify", label: "复核代理、实现与角色" },
        ]
        : request.action === "import-baseline"
            ? [
                { id: "validate_baseline", label: `核验 ${request.payload.contractName} 线上字节码` },
                { id: "import_baseline", label: `导入 ${request.payload.contractName} 存储布局基线` },
                { id: "verify", label: "复核代理实现地址" },
            ]
            : request.payload.items.flatMap((item, index) => [
                { id: `upgrade_${index}_validate`, label: `校验 ${item.contractName} 存储布局与权限` },
                { id: `upgrade_${index}_upgrade`, label: `升级 ${item.contractName}` },
                { id: `upgrade_${index}_verify`, label: `复核 ${item.contractName} 新实现` },
            ]);
    return [...base, ...actionNodes, { id: "record", label: "保存执行记录" }].map((node) => ({ ...node, status: "pending" }));
}
function safeMessage(message) {
    return message
        .replace(/0x[0-9a-fA-F]{64}/g, "[已隐藏敏感值]")
        .replace(/\b(private.?key|mnemonic|secret)\s*[:=]\s*\S+/gi, "$1=[已隐藏]")
        .replace(/[\r\n]+/g, " ")
        .slice(0, 300);
}
function updateProgress(journal, nodeId, status, message, level = status === "failed" ? "error" : status === "succeeded" ? "success" : "info") {
    const node = journal.nodes.find((item) => item.id === nodeId);
    if (!node)
        throw new Error(`未知执行节点：${nodeId}`);
    node.status = status;
    node.message = safeMessage(message);
    journal.stage = node.label;
    const completed = journal.nodes.filter((item) => item.status === "succeeded").length;
    journal.progress = Math.round((completed / journal.nodes.length) * 100);
    journal.logs.push({ at: new Date().toISOString(), level, message: safeMessage(message) });
    if (journal.logs.length > 100)
        journal.logs.splice(0, journal.logs.length - 100);
}
