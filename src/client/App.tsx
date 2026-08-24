import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, InputHTMLAttributes, ReactNode, UIEvent } from "react";
import { checkNetwork, createJob, getJob, listEngineRecords, uploadSources } from "./client-api";
import type { EngineRecord, Job, Mode, NetworkCheck, NetworkForm, SourceFile, UpgradeItem } from "./types";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const POLL_INTERVAL = 900;

const DEFAULT_NETWORK: NetworkForm = {
  rpcUrl: "",
  chainId: "",
  adminAddress: "",
  storageDirectory: "",
};

const CONTRACT_LABELS: Record<string, string> = {
  TopazPayment: "Payment",
  TopazLifecycle: "Lifecycle",
  TopazContacts: "Contacts",
};

const DEPLOY_CONTRACTS = [
  { key: "payment", contractName: "TopazPayment", fileName: "TopazPayment.sol" },
  { key: "lifecycle", contractName: "TopazLifecycle", fileName: "TopazLifecycle.sol" },
  { key: "contacts", contractName: "TopazContacts", fileName: "TopazContacts.sol" },
] as const;

type IconName =
  | "check"
  | "chevron"
  | "database"
  | "deploy"
  | "file"
  | "history"
  | "network"
  | "plus"
  | "refresh"
  | "remove"
  | "shield"
  | "upload"
  | "wallet";

function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  const paths: Record<IconName, ReactNode> = {
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    database: <><ellipse cx="12" cy="5" rx="7.5" ry="3" /><path d="M4.5 5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V5M4.5 11v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" /></>,
    deploy: <><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" /><path d="M5 14v5h14v-5" /></>,
    file: <><path d="M6 2.8h7l5 5V21H6z" /><path d="M13 3v5h5" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
    network: <><circle cx="12" cy="12" r="3" /><circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="m7 6.5 3 3M14 10l3.3-3.4M14 14l3.3 3.3" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7h-5V2" /><path d="M20 7a8 8 0 1 0 1 8" /></>,
    remove: <><path d="M6 6l12 12M18 6 6 18" /></>,
    shield: <><path d="M12 2.5 20 6v5.5c0 4.6-3.2 8.5-8 10-4.8-1.5-8-5.4-8-10V6z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>,
    upload: <><path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" /><path d="M5 15v5h14v-5" /></>,
    wallet: <><path d="M4 6h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2V6a3 3 0 0 1 3-3h12" /><path d="M15 11h5v4h-5a2 2 0 0 1 0-4" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function compactAddress(value: string) {
  return ADDRESS_RE.test(value) ? `${value.slice(0, 10)}…${value.slice(-6)}` : "未填写";
}

function jobError(job?: Job) {
  if (!job?.error) return "";
  return typeof job.error === "string" ? job.error : job.error.message;
}

function contractNameFromFile(name: string) {
  const candidate = name.replace(/\.sol$/i, "").replace(/[^a-zA-Z0-9_$]/g, "");
  return ["TopazPayment", "TopazLifecycle", "TopazContacts"].includes(candidate) ? candidate : "";
}

async function readSources(fileList: FileList | null): Promise<SourceFile[]> {
  if (!fileList) return [];
  const files = Array.from(fileList).filter((file) => file.name.toLowerCase().endsWith(".sol"));
  return Promise.all(
    files.map(async (file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      path: file.webkitRelativePath || file.name,
      content: await file.text(),
      size: file.size,
    })),
  );
}

