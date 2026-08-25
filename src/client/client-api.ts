import type { EngineRecord, Job, NetworkCheck, NetworkForm, SourceFile } from "./types";

const jsonHeaders = { "Content-Type": "application/json" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = Array.isArray(payload?.details) && payload.details[0]?.message ? `：${payload.details[0].message}` : "";
    const message = typeof payload?.message === "string" ? payload.message : typeof payload?.error === "string" ? `${payload.error}${detail}` : `请求失败（${response.status}）`;
    throw new Error(message);
  }
  return payload as T;
}

export function checkNetwork(network: NetworkForm): Promise<NetworkCheck> {
  return request<NetworkCheck>("/api/network/check", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ rpcUrl: network.rpcUrl, chainId: Number(network.chainId), admin: network.adminAddress }),
  });
}

export function uploadSources(sources: SourceFile[], storageDirectory = ""): Promise<{ sourceSetId: string; files: string[]; storageDirectory: string }> {
  const data = new FormData();
  data.append("storageDirectory", storageDirectory);
  for (const source of sources) {
    data.append("files", new File([source.content], source.name, { type: "text/plain" }), source.path || source.name);
  }
  return request<{ sourceSetId: string; files: string[]; storageDirectory: string }>("/api/sources", { method: "POST", body: data });
}

export function createJob(action: "upgrade-batch" | "deploy-suite", payload: unknown): Promise<Job> {
  return request<Job>("/api/jobs", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ action, payload }),
  });
}

export function getJob(jobId: string): Promise<Job> {
  return request<Job>(`/api/jobs/${encodeURIComponent(jobId)}`);
}

export function listEngineRecords(): Promise<EngineRecord[]> {
  return request<{ records: EngineRecord[] }>("/api/records").then((payload) => payload.records);
}
