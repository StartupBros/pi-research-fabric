import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const PACKAGE_NAME = "pi-research-fabric";
const PACKAGE_VERSION = "0.1.0";
const CACHE_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FETCH_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CODE_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SITE_MAP_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_FILENAME = "research-fabric.json";
const EXA_CONFIG_FILENAME = "exa-mcp.json";
const FIRECRAWL_CONFIG_FILENAME = "firecrawl.json";
const DEFAULT_CACHE_DIR = join(homedir(), ".pi", "agent", "cache", "research-fabric");
const SECRETS_PATH = join(homedir(), ".secrets");

const DEFAULT_CONFIG = {
  searchProviders: ["exa", "brave", "firecrawl"],
  fetchProviders: ["firecrawl", "direct"],
  codeContextProviders: ["exa"],
  siteMapProviders: ["firecrawl"],
  preferDynamicFetchForDomains: ["openai.com", "anthropic.com"],
  cacheDir: DEFAULT_CACHE_DIR,
  searchTtlMs: DEFAULT_SEARCH_TTL_MS,
  fetchTtlMs: DEFAULT_FETCH_TTL_MS,
  codeContextTtlMs: DEFAULT_CODE_CONTEXT_TTL_MS,
  siteMapTtlMs: DEFAULT_SITE_MAP_TTL_MS,
} as const;

const CLIENT_INFO = {
  name: PACKAGE_NAME,
  version: PACKAGE_VERSION,
} as const;

type JsonObject = Record<string, unknown>;

type ResearchFabricConfig = {
  searchProviders?: string[];
  fetchProviders?: string[];
  codeContextProviders?: string[];
  siteMapProviders?: string[];
  preferDynamicFetchForDomains?: string[];
  cacheDir?: string;
  searchTtlMs?: number;
  fetchTtlMs?: number;
  codeContextTtlMs?: number;
  siteMapTtlMs?: number;
};

type ExaConfig = {
  url?: string;
  apiKey?: string;
  tools?: string[];
  timeoutMs?: number;
  protocolVersion?: string;
};

type FirecrawlConfig = {
  url?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
};

type CacheEntry = {
  createdAt: number;
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
};

type ToolResultPayload = {
  text: string;
  details: Record<string, unknown>;
  isError?: boolean;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type McpToolResult = {
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const values = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return values.length > 0 ? values : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const values = value
    .map((item) => normalizeString(item))
    .filter((item): item is string => Boolean(item));
  return values.length > 0 ? values : undefined;
}

function resolvePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
  if (isAbsolute(trimmed)) return trimmed;
  return resolve(process.cwd(), trimmed);
}