function fileBaseName(path: string) {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

function deploymentSourceMatches(sources: SourceFile[]) {
  return Object.fromEntries(DEPLOY_CONTRACTS.map((contract) => [
    contract.key,
    sources.filter((source) => fileBaseName(source.path).toLowerCase() === contract.fileName.toLowerCase()),
  ])) as Record<(typeof DEPLOY_CONTRACTS)[number]["key"], SourceFile[]>;
}

function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`field ${error ? "field-error" : ""} ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-message error-message">{error}</span> : hint ? <span className="field-message">{hint}</span> : null}
    </label>
  );
}

function SectionTitle({ step, icon, title, aside }: { step: string; icon: IconName; title: string; aside?: ReactNode }) {
  return (
    <div className="panel-heading">
      <div className="panel-title-wrap">
        <span className="step-number">{step}</span>
        <span className="heading-icon"><Icon name={icon} size={18} /></span>
        <h2>{title}</h2>
      </div>
      {aside && <div className="panel-aside">{aside}</div>}
    </div>
  );
}

function SourceSetPicker({
  label,
  sources,
  onSelect,
}: {
  label: string;
  sources: SourceFile[];
  onSelect: (sources: SourceFile[]) => void;
}) {
  const filesRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const change = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = await readSources(event.target.files);
    if (selected.length) onSelect(selected.sort((left, right) => left.path.localeCompare(right.path)));
    event.target.value = "";
  };
  return (
    <div className="source-picker">
      <input ref={filesRef} className="visually-hidden" type="file" multiple accept=".sol" onChange={change} />
      <input ref={directoryRef} className="visually-hidden" type="file" multiple accept=".sol" onChange={change} {...({ webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>)} />
      <button className="source-select" type="button" onClick={() => filesRef.current?.click()}>
        <span className="file-badge"><Icon name="file" size={17} /></span>
        <span>
          <strong>{sources.length ? `${sources.length} 个源码文件` : label}</strong>
          <small>{sources.length ? "已包含目标合约及本地依赖 · 点击替换" : "选择完整 Solidity 源码集"}</small>
        </span>
        <span className="source-action">选文件</span>
      </button>
      <button className="source-directory-action" type="button" onClick={() => directoryRef.current?.click()}>选择目录</button>
    </div>
  );
}

function NetworkPanel({ network, setNetwork, state, onCheck }: {
  network: NetworkForm;
  setNetwork: (network: NetworkForm) => void;
  state: { checking: boolean; result?: NetworkCheck; error?: string };
  onCheck: () => void;
}) {
  const set = (key: keyof NetworkForm, value: string) => setNetwork({ ...network, [key]: value });
  const checkPassed = state.result?.ok === true && state.result.signer?.matchesAdmin === true;
  const checkMessage = state.result
    ? !state.result.ok
      ? `Chain ID 不一致：节点返回 ${state.result.actualChainId ?? "未知"}`
      : !state.result.signer?.matchesAdmin
        ? "网络可用，但 Admin 不是已配置或已解锁的签名账户"
        : `连接与签名账户检查通过 · 最新区块 ${state.result.latestBlock ?? "—"}`
    : "";
  return (
    <section className="panel">
      <SectionTitle
        step="1"
        icon="network"
        title="连接网络"
        aside={
          <button type="button" className="text-button" onClick={onCheck} disabled={state.checking}>
            {state.checking ? "连接中…" : "测试连接"}
          </button>
        }
      />
      <div className="panel-body network-grid">
        <Field label="RPC URL" error={!/^https?:\/\//.test(network.rpcUrl) ? "请输入 http:// 或 https:// 地址" : undefined}>
          <div className="input-with-icon"><Icon name="network" size={18} /><input value={network.rpcUrl} onChange={(event) => set("rpcUrl", event.target.value.trim())} spellCheck={false} /></div>
        </Field>
        <Field label="Chain ID" error={!/^\d+$/.test(network.chainId) ? "必须是数字" : undefined}>
          <input value={network.chainId} inputMode="numeric" onChange={(event) => set("chainId", event.target.value.trim())} />
        </Field>
        <Field className="full-field" label="签名 / Admin 钱包" hint="必须是节点已解锁账户，或由本地服务配置对应私钥。">
          <div className="input-with-icon"><Icon name="wallet" size={18} /><input value={network.adminAddress} onChange={(event) => set("adminAddress", event.target.value.trim())} spellCheck={false} /></div>
        </Field>
        <Field className="full-field" label="上传源码存储目录（可选）" hint="留空则保存在工具目录；可填写 Windows 绝对路径，例如 D:\\TopazSources。">
          <div className="input-with-icon"><Icon name="database" size={18} /><input value={network.storageDirectory} placeholder="D:\\TopazSources" onChange={(event) => set("storageDirectory", event.target.value.trim())} spellCheck={false} /></div>
        </Field>
        {(state.result || state.error) && (
          <div className={`connection-result full-field ${checkPassed ? "is-success" : "is-error"}`} role="status">
            <Icon name={checkPassed ? "check" : "remove"} size={17} />
            <span>{state.error || state.result?.message || checkMessage || "连接失败"}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function UpgradePanel({ items, setItems }: { items: UpgradeItem[]; setItems: (items: UpgradeItem[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const addFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const sources = await readSources(event.target.files);
    const additions = sources.map((source) => ({ ...source, contractName: contractNameFromFile(source.name), proxyAddress: "" }));
    setItems([...items, ...additions]);
    event.target.value = "";
  };
  const update = (id: string, patch: Partial<UpgradeItem>) => setItems(items.map((item) => item.id === id ? { ...item, ...patch } : item));
  return (
    <section className="panel upgrade-panel">
      <SectionTitle
        step="2"
        icon="refresh"
        title="上传本次完整源码集"
        aside={<span className="quiet-label">目标逐个升级 · 依赖只参与编译</span>}
      />
      <div className="panel-body">
        <input ref={fileRef} className="visually-hidden" type="file" multiple accept=".sol" onChange={addFiles} />
        <input ref={directoryRef} className="visually-hidden" type="file" multiple accept=".sol" onChange={addFiles} {...({ webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>)} />
        <button className="upload-area" type="button" onClick={() => fileRef.current?.click()}>
          <span className="upload-icon"><Icon name="upload" size={22} /></span>
          <span><strong>上传目标合约和全部本地依赖</strong><small>主合约设置代理地址；Types、接口等依赖文件无需代理地址</small></span>
          <span className="upload-button"><Icon name="plus" size={16} /> 选择文件</span>
        </button>
        <button className="upgrade-directory-button" type="button" onClick={() => directoryRef.current?.click()}><Icon name="database" size={16} />选择完整源码目录</button>

        {items.length === 0 ? (
          <div className="empty-list">
            <Icon name="file" size={22} />
            <span>还没有要升级的合约</span>
          </div>
        ) : (
          <div className="upgrade-list">
            <div className="list-caption"><span>源码清单</span><span>{items.length} 个文件 · {items.filter((item) => item.contractName).length} 个升级目标</span></div>
            {items.map((item, index) => (
              <article className="upgrade-item" key={item.id}>
                <div className="contract-identity">
                  <span className="contract-order">{String(index + 1).padStart(2, "0")}</span>
                  <span className="file-badge"><Icon name="file" size={18} /></span>
                  <span className="contract-file"><strong>{item.contractName || item.name}</strong><small>{item.path} · {(item.size / 1024).toFixed(1)} KB</small></span>
                </div>
                <div className="item-fields">
                  <Field label="合约名称">
                    <select value={item.contractName} onChange={(event) => update(item.id, { contractName: event.target.value })}>
                      <option value="">编译依赖（不升级）</option>
                      <option value="TopazLifecycle">TopazLifecycle</option>
                      <option value="TopazPayment">TopazPayment</option>
                      <option value="TopazContacts">TopazContacts</option>
                    </select>
                  </Field>
                  {item.contractName ? <Field label="当前代理地址" error={item.proxyAddress && !ADDRESS_RE.test(item.proxyAddress) ? "地址格式不正确" : undefined}>
                    <input placeholder="0x…" value={item.proxyAddress} onChange={(event) => update(item.id, { proxyAddress: event.target.value.trim() })} spellCheck={false} />
                  </Field> : <div className="dependency-note"><Icon name="check" size={16} /><span>作为编译依赖上传，不发送升级交易</span></div>}
                </div>
                <button className="remove-button" type="button" onClick={() => setItems(items.filter((candidate) => candidate.id !== item.id))} aria-label={`移除 ${item.name}`} title="移除">
                  <Icon name="remove" size={18} />
                </button>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BaselineImport({
  sources,
  contractName,
  proxyAddress,
  busy,
  onSources,
  onContractName,
  onProxyAddress,
  onImport,
}: {
  sources: SourceFile[];
  contractName: string;
  proxyAddress: string;
  busy: boolean;
  onSources: (sources: SourceFile[]) => void;
  onContractName: (name: string) => void;
  onProxyAddress: (address: string) => void;
  onImport: () => void;
}) {
  const valid = sources.length > 0 && ADDRESS_RE.test(proxyAddress);
  return (
    <details className="baseline-box">
      <summary><span><Icon name="database" size={17} /><strong>首次接管已有代理</strong></span><small>只需做一次</small></summary>
      <div className="baseline-body">
        <p>上传当前线上版本的完整源码集（目标合约及本地依赖）。系统核对链上字节码，完全匹配后才保存升级基线。</p>
        <div className="baseline-grid">
          <SourceSetPicker label="上传当前版本完整源码集" sources={sources} onSelect={onSources} />
          <Field label="合约名称">
            <select value={contractName} onChange={(event) => onContractName(event.target.value)}>
              <option value="TopazLifecycle">TopazLifecycle</option>
              <option value="TopazPayment">TopazPayment</option>
              <option value="TopazContacts">TopazContacts</option>
            </select>
          </Field>
          <Field className="baseline-address" label="当前代理地址" error={proxyAddress && !ADDRESS_RE.test(proxyAddress) ? "地址格式不正确" : undefined}>
            <input value={proxyAddress} placeholder="0x…" onChange={(event) => onProxyAddress(event.target.value.trim())} spellCheck={false} />
          </Field>
        </div>
        <div className="baseline-footer"><span><Icon name="shield" size={16} />只导入基线，不升级、不改变链上状态</span><button type="button" disabled={!valid || busy} onClick={onImport}>{busy ? "正在核对…" : "核对并导入基线"}</button></div>
      </div>
    </details>
  );
}

const DEPLOY_STEPS = [
  { key: "payment", no: "01", name: "Payment", title: "部署 Payment", detail: "部署实现合约，再创建并初始化 UUPS Proxy", result: "得到 Payment Proxy" },
  { key: "lifecycle", no: "02", name: "Lifecycle", title: "部署 Lifecycle", detail: "初始化时自动传入上一步的 Payment Proxy", result: "依赖 Payment Proxy" },
  { key: "contacts", no: "03", name: "Contacts", title: "部署 Contacts", detail: "部署实现合约，再创建并初始化 UUPS Proxy", result: "得到 Contacts Proxy" },
  { key: "authorize", no: "04", name: "Authorize", title: "建立合约关系", detail: "Payment 授予 Lifecycle Proxy：LIFECYCLE_ROLE", result: "完成后验证并保存" },
] as const;

function DeployPanel({ sources, setSources }: { sources: SourceFile[]; setSources: (sources: SourceFile[]) => void }) {
  const filesRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const matches = deploymentSourceMatches(sources);

  const replaceSources = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = await readSources(event.target.files);
    if (selected.length > 0) setSources(selected.sort((left, right) => left.path.localeCompare(right.path)));
    event.target.value = "";
  };

  const removeSource = (id: string) => setSources(sources.filter((source) => source.id !== id));

  return (
    <section className="panel deploy-panel">
      <SectionTitle step="2" icon="deploy" title="部署整套合约" aside={<span className="quiet-label">顺序已锁定，不可跳步</span>} />
      <div className="panel-body">
        <input ref={filesRef} className="visually-hidden" type="file" multiple accept=".sol" onChange={replaceSources} />
        <input
          ref={directoryRef}
          className="visually-hidden"
          type="file"
          multiple
          accept=".sol"
          onChange={replaceSources}
          {...({ webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>)}
        />
        <div className={`suite-upload ${sources.length ? "has-files" : ""}`}>
          <div className="suite-upload-copy">
            <span className="upload-icon"><Icon name="upload" size={23} /></span>
            <span><strong>上传整套合约源码</strong><small>请把三个主合约及其本地依赖一次上传；执行时会提交下面的完整清单。</small></span>
          </div>
          <div className="suite-upload-actions">
            <button type="button" className="suite-primary-upload" onClick={() => filesRef.current?.click()}><Icon name="file" size={16} />{sources.length ? "重新选择文件" : "选择多个 .sol"}</button>
            <button type="button" className="suite-directory-upload" onClick={() => directoryRef.current?.click()}><Icon name="database" size={16} />选择源码目录</button>
          </div>
        </div>

        <div className="suite-detection" aria-label="主合约识别状态">
          {DEPLOY_CONTRACTS.map((contract) => {
            const found = matches[contract.key];
            const ready = found.length === 1;
            return (
              <div className={ready ? "is-ready" : "is-missing"} key={contract.key}>
                <span><Icon name={ready ? "check" : "remove"} size={14} /></span>
                <strong>{contract.contractName}</strong>
                <small>{ready ? "已识别" : found.length > 1 ? `发现 ${found.length} 份，请只保留一份` : "缺少源码"}</small>
              </div>
            );
          })}
        </div>

        {sources.length > 0 && (
          <div className="suite-file-list">
            <div className="list-caption"><span>完整上传清单</span><span>{sources.length} 个 Solidity 文件</span></div>
            <div className="suite-file-scroll">
              {sources.map((source) => (
                <div className="suite-file-row" key={source.id}>
                  <span className="file-badge"><Icon name="file" size={15} /></span>
                  <span><strong>{source.name}</strong><small>{source.path} · {(source.size / 1024).toFixed(1)} KB</small></span>
                  <button type="button" onClick={() => removeSource(source.id)} aria-label={`移除 ${source.path}`} title="从上传清单移除"><Icon name="remove" size={16} /></button>
                </div>
              ))}
            </div>
            <button type="button" className="clear-source-list" onClick={() => setSources([])}>清空并重新选择</button>
          </div>
        )}

        <div className="flow-notice"><Icon name="shield" size={18} /><span>后一步会使用前一步生成的代理地址；任一步失败都会停止，不继续发送交易。</span></div>
        <div className="deploy-flow">
          {DEPLOY_STEPS.map((step, index) => (
            <div className={`deploy-step ${step.key === "authorize" ? "relationship-step" : ""}`} key={step.key}>
              <div className="flow-rail"><span>{step.no}</span>{index < DEPLOY_STEPS.length - 1 && <i />}</div>
              <div className="flow-card">
                <div className="flow-copy"><strong>{step.title}</strong><p>{step.detail}</p><small>{step.result}</small></div>
                {step.key !== "authorize" ? (
                  <div className={`flow-source-status ${matches[step.key].length === 1 ? "is-ready" : "is-missing"}`}>
                    <span><Icon name={matches[step.key].length === 1 ? "check" : "remove"} size={16} /></span>
                    <span>
                      <strong>{matches[step.key].length === 1 ? matches[step.key][0].name : `缺少 Topaz${step.name}.sol`}</strong>
                      <small>{matches[step.key].length === 1 ? matches[step.key][0].path : matches[step.key].length > 1 ? "检测到重复主合约，请从清单移除多余文件" : "请先在上方上传完整源码"}</small>
                    </span>
                  </div>
                ) : (
                  <div className="relation-equation"><span>Payment</span><Icon name="chevron" size={16} /><code>LIFECYCLE_ROLE</code><Icon name="chevron" size={16} /><span>Lifecycle Proxy</span></div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ExecutionProcess({ job }: { job: Job }) {
  const logRef = useRef<HTMLDivElement>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const logs = job.logs ?? [];
  const nodes = job.nodes ?? [];
  const progress = Math.min(100, Math.max(0, job.progress ?? 0));

  useEffect(() => {
    if (!followLatest || !logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [followLatest, logs.length]);

  const handleLogScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (element.scrollHeight - element.scrollTop - element.clientHeight > 28 && followLatest) setFollowLatest(false);
  };

  const resumeFollowing = () => {
    setFollowLatest(true);
    window.requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  };

  return (
    <section className={`execution-process ${job.status}`} aria-live="polite">
      <div className="execution-head">
        <span><strong>{job.status === "failed" ? "执行已停止" : job.status === "succeeded" ? "执行完成" : "真实执行进度"}</strong><small>{job.stage || job.message || jobError(job) || "等待服务返回执行状态"}</small></span>
        <strong>{Math.round(progress)}%</strong>
      </div>
      <span className="execution-progress" aria-label={`执行进度 ${Math.round(progress)}%`}><i style={{ width: `${progress}%` }} /></span>
      {nodes.length > 0 && (
        <ol className="execution-nodes">
          {nodes.map((node, index) => (
            <li className={node.status} key={node.id}>
              <span className="execution-node-mark">{node.status === "succeeded" ? <Icon name="check" size={13} /> : node.status === "failed" ? <Icon name="remove" size={13} /> : index + 1}</span>
              <span><strong>{node.label}</strong>{node.message && <small>{node.message}</small>}</span>
            </li>
          ))}
        </ol>
      )}
      {logs.length > 0 && (
        <div className="execution-log-wrap">
          <div className="execution-log-head"><span>执行日志 · {logs.length}</span><button type="button" className={followLatest ? "active" : ""} onClick={followLatest ? () => setFollowLatest(false) : resumeFollowing}>{followLatest ? "正在跟随最新" : "跟随最新"}</button></div>
          <div className="execution-log" ref={logRef} onScroll={handleLogScroll} tabIndex={0} aria-label="真实执行日志">
            {logs.map((log, index) => {
              const time = new Date(log.at);
              const displayTime = !Number.isNaN(time.getTime()) ? time.toLocaleTimeString("zh-CN", { hour12: false }) : "";
              return <div className={`log-line ${log.level}`} key={`${log.at}-${index}`}><time>{displayTime}</time><span>{log.message}</span></div>;
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function Summary({ mode, network, upgradeItems, deploySources, job, onSubmit }: {
  mode: Mode;
  network: NetworkForm;
  upgradeItems: UpgradeItem[];
  deploySources: SourceFile[];
  job?: Job;
  onSubmit: (dryRun: boolean) => void;
}) {
  const upgradeTargets = upgradeItems.filter((item) => item.contractName);
  const upgradeValid = upgradeItems.length > 0 && upgradeTargets.length > 0 && upgradeTargets.every((item) => ADDRESS_RE.test(item.proxyAddress));
  const deployMatches = deploymentSourceMatches(deploySources);
  const invalidDeployContracts = DEPLOY_CONTRACTS.filter((contract) => deployMatches[contract.key].length !== 1);
  const deployValid = deploySources.length > 0 && invalidDeployContracts.length === 0;
  const networkValid = /^https?:\/\//.test(network.rpcUrl) && /^\d+$/.test(network.chainId) && ADDRESS_RE.test(network.adminAddress);
  const valid = networkValid && (mode === "upgrade" ? upgradeValid : deployValid);
  const busy = job && !["succeeded", "failed"].includes(job.status);
  return (
    <aside className="summary-card">
      <div className="summary-head">
        <span className="summary-eyebrow">本次操作</span>
        <span className={`summary-chip ${mode}`}><Icon name={mode === "upgrade" ? "refresh" : "deploy"} size={15} />{mode === "upgrade" ? "升级" : "部署"}</span>
        <h2>{mode === "upgrade" ? `升级 ${upgradeTargets.length || 0} 个合约` : "部署 Topaz 整套合约"}</h2>
        <p>{mode === "upgrade" ? "先逐个完成兼容性检查，再按清单顺序升级。" : "严格按依赖顺序执行，自动关联代理地址和角色。"}</p>
      </div>
      <dl className="summary-list">
        <div><dt>网络</dt><dd>Chain ID {network.chainId || "—"}</dd></div>
        <div><dt>RPC</dt><dd>{network.rpcUrl.replace(/^https?:\/\//, "") || "—"}</dd></div>
        <div><dt>Admin</dt><dd title={network.adminAddress}>{compactAddress(network.adminAddress)}</dd></div>
        <div><dt>{mode === "upgrade" ? "升级清单" : "交易顺序"}</dt><dd>{mode === "upgrade" ? `${upgradeTargets.length} 个目标 · ${upgradeItems.length} 个源码` : "7 笔交易"}</dd></div>
      </dl>
      {mode === "upgrade" ? (
        <div className="summary-contracts">
          {upgradeTargets.length ? upgradeTargets.map((item, index) => <div key={item.id}><span>{index + 1}</span><strong>{CONTRACT_LABELS[item.contractName] || item.contractName}</strong><small>{compactAddress(item.proxyAddress)}</small></div>) : <p>上传源码并指定升级目标后，执行顺序会显示在这里。</p>}
        </div>
      ) : (
        <><div className="summary-source-count"><Icon name="file" size={15} /><span>将上传完整源码清单</span><strong>{deploySources.length} 个文件</strong></div>
        <ol className="summary-sequence">
          <li className={deployMatches.payment.length === 1 ? "is-ready" : "is-missing"}><span>1</span>Payment 实现 + Proxy</li>
          <li className={deployMatches.lifecycle.length === 1 ? "is-ready" : "is-missing"}><span>2</span>Lifecycle 实现 + Proxy</li>
          <li className={deployMatches.contacts.length === 1 ? "is-ready" : "is-missing"}><span>3</span>Contacts 实现 + Proxy</li>
          <li><span>4</span>Payment 授权 Lifecycle</li>
        </ol>
        {!deployValid && <div className="deploy-missing" role="alert">{deploySources.length === 0 ? "请先上传整套合约源码。" : `无法开始：${invalidDeployContracts.map((contract) => {
          const count = deployMatches[contract.key].length;
          return count > 1 ? `${contract.fileName} 重复` : `缺少 ${contract.fileName}`;
        }).join("；")}`}</div>}</>
      )}
      <div className="safety-box"><Icon name="shield" size={19} /><span>{mode === "upgrade" ? "代理地址和已有数据保持不变；不兼容的存储布局会被直接阻止。" : "任一步失败立即停止；已上链的成功步骤会保留并写入本地记录。"}</span></div>
      {job && <ExecutionProcess job={job} />}
      <div className="summary-actions">
        <button className="primary-button" type="button" disabled={!valid || Boolean(busy)} onClick={() => onSubmit(false)}>
          <Icon name={mode === "upgrade" ? "refresh" : "deploy"} size={19} />
          {busy ? "正在执行…" : mode === "upgrade" ? "检查并开始升级" : "检查并部署整套合约"}
        </button>
        <button className="secondary-button" type="button" disabled={!valid || Boolean(busy)} onClick={() => onSubmit(true)}>
          只检查，不发送交易
        </button>
      </div>
      <div className="summary-foot"><Icon name="database" size={15} /> 配置、交易回执和部署记录只保存在本机</div>
    </aside>
  );
}

const ACTION_NAMES: Record<EngineRecord["action"], string> = {
  "deploy-suite": "部署整套合约",
  "upgrade-batch": "升级现有合约",
  "import-baseline": "导入升级基线",
};

function formatRecordTime(value?: string) {
  if (!value) return "进行中";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function RecordAddress({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return <div className="record-address"><span>{label}</span><code title={value}>{value}</code></div>;
}

function HistoryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [records, setRecords] = useState<EngineRecord[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState("");

  const load = async () => {
    setState("loading");
    setError("");
    try {
      setRecords(await listEngineRecords());
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取部署记录失败");
      setState("error");
    }
  };

  useEffect(() => {
    if (!open) return;
    void load();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  if (!open) return null;
  return (
    <div className="drawer-layer" role="presentation">
      <button className="drawer-backdrop" type="button" onClick={onClose} aria-label="关闭部署记录" />
      <aside className="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <div className="drawer-head">
          <div><span className="summary-eyebrow">LOCAL EXECUTION HISTORY</span><h2 id="history-title">部署记录</h2><p>这里保存实际检查、部署和升级的本地结果。</p></div>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="关闭"><Icon name="remove" size={20} /></button>
        </div>
        <div className="drawer-toolbar"><span>{state === "ready" ? `共 ${records.length} 条记录` : "本地记录"}</span><button type="button" onClick={() => void load()} disabled={state === "loading"}><Icon name="refresh" size={14} />刷新</button></div>
        <div className="record-list">
          {state === "loading" && <div className="records-state"><span className="loading-ring" /><strong>正在读取本地记录</strong></div>}
          {state === "error" && <div className="records-state error-state"><Icon name="remove" size={22} /><strong>读取失败</strong><p>{error}</p><button type="button" onClick={() => void load()}>重新加载</button></div>}
          {state === "ready" && records.length === 0 && <div className="records-state"><Icon name="history" size={24} /><strong>还没有部署记录</strong><p>完成一次检查、部署或升级后，结果会出现在这里。</p></div>}
          {state === "ready" && records.map((record, index) => {
            const status = record.status ?? "succeeded";
            const assets: Array<{ name: string; proxy: string; implementation: string; previous?: string; tx?: string }> = [
              ...(record.deployments ?? []).map((item) => ({ name: item.contractName, proxy: item.proxyAddress, implementation: item.implementationAddress, tx: item.proxyTransactionHash || item.implementationTransactionHash })),
              ...(record.upgrades ?? []).map((item) => ({ name: item.contractName, proxy: item.proxyAddress, implementation: item.implementationAddress, previous: item.previousImplementation, tx: item.transactionHash })),
              ...(record.importedBaseline ? [{ name: record.importedBaseline.contractName, proxy: record.importedBaseline.proxyAddress, implementation: record.importedBaseline.implementationAddress }] : []),
            ];
            return (
              <details className={`record-card ${status}`} key={`${record.startedAt}-${index}`} open={index === 0}>
                <summary>
                  <span className={`record-status ${status}`}><Icon name={status === "failed" ? "remove" : status === "running" ? "refresh" : "check"} size={14} /></span>
                  <span className="record-title"><strong>{ACTION_NAMES[record.action]}</strong><small>{formatRecordTime(record.completedAt || record.startedAt)}</small></span>
                  <span className="record-meta">{record.dryRun ? "仅检查" : `Chain ${record.chainId ?? "—"}`}</span>
                  <Icon name="chevron" size={16} />
                </summary>
                <div className="record-body">
                  {record.error && <div className="record-error">{record.error.message}</div>}
                  {assets.map((asset, assetIndex) => <div className="record-contract" key={`${asset.name}-${assetIndex}`}><strong>{asset.name}</strong><RecordAddress label="Proxy" value={asset.proxy} /><RecordAddress label="实现" value={asset.implementation} /><RecordAddress label="上一实现" value={asset.previous} /><RecordAddress label="交易" value={asset.tx} /></div>)}
                  {record.checks && record.checks.length > 0 && <div className="record-checks"><strong>检查结果</strong>{record.checks.map((check, checkIndex) => <p key={`${check}-${checkIndex}`}><Icon name="check" size={13} />{check}</p>)}</div>}
                  {record.transactions.length > 0 && <div className="record-transactions"><strong>交易回执</strong>{record.transactions.map((tx) => <RecordAddress key={tx.hash} label={`${tx.label} · #${tx.blockNumber}`} value={tx.hash} />)}</div>}
                  {!record.error && assets.length === 0 && !record.checks?.length && record.transactions.length === 0 && <p className="record-empty-detail">该记录没有附加详情。</p>}
                </div>
              </details>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>("upgrade");
  const [network, setNetwork] = useState<NetworkForm>(() => {
    try { return { ...DEFAULT_NETWORK, ...JSON.parse(localStorage.getItem("topaz.network") || "{}") }; } catch { return DEFAULT_NETWORK; }
  });
  const [networkState, setNetworkState] = useState<{ checking: boolean; result?: NetworkCheck; error?: string }>({ checking: false });
  const [upgradeItems, setUpgradeItems] = useState<UpgradeItem[]>([]);
  const [deploySources, setDeploySources] = useState<SourceFile[]>([]);
  const [baselineSources, setBaselineSources] = useState<SourceFile[]>([]);
  const [baselineContract, setBaselineContract] = useState("TopazLifecycle");
  const [baselineProxy, setBaselineProxy] = useState("");
  const [job, setJob] = useState<Job>();
  const [recordsOpen, setRecordsOpen] = useState(false);

  useEffect(() => { localStorage.setItem("topaz.network", JSON.stringify(network)); }, [network]);

  useEffect(() => {
    if (!job || ["succeeded", "failed"].includes(job.status)) return;
    const timer = window.setTimeout(async () => {
      try { setJob(await getJob(job.id)); }
      catch (error) { setJob({ ...job, status: "failed", error: error instanceof Error ? error.message : "无法读取任务状态" }); }
    }, POLL_INTERVAL);
    return () => window.clearTimeout(timer);
  }, [job]);

  const connected = useMemo(() => networkState.result?.ok === true && networkState.result.signer?.matchesAdmin === true && Number(network.chainId) === networkState.result.actualChainId, [network.chainId, networkState.result]);

  async function handleNetworkCheck() {
    setNetworkState({ checking: true });
    try {
      const result = await checkNetwork(network);
      setNetworkState({ checking: false, result });
    } catch (error) {
      setNetworkState({ checking: false, error: error instanceof Error ? error.message : "连接失败" });
    }
  }

  async function handleSubmit(dryRun: boolean) {
    try {
      setJob({ id: "pending", action: mode, status: "queued", message: "正在创建任务", progress: 2 });
      const sources = mode === "upgrade"
        ? upgradeItems.map(({ contractName: _contractName, proxyAddress: _proxyAddress, ...source }) => source)
        : deploySources;
      const { sourceSetId } = await uploadSources(sources, network.storageDirectory);
      const engineNetwork = { rpcUrl: network.rpcUrl, chainId: Number(network.chainId), admin: network.adminAddress };
      const payload = mode === "upgrade"
        ? { network: engineNetwork, sourceSetId, dryRun, items: upgradeItems.filter(({ contractName }) => contractName).map(({ contractName, proxyAddress }) => ({ contractName, proxyAddress })) }
        : { network: engineNetwork, sourceSetId, dryRun };
      setJob(await createJob(mode === "upgrade" ? "upgrade-batch" : "deploy-suite", payload));
    } catch (error) {
      setJob({ id: "failed", action: mode, status: "failed", error: error instanceof Error ? error.message : "任务创建失败" });
    }
  }

  async function handleBaselineImport() {
    if (!baselineSources.length) return;
    try {
      setJob({ id: "pending", action: "import-baseline", status: "queued", message: "正在上传当前版本源码", progress: 2 });
      const { sourceSetId } = await uploadSources(baselineSources, network.storageDirectory);
      setJob(await createJob("import-baseline", {
        network: { rpcUrl: network.rpcUrl, chainId: Number(network.chainId), admin: network.adminAddress },
        sourceSetId,
        contractName: baselineContract,
        proxyAddress: baselineProxy,
      }));
    } catch (error) {
      setJob({ id: "failed", action: "import-baseline", status: "failed", error: error instanceof Error ? error.message : "基线导入失败" });
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><Icon name="shield" size={25} /></span><span><strong>Topaz 合约控制台</strong><small>外部网络部署与升级</small></span></div>
        <div className="topbar-right">
          <button className="history-link" type="button" onClick={() => setRecordsOpen(true)}><Icon name="history" size={17} />部署记录</button>
          <span className={`network-badge ${connected ? "connected" : ""}`}><i />{connected ? `已连接 · Chain ID ${network.chainId}` : "尚未验证网络"}</span>
        </div>
      </header>

      <main className="page">
        <section className="workspace-head">
          <div><span className="eyebrow">LOCAL CONTRACT PUBLISHER</span><h1>合约部署与升级</h1><p>上传源码，完成检查，然后执行。每一步都会留下可核对的本地记录。</p></div>
          <div className="mode-switch" role="tablist" aria-label="操作类型">
            <button className={mode === "upgrade" ? "active" : ""} type="button" role="tab" aria-selected={mode === "upgrade"} onClick={() => { setMode("upgrade"); setJob(undefined); }}><Icon name="refresh" size={18} /><span><strong>升级现有合约</strong><small>默认 · 可批量</small></span></button>
            <button className={mode === "deploy" ? "active" : ""} type="button" role="tab" aria-selected={mode === "deploy"} onClick={() => { setMode("deploy"); setJob(undefined); }}><Icon name="deploy" size={18} /><span><strong>部署整套合约</strong><small>按依赖顺序</small></span></button>
          </div>
        </section>

        <div className="workspace-grid">
          <div className="form-column">
            <NetworkPanel network={network} setNetwork={setNetwork} state={networkState} onCheck={handleNetworkCheck} />
            {mode === "upgrade"
              ? <><UpgradePanel items={upgradeItems} setItems={setUpgradeItems} /><BaselineImport sources={baselineSources} contractName={baselineContract} proxyAddress={baselineProxy} busy={Boolean(job && !["succeeded", "failed"].includes(job.status))} onSources={setBaselineSources} onContractName={setBaselineContract} onProxyAddress={setBaselineProxy} onImport={handleBaselineImport} /></>
              : <DeployPanel sources={deploySources} setSources={setDeploySources} />}
          </div>
          <Summary mode={mode} network={network} upgradeItems={upgradeItems} deploySources={deploySources} job={job} onSubmit={handleSubmit} />
        </div>
      </main>
      <footer className="footer"><span>Topaz Contract Console</span><span>仅在本机运行 · 不向外部服务上传源码或配置</span></footer>
      <HistoryDrawer open={recordsOpen} onClose={() => setRecordsOpen(false)} />
    </div>
  );
}