function readJsonIfExists(path: string): JsonObject | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function ensureDefaultConfigFile(projectPath: string, globalPath: string): void {
  if (existsSync(projectPath) || existsSync(globalPath)) return;
  try {
    ensureDir(dirname(globalPath));
    writeFileSync(globalPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[${PACKAGE_NAME}] Failed to write ${globalPath}: ${message}`);
  }
}

function loadConfigFile(filename: string, explicitPath?: string): JsonObject | null {
  const envConfig = filename === CONFIG_FILENAME ? process.env.RESEARCH_FABRIC_CONFIG : undefined;
  const candidates: string[] = [];

  if (explicitPath) {
    candidates.push(resolvePath(explicitPath));
  } else if (envConfig) {
    candidates.push(resolvePath(envConfig));
  } else {
    const projectPath = join(process.cwd(), ".pi", "extensions", filename);
    const globalPath = join(homedir(), ".pi", "agent", "extensions", filename);
    if (filename === CONFIG_FILENAME) {
      ensureDefaultConfigFile(projectPath, globalPath);
    }
    candidates.push(projectPath, globalPath);
  }

  for (const candidate of candidates) {
    const parsed = readJsonIfExists(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function loadSecretsEnv(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) return {};

  const env: Record<string, string> = {};
  const raw = readFileSync(SECRETS_PATH, "utf-8");

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

const secretsEnv = loadSecretsEnv();

function getEnvValue(key: string): string | undefined {
  return normalizeString(process.env[key] ?? secretsEnv[key]);
}

function normalizeFetchProvider(provider: string): string {
  return provider === "brave" ? "direct" : provider;
}

function parseResearchFabricConfig(explicitPath?: string): ResearchFabricConfig {
  const raw = loadConfigFile(CONFIG_FILENAME, explicitPath);
  if (!raw) {
    return {
      searchProviders: [...DEFAULT_CONFIG.searchProviders],
      fetchProviders: [...DEFAULT_CONFIG.fetchProviders],
      codeContextProviders: [...DEFAULT_CONFIG.codeContextProviders],
      siteMapProviders: [...DEFAULT_CONFIG.siteMapProviders],
      preferDynamicFetchForDomains: [...DEFAULT_CONFIG.preferDynamicFetchForDomains],
      cacheDir: DEFAULT_CONFIG.cacheDir,
      searchTtlMs: DEFAULT_CONFIG.searchTtlMs,
      fetchTtlMs: DEFAULT_CONFIG.fetchTtlMs,
      codeContextTtlMs: DEFAULT_CONFIG.codeContextTtlMs,
      siteMapTtlMs: DEFAULT_CONFIG.siteMapTtlMs,
    };
  }

  return {
    searchProviders: normalizeStringArray(raw.searchProviders) ?? [...DEFAULT_CONFIG.searchProviders],
    fetchProviders:
      (normalizeStringArray(raw.fetchProviders) ?? [...DEFAULT_CONFIG.fetchProviders]).map(normalizeFetchProvider),
    codeContextProviders: normalizeStringArray(raw.codeContextProviders) ?? [...DEFAULT_CONFIG.codeContextProviders],
    siteMapProviders: normalizeStringArray(raw.siteMapProviders) ?? [...DEFAULT_CONFIG.siteMapProviders],
    preferDynamicFetchForDomains:
      normalizeStringArray(raw.preferDynamicFetchForDomains) ?? [...DEFAULT_CONFIG.preferDynamicFetchForDomains],
    cacheDir:
      resolvePath(
        getEnvValue("RESEARCH_FABRIC_CACHE_DIR") ?? normalizeString(raw.cacheDir) ?? DEFAULT_CONFIG.cacheDir,
      ),
    searchTtlMs: normalizeNumber(raw.searchTtlMs) ?? DEFAULT_CONFIG.searchTtlMs,
    fetchTtlMs: normalizeNumber(raw.fetchTtlMs) ?? DEFAULT_CONFIG.fetchTtlMs,
    codeContextTtlMs: normalizeNumber(raw.codeContextTtlMs) ?? DEFAULT_CONFIG.codeContextTtlMs,
    siteMapTtlMs: normalizeNumber(raw.siteMapTtlMs) ?? DEFAULT_CONFIG.siteMapTtlMs,
  };
}

function parseExaConfig(): ExaConfig {
  const raw = loadConfigFile(EXA_CONFIG_FILENAME);
  return {
    url: getEnvValue("EXA_MCP_URL") ?? normalizeString(raw?.url) ?? "https://mcp.exa.ai/mcp",
    apiKey:
      getEnvValue("EXA_API_KEY") ??
      getEnvValue("EXA_MCP_API_KEY") ??
      normalizeString(raw?.apiKey),
    tools:
      normalizeStringArray(getEnvValue("EXA_MCP_TOOLS")) ??
      normalizeStringArray(raw?.tools) ??
      ["web_search_exa", "get_code_context_exa"],
    timeoutMs:
      normalizeNumber(getEnvValue("EXA_MCP_TIMEOUT_MS")) ??
      normalizeNumber(raw?.timeoutMs) ??
      DEFAULT_TIMEOUT_MS,
    protocolVersion:
      getEnvValue("EXA_MCP_PROTOCOL_VERSION") ??
      normalizeString(raw?.protocolVersion) ??
      DEFAULT_PROTOCOL_VERSION,
  };
}

function parseFirecrawlConfig(): FirecrawlConfig {
  const raw = loadConfigFile(FIRECRAWL_CONFIG_FILENAME);
  const headers = isRecord(raw?.headers)
    ? Object.fromEntries(
        Object.entries(raw.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    : undefined;

  return {
    url: getEnvValue("FIRECRAWL_URL") ?? normalizeString(raw?.url) ?? "https://api.firecrawl.dev",
    apiKey: getEnvValue("FIRECRAWL_API_KEY") ?? normalizeString(raw?.apiKey),
    headers,
    timeoutMs:
      normalizeNumber(getEnvValue("FIRECRAWL_TIMEOUT_MS")) ??
      normalizeNumber(raw?.timeoutMs) ??
      DEFAULT_TIMEOUT_MS,
  };
}

function getBraveApiKey(): string | undefined {
  return getEnvValue("BRAVE_API_KEY");
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function cachePath(cacheDir: string, key: string): string {
  return join(cacheDir, `${sha1(key)}.json`);
}

function readCache(cacheDir: string, key: string, ttlMs: number): CacheEntry | null {
  const path = cachePath(cacheDir, key);
  if (!existsSync(path)) return null;

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as CacheEntry;
    if (Date.now() - raw.createdAt > ttlMs) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCache(cacheDir: string, key: string, value: CacheEntry): void {
  ensureDir(cacheDir);
  writeFileSync(cachePath(cacheDir, key), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writeTempFile(prefix: string, content: string): string {
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "_");
  const filename = `${PACKAGE_NAME}-${safePrefix}-${Date.now()}.txt`;
  const filePath = join(tmpdir(), filename);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function formatTruncatedOutput(
  toolName: string,
  rawText: string,
  details: Record<string, unknown>,
  maxBytes = DEFAULT_MAX_BYTES,
  maxLines = DEFAULT_MAX_LINES,
): ToolResultPayload {
  const truncation = truncateHead(rawText, { maxBytes, maxLines });
  let text = truncation.content;
  let fullOutputPath: string | undefined;

  if (truncation.truncated) {
    fullOutputPath = writeTempFile(toolName, rawText);
    text +=
      `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
      `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
      `Full output saved to: ${fullOutputPath}]`;
  }

  return {
    text,
    details: {
      ...details,
      truncation: {
        truncated: truncation.truncated,
        truncatedBy: truncation.truncatedBy,
        totalLines: truncation.totalLines,
        totalBytes: truncation.totalBytes,
        outputLines: truncation.outputLines,
        outputBytes: truncation.outputBytes,
        maxLines: truncation.maxLines,
        maxBytes: truncation.maxBytes,
      },
      fullOutputPath,
    },
  };
}

function makeCacheKey(capability: string, params: Record<string, unknown>): string {
  return JSON.stringify({ version: CACHE_VERSION, capability, params });
}

function formatCached(entry: CacheEntry): ToolResultPayload {
  return {
    text: entry.text,
    details: {
      ...entry.details,
      cacheHit: true,
      cachedAt: new Date(entry.createdAt).toISOString(),
    },
    isError: entry.isError,
  };
}

function cacheAndReturn(cacheDir: string, key: string, payload: ToolResultPayload): ToolResultPayload {
  writeCache(cacheDir, key, {
    createdAt: Date.now(),
    text: payload.text,
    details: payload.details,
    isError: payload.isError,
  });
  return payload;
}

function withTimeout(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();

  if (parent) {
    if (parent.aborted) {
      controller.abort();
    } else {
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

function toJsonString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveExaEndpoint(config: ExaConfig): string {
  const url = new URL(config.url ?? "https://mcp.exa.ai/mcp");
  if (config.tools && config.tools.length > 0 && !url.searchParams.has("tools")) {
    url.searchParams.set("tools", config.tools.join(","));
  }
  if (config.apiKey && !url.searchParams.has("exaApiKey")) {
    url.searchParams.set("exaApiKey", config.apiKey);
  }
  return url.toString();
}

function redactExaEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("exaApiKey")) {
      url.searchParams.set("exaApiKey", "REDACTED");
    }
    return url.toString();
  } catch {
    return endpoint;
  }
}

class ExaMcpClient {
  private requestCounter = 0;
  private initialized = false;
  private initializing: Promise<void> | null = null;
  private lastEndpoint: string | null = null;

  constructor(private readonly getConfig: () => ExaConfig) {}

  currentEndpoint(): string {
    return resolveExaEndpoint(this.getConfig());
  }

  async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.ensureInitialized(signal);
    const result = await this.sendRequest("tools/call", { name: toolName, arguments: args }, signal);
    if (isRecord(result)) {
      return result as McpToolResult;
    }
    return { content: [{ type: "text", text: toJsonString(result) }] };
  }

  private async ensureInitialized(signal?: AbortSignal): Promise<void> {
    const endpoint = this.currentEndpoint();
    if (this.lastEndpoint !== endpoint) {
      this.lastEndpoint = endpoint;
      this.initialized = false;
      this.initializing = null;
    }

    if (this.initialized) return;

    if (!this.initializing) {
      this.initializing = (async () => {
        await this.sendRequest(
          "initialize",
          {
            protocolVersion: this.getConfig().protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
          },
          signal,
          endpoint,
        );
        await this.sendNotification("notifications/initialized", {}, signal, endpoint);
        this.initialized = true;
      })().finally(() => {
        this.initializing = null;
      });
    }

    await this.initializing;
  }

  private nextId(): string {
    this.requestCounter += 1;
    return `${PACKAGE_NAME}-exa-${this.requestCounter}`;
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    overrideEndpoint?: string,
  ): Promise<unknown> {
    const id = this.nextId();
    const response = await this.sendJsonRpc({ jsonrpc: "2.0", id, method, params }, signal, overrideEndpoint);
    const json = extractJsonRpcResponse(response, id);
    if (json.error) {
      throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    overrideEndpoint?: string,
  ): Promise<void> {
    await this.sendJsonRpc({ jsonrpc: "2.0", method, params }, signal, overrideEndpoint, true);
  }

  private async sendJsonRpc(
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    overrideEndpoint?: string,
    isNotification = false,
  ): Promise<unknown> {
    const endpoint = overrideEndpoint ?? this.currentEndpoint();
    const config = this.getConfig();
    const { signal: mergedSignal, cleanup } = withTimeout(signal, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: mergedSignal,
      });

      if (response.status === 204 || response.status === 202) {
        return undefined;
      }
      if (!response.ok) {
        throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
      }
      if (isNotification) {
        return undefined;
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        return response.json();
      }
      if (contentType.includes("text/event-stream")) {
        return parseSseResponse(response, payload.id);
      }
      throw new Error(`Unexpected response content-type: ${contentType || "unknown"}`);
    } finally {
      cleanup();
    }
  }
}

function extractJsonRpcResponse(response: unknown, requestId: unknown): JsonRpcResponse {
  if (Array.isArray(response)) {
    const match = response.find((item) => isRecord(item) && item.id === requestId && item.jsonrpc === "2.0");
    if (match && isRecord(match)) {
      return match as JsonRpcResponse;
    }
    throw new Error("MCP response did not include matching request id.");
  }
  if (isRecord(response) && response.jsonrpc === "2.0") {
    return response as JsonRpcResponse;
  }
  throw new Error("Invalid MCP response payload.");
}

async function parseSseResponse(response: Response, requestId: unknown): Promise<unknown> {
  if (!response.body) {
    throw new Error("MCP response stream missing body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trimEnd();
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");

      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const parsed = JSON.parse(data) as unknown;
      if (isRecord(parsed) && parsed.id === requestId) {
        await reader.cancel();
        return parsed;
      }
    }
  }

  throw new Error("MCP SSE response completed without matching request id.");
}

function renderMcpBlocks(result: McpToolResult): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  if (blocks.length === 0) {
    return toJsonString(result);
  }
  return blocks
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return toJsonString(block);
    })
    .join("\n");
}

function isProviderErrorResult(result: McpToolResult, renderedText: string): boolean {
  return result.isError === true || /^mcp error\b/i.test(renderedText.trim()) || /^error\b/i.test(renderedText.trim());
}

async function callFirecrawl(
  config: FirecrawlConfig,
  endpointPath: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const baseUrl = config.url ?? "https://api.firecrawl.dev";
  const { signal: mergedSignal, cleanup } = withTimeout(signal, config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${endpointPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: mergedSignal,
    });

    if (!response.ok) {
      throw new Error(`Firecrawl API ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    if (isRecord(json) && json.success === false && typeof json.error === "string") {
      throw new Error(json.error);
    }
    return json;
  } finally {
    cleanup();
  }
}

async function callBraveSearch(
  apiKey: string,
  params: {
    query: string;
    numResults?: number;
    freshness?: string;
    includeDomains?: string[];
    excludeDomains?: string[];
  },
  signal?: AbortSignal,
): Promise<string> {
  const searchParams = new URLSearchParams({
    q: params.query,
    count: String(Math.min(params.numResults ?? 8, 20)),
    country: "US",
  });

  if (params.freshness) searchParams.set("freshness", params.freshness);
  if (params.includeDomains && params.includeDomains.length > 0) {
    searchParams.set("site", params.includeDomains.join(","));
  }
  if (params.excludeDomains && params.excludeDomains.length > 0) {
    searchParams.set("-site", params.excludeDomains.join(","));
  }

  const { signal: mergedSignal, cleanup } = withTimeout(signal, DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${searchParams.toString()}`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: mergedSignal,
    });

    if (!response.ok) {
      throw new Error(`Brave API ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    const results = isRecord(json) && isRecord(json.web) && Array.isArray(json.web.results) ? json.web.results : [];

    return results
      .map((result, index) => {
        if (!isRecord(result)) return null;
        const title = normalizeString(result.title) ?? "Untitled";
        const url = normalizeString(result.url) ?? "";
        const snippet = normalizeString(result.description) ?? "";
        const age = normalizeString(result.age) ?? normalizeString(result.page_age) ?? "";
        return [
          `Result ${index + 1}: ${title}`,
          url ? `URL: ${url}` : null,
          age ? `Age: ${age}` : null,
          snippet ? `Snippet: ${snippet}` : null,
        ]
          .filter(Boolean)
          .join("\n");
      })
      .filter((item): item is string => Boolean(item))
      .join("\n\n");
  } finally {
    cleanup();
  }
}

async function simpleFetch(url: string, signal?: AbortSignal): Promise<string> {
  const { signal: mergedSignal, cleanup } = withTimeout(signal, DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: mergedSignal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const withoutScripts = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

    return withoutScripts.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 12000);
  } finally {
    cleanup();
  }
}

function prefersDynamicFetch(url: string, config: ResearchFabricConfig): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const domains = config.preferDynamicFetchForDomains ?? [...DEFAULT_CONFIG.preferDynamicFetchForDomains];
    return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export default function researchFabric(pi: ExtensionAPI) {
  pi.registerFlag("--research-fabric-config", {
    description: `Path to JSON config file (defaults to .pi/extensions/${CONFIG_FILENAME} or ~/.pi/agent/extensions/${CONFIG_FILENAME}).`,
    type: "string",
  });

  const getResearchConfig = (): ResearchFabricConfig => {
    const configFlag = pi.getFlag("--research-fabric-config");
    return parseResearchFabricConfig(typeof configFlag === "string" ? configFlag : undefined);
  };

  const exaClient = new ExaMcpClient(parseExaConfig);

  const freshnessEnum = StringEnum(["pd", "pw", "pm", "py"], {
    description: "Freshness window: past day/week/month/year.",
  });
  const providerEnum = (values: string[], description: string) =>
    StringEnum(values as [string, ...string[]], { description });

  const webSearchParams = Type.Object({
    query: Type.String({ description: "Search query" }),
    numResults: Type.Optional(Type.Number({ description: "Maximum number of results", default: 8 })),
    freshness: Type.Optional(freshnessEnum),
    includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only include these domains" })),
    excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains" })),
    preferProvider: Type.Optional(
      providerEnum(["auto", "exa", "brave", "firecrawl"], "Preferred provider."),
    ),
    deep: Type.Optional(Type.Boolean({ description: "Use deeper search if provider supports it" })),
  });

  const webFetchParams = Type.Object({
    url: Type.String({ description: "URL to fetch" }),
    preferProvider: Type.Optional(
      providerEnum(["auto", "firecrawl", "direct", "brave"], "Preferred fetch provider."),
    ),
    renderJs: Type.Optional(Type.Boolean({ description: "Render JavaScript when supported", default: true })),
    onlyMainContent: Type.Optional(
      Type.Boolean({ description: "Extract only main content when supported", default: true }),
    ),
  });

  const codeContextParams = Type.Object({
    query: Type.String({ description: "Code or documentation query" }),
    tokensNum: Type.Optional(Type.Number({ description: "Approximate token budget for retrieved context" })),
    preferProvider: Type.Optional(providerEnum(["auto", "exa"], "Preferred provider.")),
  });

  const siteMapParams = Type.Object({
    url: Type.String({ description: "Base site URL to map" }),
    limit: Type.Optional(Type.Number({ description: "Maximum URLs to return" })),
    search: Type.Optional(Type.String({ description: "Optional filter query for discovered URLs" })),
    includeSubdomains: Type.Optional(Type.Boolean({ description: "Include subdomains", default: false })),
    preferProvider: Type.Optional(providerEnum(["auto", "firecrawl"], "Preferred provider.")),
  });

  const executeWebSearch = async (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void,
  ): Promise<ToolResultPayload> => {
    const config = getResearchConfig();
    const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR;
    const key = makeCacheKey("WebSearch", params);
    const cached = readCache(cacheDir, key, config.searchTtlMs ?? DEFAULT_SEARCH_TTL_MS);
    if (cached) return formatCached(cached);

    const preferred = normalizeString(params.preferProvider) ?? "auto";
    const searchProviders = config.searchProviders ?? [...DEFAULT_CONFIG.searchProviders];
    const ordered =
      preferred !== "auto"
        ? [preferred, ...searchProviders.filter((provider) => provider !== preferred)]
        : searchProviders;
    const query = String(params.query ?? "").trim();

    for (const provider of ordered) {
      try {
        if (provider === "exa") {
          const exa = parseExaConfig();
          if (!exa.apiKey && !normalizeString(exa.url)) continue;
          onUpdate?.({ content: [{ type: "text", text: "WebSearch → Exa" }], details: { provider } });

          const requestedDeep = params.deep === true;
          const result = await exaClient.callTool(
            "web_search_exa",
            {
              query,
              numResults: params.numResults,
              type: "auto",
              livecrawl: requestedDeep ? "preferred" : "fallback",
              contextMaxCharacters: requestedDeep ? 16000 : 12000,
            },
            signal,
          );

          const rendered = renderMcpBlocks(result);
          if (isProviderErrorResult(result, rendered)) {
            throw new Error(rendered);
          }

          return cacheAndReturn(
            cacheDir,
            key,
            formatTruncatedOutput("WebSearch", rendered, {
              capability: "WebSearch",
              provider: "exa",
              endpoint: redactExaEndpoint(exaClient.currentEndpoint()),
              cacheHit: false,
              sourceTool: "web_search_exa",
              requestedDeep,
              appliedSearchMode: "auto",
              appliedLivecrawl: requestedDeep ? "preferred" : "fallback",
            }),
          );
        }

        if (provider === "brave") {
          const braveKey = getBraveApiKey();
          if (!braveKey) continue;
          onUpdate?.({ content: [{ type: "text", text: "WebSearch → Brave" }], details: { provider } });
          const text = await callBraveSearch(
            braveKey,
            {
              query,
              numResults: normalizeNumber(params.numResults),
              freshness: normalizeString(params.freshness),
              includeDomains: normalizeStringArray(params.includeDomains),
              excludeDomains: normalizeStringArray(params.excludeDomains),
            },
            signal,
          );

          return cacheAndReturn(
            cacheDir,
            key,
            formatTruncatedOutput("WebSearch", text || "No Brave results.", {
              capability: "WebSearch",
              provider: "brave",
              cacheHit: false,
              sourceTool: "brave-search-api",
            }),
          );
        }

        if (provider === "firecrawl") {
          const firecrawl = parseFirecrawlConfig();
          if (!firecrawl.apiKey) continue;
          onUpdate?.({ content: [{ type: "text", text: "WebSearch → Firecrawl" }], details: { provider } });
          const response = await callFirecrawl(
            firecrawl,
            "/v1/search",
            {
              query,
              limit: params.numResults,
              scrapeOptions: params.deep
                ? { formats: ["markdown"], onlyMainContent: true }
                : undefined,
            },
            signal,
          );

          return cacheAndReturn(
            cacheDir,
            key,
            formatTruncatedOutput("WebSearch", toJsonString(response), {
              capability: "WebSearch",
              provider: "firecrawl",
              cacheHit: false,
              sourceTool: "firecrawl_search",
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUpdate?.({
          content: [{ type: "text", text: `WebSearch provider ${provider} failed: ${message}` }],
          details: { provider, failed: true },
        });
      }
    }

    return {
      text: "WebSearch error: no configured provider succeeded.",
      isError: true,
      details: { capability: "WebSearch", providersTried: ordered, cacheHit: false },
    };
  };

  const executeWebFetch = async (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void,
  ): Promise<ToolResultPayload> => {
    const config = getResearchConfig();
    const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR;
    const key = makeCacheKey("WebFetch", params);
    const cached = readCache(cacheDir, key, config.fetchTtlMs ?? DEFAULT_FETCH_TTL_MS);
    if (cached) return formatCached(cached);

    const preferred = normalizeFetchProvider(normalizeString(params.preferProvider) ?? "auto");
    const url = String(params.url ?? "").trim();
    const dynamicHint = prefersDynamicFetch(url, config);
    const fetchProviders = (config.fetchProviders ?? [...DEFAULT_CONFIG.fetchProviders]).map(normalizeFetchProvider);
    const ordered =
      preferred !== "auto"
        ? [preferred, ...fetchProviders.filter((provider) => provider !== preferred)]
        : fetchProviders;

    for (const provider of ordered) {
      try {
        if (provider === "firecrawl") {
          const firecrawl = parseFirecrawlConfig();
          if (!firecrawl.apiKey) continue;
          onUpdate?.({ content: [{ type: "text", text: "WebFetch → Firecrawl" }], details: { provider } });
          const response = await callFirecrawl(
            firecrawl,
            "/v1/scrape",
            {
              url,
              formats: ["markdown"],
              onlyMainContent: params.onlyMainContent ?? true,
              waitFor: params.renderJs === false ? 0 : 1500,
            },
            signal,
          );

          return cacheAndReturn(
            cacheDir,
            key,
            formatTruncatedOutput("WebFetch", toJsonString(response), {
              capability: "WebFetch",
              provider: "firecrawl",
              cacheHit: false,
              sourceTool: "firecrawl_scrape",
              dynamicHint,
            }),
          );
        }

        if (provider === "direct") {
          onUpdate?.({
            content: [{ type: "text", text: "WebFetch → direct fetch fallback" }],
            details: { provider },
          });
          const text = await simpleFetch(url, signal);

          return cacheAndReturn(
            cacheDir,
            key,
            formatTruncatedOutput("WebFetch", text, {
              capability: "WebFetch",
              provider: "direct",
              cacheHit: false,
              sourceTool: "direct-fetch",
              dynamicHint,
              note: dynamicHint
                ? "If content looks incomplete, use browser tools or agent-browser for JS-heavy rendering."
                : undefined,
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUpdate?.({
          content: [{ type: "text", text: `WebFetch provider ${provider} failed: ${message}` }],
          details: { provider, failed: true },
        });
      }
    }

    return {
      text: dynamicHint
        ? "WebFetch error: provider fetch failed. This domain often needs browser-based fetching; try browser tools or agent-browser."
        : "WebFetch error: no configured provider succeeded.",
      isError: true,
      details: { capability: "WebFetch", providersTried: ordered, cacheHit: false, dynamicHint },
    };
  };

  const executeCodeContextSearch = async (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void,
  ): Promise<ToolResultPayload> => {
    const config = getResearchConfig();
    const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR;
    const key = makeCacheKey("CodeContextSearch", params);
    const cached = readCache(cacheDir, key, config.codeContextTtlMs ?? DEFAULT_CODE_CONTEXT_TTL_MS);
    if (cached) return formatCached(cached);

    const preferred = normalizeString(params.preferProvider) ?? "auto";
    const providers = config.codeContextProviders ?? [...DEFAULT_CONFIG.codeContextProviders];
    const ordered =
      preferred !== "auto"
        ? [preferred, ...providers.filter((provider) => provider !== preferred)]
        : providers;
    const query = String(params.query ?? "").trim();

    for (const provider of ordered) {
      try {
        if (provider === "exa") {
          const exa = parseExaConfig();
          if (!exa.apiKey && !normalizeString(exa.url)) continue;
          onUpdate?.({ content: [{ type: "text", text: "CodeContextSearch → Exa" }], details: { provider } });
          const result = await exaClient.callTool(
            "get_code_context_exa",
            {
              query,
              tokensNum: params.tokensNum ?? 4000,
            },
            signal,
          );

          const rendered = renderMcpBlocks(result);
          if (isProviderErrorResult(result, rendered)) {
            throw new Error(rendered);
          }

          return cacheAndReturn(
            cacheDir,
            key,
            formatTruncatedOutput("CodeContextSearch", rendered, {
              capability: "CodeContextSearch",
              provider: "exa",
              cacheHit: false,
              sourceTool: "get_code_context_exa",
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUpdate?.({
          content: [{ type: "text", text: `CodeContextSearch provider ${provider} failed: ${message}` }],
          details: { provider, failed: true },
        });
      }
    }

    return {
      text: "CodeContextSearch error: no configured provider succeeded.",
      isError: true,
      details: { capability: "CodeContextSearch", providersTried: ordered, cacheHit: false },
    };
  };

  const executeSiteMap = async (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void,
  ): Promise<ToolResultPayload> => {
    const config = getResearchConfig();
    const cacheDir = config.cacheDir ?? DEFAULT_CACHE_DIR;
    const key = makeCacheKey("SiteMap", params);
    const cached = readCache(cacheDir, key, config.siteMapTtlMs ?? DEFAULT_SITE_MAP_TTL_MS);
    if (cached) return formatCached(cached);

    const preferred = normalizeString(params.preferProvider) ?? "auto";
    const providers = config.siteMapProviders ?? [...DEFAULT_CONFIG.siteMapProviders];
    const ordered =
      preferred !== "auto"
        ? [preferred, ...providers.filter((provider) => provider !== preferred)]
        : providers;

    for (const provider of ordered) {
      try {
        if (provider === "firecrawl") {
          const firecrawl = parseFirecrawlConfig();
          if (!firecrawl.apiKey) continue;
          onUpdate?.({ content: [{ type: "text", text: "SiteMap → Firecrawl" }], details: { provider } });
          const response = await callFirecrawl(
            firecrawl,
            "/v1/map",
            {
              url: String(params.url ?? "").trim(),
              limit: params.limit,
              search: params.search,
              includeSubdomains: params.includeSubdomains ?? false,
            },
            signal,
          );

          return cacheAndReturn(
            cacheDir,
            key,
            formatTruncatedOutput("SiteMap", toJsonString(response), {
              capability: "SiteMap",
              provider: "firecrawl",
              cacheHit: false,
              sourceTool: "firecrawl_map",
            }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUpdate?.({
          content: [{ type: "text", text: `SiteMap provider ${provider} failed: ${message}` }],
          details: { provider, failed: true },
        });
      }
    }

    return {
      text: "SiteMap error: no configured provider succeeded.",
      isError: true,
      details: { capability: "SiteMap", providersTried: ordered, cacheHit: false },
    };
  };

  const registerCapabilityTool = (
    name: string,
    label: string,
    description: string,
    parameters: ReturnType<typeof Type.Object>,
    handler: (
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: (update: { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void,
    ) => Promise<ToolResultPayload>,
  ) => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_toolCallId, params, signal, onUpdate) {
        const result = await handler(
          params as Record<string, unknown>,
          signal,
          onUpdate as unknown as
            | ((update: { content?: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }) => void)
            | undefined,
        );
        return {
          content: [{ type: "text" as const, text: result.text }],
          details: result.details,
          isError: result.isError,
        };
      },
    });
  };

  registerCapabilityTool(
    "WebSearch",
    "Web Search Capability",
    "Harness-agnostic web search capability. Use when migrated skills mention WebSearch or when you need current web discovery. Routes to Exa first, then Brave, then Firecrawl.",
    webSearchParams,
    executeWebSearch,
  );

  registerCapabilityTool(
    "WebFetch",
    "Web Fetch Capability",
    "Harness-agnostic web fetch capability. Use when migrated skills mention WebFetch or when you need readable content from a known URL. Routes to Firecrawl first, then direct fetch fallback.",
    webFetchParams,
    executeWebFetch,
  );

  registerCapabilityTool(
    "CodeContextSearch",
    "Code Context Search Capability",
    "Harness-agnostic code/doc context capability. Best for API usage, implementation patterns, and documentation examples. Routes to Exa code context.",
    codeContextParams,
    executeCodeContextSearch,
  );

  registerCapabilityTool(
    "SiteMap",
    "Site Map Capability",
    "Harness-agnostic site mapping capability. Use to discover likely documentation or content URLs before fetching specific pages. Routes to Firecrawl map.",
    siteMapParams,
    executeSiteMap,
  );

  pi.on("before_agent_start", async (event) => {
    const note = [
      "",
      "## Research capability tools",
      "Use these capability tools for migrated cross-harness skills and commands:",
      "- `WebSearch` for current web discovery (Exa → Brave → Firecrawl)",
      "- `WebFetch` for known URL content extraction (Firecrawl → direct fetch fallback)",
      "- `CodeContextSearch` for code/docs/API examples (Exa)",
      "- `SiteMap` for discovering URLs on a site (Firecrawl)",
      "",
      "When a migrated skill mentions harness-native tools like `WebSearch` or `WebFetch`, use these capability tools.",
      "If `WebFetch` returns incomplete content for JS-heavy or authenticated pages, fall back to browser tools or `agent-browser`.",
    ].join("\n");

    return { systemPrompt: `${event.systemPrompt}${note}` };
  });
}
