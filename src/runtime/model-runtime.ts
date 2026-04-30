import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ResolvedRuntimeModelConfig,
  RuntimeModelProvider
} from "./project-config-store.js";
import { runtimeDirectoryPath } from "./session-store.js";

const modelCredentialSchemaVersion = 1;
const modelCredentialFileName = "model-credentials.json";
const openAiCodexAuthBaseUrl = "https://auth.openai.com";
const openAiCodexClientId = "app_EMoamEEZ73f0CkXaXp7hrann";
const openAiCodexDeviceCallbackUrl = `${openAiCodexAuthBaseUrl}/deviceauth/callback`;
const openAiCodexDeviceCodeTimeoutMs = 15 * 60_000;
const openAiCodexDeviceCodeDefaultIntervalMs = 5_000;
const openAiCodexDeviceCodeMinIntervalMs = 1_000;

export type ModelRuntimeFailureKind =
  | "timeout"
  | "malformed_json"
  | "http"
  | "auth"
  | "unexpected";

export class ModelRuntimeError extends Error {
  constructor(
    public readonly kind: ModelRuntimeFailureKind,
    public readonly operation: string,
    message: string,
    public readonly timeoutMs: number | null = null
  ) {
    super(message);
    this.name = "ModelRuntimeError";
  }
}

export type OpenAiCodexOAuthCredential = {
  access: string;
  refresh: string;
  expires: number;
  email: string | null;
  profileName: string | null;
};

export type ModelCredentialState = {
  schemaVersion: number;
  projectRoot: string;
  runtimeDirectory: string;
  createdAt: string;
  updatedAt: string;
  openai: {
    apiKey: string | null;
  };
  openaiCodex: OpenAiCodexOAuthCredential | null;
};

export type OpenAiCodexDeviceCodePrompt = {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
};

type ResponseToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

type ModelCallOptions = {
  operation: string;
  timeoutMs: number;
};

type ResponseTextContent = {
  type?: unknown;
  text?: unknown;
};

type ResponseOutputItem = {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  name?: unknown;
  arguments?: unknown;
};

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readRawString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeTokenLifetimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10) * 1000;
  }

  return undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];

  if (segment === undefined || segment.length === 0) {
    return null;
  }

  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveAccessTokenExpiry(token: string): number | null {
  const payload = decodeJwtPayload(token);
  const exp = readNumber(payload?.exp);
  return exp === null ? null : exp * 1000;
}

function resolveCodexIdentity(accessToken: string, fallbackEmail: string | null = null): {
  email: string | null;
  profileName: string | null;
} {
  const payload = decodeJwtPayload(accessToken);
  const profile = asObject(payload?.["https://api.openai.com/profile"]);
  const email = readString(profile.email) ?? fallbackEmail;
  const profileName = readString(profile.name) ?? email;
  return { email, profileName };
}

function sanitizeErrorText(value: string): string {
  return value
    .replace(/\u001b\[[\u0020-\u003f]*[\u0040-\u007e]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatHttpError(prefix: string, status: number, bodyText: string): string {
  const body = parseJsonObject(bodyText);
  const error = readString(body?.error);
  const description = readString(body?.error_description) ?? readString(asObject(body?.error).message);
  const safeError = error === null ? null : sanitizeErrorText(error);
  const safeDescription = description === null ? null : sanitizeErrorText(description);

  if (safeError !== null && safeDescription !== null) {
    return `${prefix}: ${safeError} (${safeDescription})`;
  }

  if (safeError !== null) {
    return `${prefix}: ${safeError}`;
  }

  const safeBody = sanitizeErrorText(bodyText);
  return safeBody.length === 0
    ? `${prefix}: HTTP ${status}`
    : `${prefix}: HTTP ${status} ${safeBody}`;
}

function modelCredentialStoreEmpty(projectRoot: string, timestamp: string): ModelCredentialState {
  return {
    schemaVersion: modelCredentialSchemaVersion,
    projectRoot,
    runtimeDirectory: runtimeDirectoryPath(projectRoot),
    createdAt: timestamp,
    updatedAt: timestamp,
    openai: {
      apiKey: null
    },
    openaiCodex: null
  };
}

function normalizeOpenAiCodexCredential(raw: unknown): OpenAiCodexOAuthCredential | null {
  const record = asObject(raw);
  const access = readString(record.access);
  const refresh = readString(record.refresh);
  const expires = readNumber(record.expires);

  if (access === null || refresh === null || expires === null) {
    return null;
  }

  return {
    access,
    refresh,
    expires,
    email: readString(record.email),
    profileName: readString(record.profileName)
  };
}

function normalizeModelCredentialState(
  raw: unknown,
  projectRoot: string,
  timestamp: string
): ModelCredentialState {
  const record = asObject(raw);
  const base = modelCredentialStoreEmpty(projectRoot, timestamp);
  const openai = asObject(record.openai);

  return {
    ...base,
    createdAt: readString(record.createdAt) ?? base.createdAt,
    updatedAt: readString(record.updatedAt) ?? base.updatedAt,
    openai: {
      apiKey: readString(openai.apiKey)
    },
    openaiCodex: normalizeOpenAiCodexCredential(record.openaiCodex)
  };
}

export function modelCredentialStorePath(projectRoot: string): string {
  return path.join(runtimeDirectoryPath(projectRoot), modelCredentialFileName);
}

export class ModelCredentialStore {
  constructor(
    public readonly projectRoot: string,
    private readonly timestampFactory: () => string = () => new Date().toISOString()
  ) {}

  get filePath(): string {
    return modelCredentialStorePath(this.projectRoot);
  }

  async load(): Promise<ModelCredentialState> {
    const timestamp = this.timestampFactory();

    try {
      const rawContents = await readFile(this.filePath, "utf8");
      return normalizeModelCredentialState(JSON.parse(rawContents) as unknown, this.projectRoot, timestamp);
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

      if (!missing) {
        throw error;
      }

      return modelCredentialStoreEmpty(this.projectRoot, timestamp);
    }
  }

  async save(state: ModelCredentialState): Promise<ModelCredentialState> {
    const timestamp = this.timestampFactory();
    const normalized = normalizeModelCredentialState(state, this.projectRoot, timestamp);
    normalized.updatedAt = timestamp;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    return normalized;
  }
}

export function setOpenAiApiKeyCredential(state: ModelCredentialState, apiKey: string | null): void {
  state.openai.apiKey = apiKey === null || apiKey.trim().length === 0
    ? null
    : apiKey.trim();
}

export function setOpenAiCodexCredential(
  state: ModelCredentialState,
  credential: OpenAiCodexOAuthCredential | null
): void {
  state.openaiCodex = credential;
}

function resolveNextPollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  return Math.min(Math.max(intervalMs, openAiCodexDeviceCodeMinIntervalMs), remainingMs);
}

async function requestOpenAiCodexDeviceCode(fetchFn: typeof fetch): Promise<{
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
}> {
  const response = await fetchFn(`${openAiCodexAuthBaseUrl}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      client_id: openAiCodexClientId
    })
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new ModelRuntimeError(
      "auth",
      "codex_login",
      formatHttpError("OpenAI Codex device-code request failed", response.status, bodyText)
    );
  }

  const body = parseJsonObject(bodyText);
  const deviceAuthId = readString(body?.device_auth_id);
  const userCode = readString(body?.user_code) ?? readString(body?.usercode);
  const intervalSeconds = readNumber(body?.interval);

  if (deviceAuthId === null || userCode === null) {
    throw new ModelRuntimeError("auth", "codex_login", "OpenAI Codex device-code response was missing the device code or user code.");
  }

  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${openAiCodexAuthBaseUrl}/codex/device`,
    intervalMs: intervalSeconds === null ? openAiCodexDeviceCodeDefaultIntervalMs : Math.max(1, intervalSeconds) * 1000
  };
}

async function pollOpenAiCodexDeviceCode(params: {
  fetchFn: typeof fetch;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}): Promise<{
  authorizationCode: string;
  codeVerifier: string;
}> {
  const deadline = Date.now() + openAiCodexDeviceCodeTimeoutMs;

  while (Date.now() < deadline) {
    const response = await params.fetchFn(`${openAiCodexAuthBaseUrl}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        device_auth_id: params.deviceAuthId,
        user_code: params.userCode
      })
    });
    const bodyText = await response.text();

    if (response.ok) {
      const body = parseJsonObject(bodyText);
      const authorizationCode = readString(body?.authorization_code);
      const codeVerifier = readString(body?.code_verifier);

      if (authorizationCode === null || codeVerifier === null) {
        throw new ModelRuntimeError("auth", "codex_login", "OpenAI Codex device authorization response was missing the exchange code.");
      }

      return { authorizationCode, codeVerifier };
    }

    if (response.status === 403 || response.status === 404) {
      await new Promise((resolve) =>
        setTimeout(resolve, resolveNextPollDelayMs(params.intervalMs, deadline))
      );
      continue;
    }

    throw new ModelRuntimeError(
      "auth",
      "codex_login",
      formatHttpError("OpenAI Codex device authorization failed", response.status, bodyText)
    );
  }

  throw new ModelRuntimeError("timeout", "codex_login", "OpenAI Codex device authorization timed out after 15 minutes.", openAiCodexDeviceCodeTimeoutMs);
}

async function exchangeOpenAiCodexDeviceCode(params: {
  fetchFn: typeof fetch;
  authorizationCode: string;
  codeVerifier: string;
}): Promise<OpenAiCodexOAuthCredential> {
  const response = await params.fetchFn(`${openAiCodexAuthBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: openAiCodexDeviceCallbackUrl,
      client_id: openAiCodexClientId,
      code_verifier: params.codeVerifier
    })
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new ModelRuntimeError(
      "auth",
      "codex_login",
      formatHttpError("OpenAI Codex token exchange failed", response.status, bodyText)
    );
  }

  const body = parseJsonObject(bodyText);
  const access = readString(body?.access_token);
  const refresh = readString(body?.refresh_token);

  if (access === null || refresh === null) {
    throw new ModelRuntimeError("auth", "codex_login", "OpenAI Codex token exchange succeeded but did not return OAuth tokens.");
  }

  const expiresInMs = normalizeTokenLifetimeMs(body?.expires_in);
  const expires = expiresInMs === undefined
    ? (resolveAccessTokenExpiry(access) ?? Date.now())
    : Date.now() + expiresInMs;
  const identity = resolveCodexIdentity(access);

  return {
    access,
    refresh,
    expires,
    email: identity.email,
    profileName: identity.profileName
  };
}

export async function loginOpenAiCodexDeviceCode(params: {
  fetchFn?: typeof fetch;
  onVerification: (prompt: OpenAiCodexDeviceCodePrompt) => Promise<void> | void;
  onProgress?: (message: string) => void;
}): Promise<OpenAiCodexOAuthCredential> {
  const fetchFn = params.fetchFn ?? fetch;
  params.onProgress?.("Requesting OpenAI Codex device code...");
  const deviceCode = await requestOpenAiCodexDeviceCode(fetchFn);
  await params.onVerification({
    verificationUrl: deviceCode.verificationUrl,
    userCode: deviceCode.userCode,
    expiresInMs: openAiCodexDeviceCodeTimeoutMs
  });
  params.onProgress?.("Waiting for OpenAI Codex authorization...");
  const authorization = await pollOpenAiCodexDeviceCode({
    fetchFn,
    deviceAuthId: deviceCode.deviceAuthId,
    userCode: deviceCode.userCode,
    intervalMs: deviceCode.intervalMs
  });
  params.onProgress?.("Exchanging OpenAI Codex device code...");
  return exchangeOpenAiCodexDeviceCode({
    fetchFn,
    authorizationCode: authorization.authorizationCode,
    codeVerifier: authorization.codeVerifier
  });
}

async function refreshOpenAiCodexCredential(refreshToken: string): Promise<OpenAiCodexOAuthCredential> {
  const response = await fetch(`${openAiCodexAuthBaseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: openAiCodexClientId
    })
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new ModelRuntimeError(
      "auth",
      "openai-codex",
      formatHttpError("OpenAI Codex token refresh failed", response.status, bodyText)
    );
  }

  const body = parseJsonObject(bodyText);
  const access = readString(body?.access_token);
  const refresh = readString(body?.refresh_token) ?? refreshToken;

  if (access === null) {
    throw new ModelRuntimeError("auth", "openai-codex", "OpenAI Codex token refresh succeeded but did not return an access token.");
  }

  const expiresInMs = normalizeTokenLifetimeMs(body?.expires_in);
  const expires = expiresInMs === undefined
    ? (resolveAccessTokenExpiry(access) ?? Date.now())
    : Date.now() + expiresInMs;
  const identity = resolveCodexIdentity(access);

  return {
    access,
    refresh,
    expires,
    email: identity.email,
    profileName: identity.profileName
  };
}

function extractJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");

    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model did not return JSON.");
    }

    return JSON.parse(text.slice(start, end + 1));
  }
}

function normalizeBaseUrl(baseUrl: string | null, provider: RuntimeModelProvider): string {
  const fallback = provider === "openai-codex"
    ? "https://chatgpt.com/backend-api/codex"
    : "https://api.openai.com/v1";
  return (baseUrl ?? fallback).replace(/\/responses\/?$/i, "").replace(/\/$/, "");
}

function modelResponseUrl(config: ResolvedRuntimeModelConfig): string {
  return `${normalizeBaseUrl(config.baseUrl, config.provider)}/responses`;
}

function responseText(payload: unknown): string | null {
  const record = asObject(payload);
  const outputText = readString(record.output_text);

  if (outputText !== null) {
    return outputText;
  }

  const output = Array.isArray(record.output) ? record.output as ResponseOutputItem[] : [];
  const parts: string[] = [];

  for (const item of output) {
    if (item.type !== "message" && item.role !== "assistant") {
      continue;
    }

    const content = Array.isArray(item.content) ? item.content as ResponseTextContent[] : [];

    for (const entry of content) {
      if ((entry.type === "output_text" || entry.type === "text") && typeof entry.text === "string") {
        parts.push(entry.text);
      }
    }
  }

  return parts.length === 0 ? null : parts.join("");
}

function responseFunctionArguments(payload: unknown, toolName: string): unknown | null {
  const record = asObject(payload);
  const output = Array.isArray(record.output) ? record.output as ResponseOutputItem[] : [];

  for (const item of output) {
    if (item.type !== "function_call" || item.name !== toolName) {
      continue;
    }

    const args = item.arguments;

    if (typeof args === "string") {
      return extractJson(args);
    }

    return args;
  }

  return null;
}

function parseResponsesEventStream(text: string): unknown {
  const outputTextParts: string[] = [];
  const functionCalls = new Map<number | string, {
    name: string | null;
    arguments: string;
  }>();
  let completedResponse: unknown | null = null;

  for (const block of text.split(/\n\n+/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());

    if (dataLines.length === 0) {
      continue;
    }

    const data = dataLines.join("\n");

    if (data === "[DONE]") {
      continue;
    }

    let event: Record<string, unknown>;

    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (event.type === "response.output_text.delta") {
      const delta = readRawString(event.delta);

      if (delta !== null) {
        outputTextParts.push(delta);
      }
      continue;
    }

    if (event.type === "response.output_text.done") {
      const doneText = readRawString(event.text);

      if (doneText !== null && outputTextParts.length === 0) {
        outputTextParts.push(doneText);
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.delta") {
      const key = readNumber(event.output_index) ?? readString(event.item_id) ?? 0;
      const current = functionCalls.get(key) ?? { name: null, arguments: "" };
      const delta = readRawString(event.delta);

      if (delta !== null) {
        current.arguments += delta;
        functionCalls.set(key, current);
      }
      continue;
    }

    if (event.type === "response.function_call_arguments.done") {
      const key = readNumber(event.output_index) ?? readString(event.item_id) ?? 0;
      const current = functionCalls.get(key) ?? { name: null, arguments: "" };
      current.arguments = readRawString(event.arguments) ?? current.arguments;
      functionCalls.set(key, current);
      continue;
    }

    if (event.type === "response.output_item.done") {
      const item = asObject(event.item);

      if (item.type === "function_call") {
        const key = readNumber(event.output_index) ?? readString(item.id) ?? functionCalls.size;
        const current = functionCalls.get(key) ?? { name: null, arguments: "" };
        current.name = readString(item.name) ?? current.name;
        current.arguments = readRawString(item.arguments) ?? current.arguments;
        functionCalls.set(key, current);
      }
      continue;
    }

    if (event.type === "response.completed") {
      completedResponse = event.response;
      continue;
    }

    if (event.type === "response.failed") {
      const response = asObject(event.response);
      const error = asObject(response.error);
      const message = readString(error.message) ?? "Streaming response failed.";
      throw new Error(message);
    }
  }

  if (completedResponse !== null) {
    const completed = asObject(completedResponse);
    const text = responseText(completed);

    if (text !== null && outputTextParts.length === 0) {
      outputTextParts.push(text);
    }
  }

  return {
    output_text: outputTextParts.join(""),
    output: [...functionCalls.values()].flatMap((call) =>
      call.name === null
        ? []
        : [{
          type: "function_call",
          name: call.name,
          arguments: call.arguments
        }]
    )
  };
}

async function postResponseJson(
  config: ResolvedRuntimeModelConfig,
  token: string,
  body: Record<string, unknown>,
  options: ModelCallOptions
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(modelResponseUrl(config), {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const bodyText = await response.text();

    if (!response.ok) {
      throw new ModelRuntimeError(
        response.status === 401 || response.status === 403 ? "auth" : "http",
        options.operation,
        formatHttpError(`${config.provider} ${options.operation} request failed`, response.status, bodyText),
        options.timeoutMs
      );
    }

    try {
      const contentType = response.headers.get("content-type") ?? "";

      if (/text\/event-stream/i.test(contentType) || /^\s*(?:event:|data:)/m.test(bodyText)) {
        return parseResponsesEventStream(bodyText);
      }

      return JSON.parse(bodyText) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelRuntimeError(
        "malformed_json",
        options.operation,
        `${config.provider} ${options.operation} HTTP response was not valid JSON: ${message}`,
        options.timeoutMs
      );
    }
  } catch (error) {
    if (error instanceof ModelRuntimeError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";

    if (controller.signal.aborted || /abort|timeout/i.test(`${name} ${message}`)) {
      throw new ModelRuntimeError(
        "timeout",
        options.operation,
        `${options.operation} model call exceeded ${options.timeoutMs} ms`,
        options.timeoutMs
      );
    }

    throw new ModelRuntimeError(
      "unexpected",
      options.operation,
      `${options.operation} model call failed: ${message}`,
      options.timeoutMs
    );
  } finally {
    clearTimeout(timer);
  }
}

function openAiJsonPayload(config: ResolvedRuntimeModelConfig, systemPrompt: string): Record<string, unknown> {
  return {
    model: config.model,
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Return the requested JSON object now."
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_object"
      }
    },
    ...(config.provider === "openai-codex" ? { stream: true } : {}),
    store: false
  };
}

function openAiToolPayload(
  config: ResolvedRuntimeModelConfig,
  systemPrompt: string,
  tool: ResponseToolDefinition
): Record<string, unknown> {
  return {
    model: config.model,
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Call ${tool.name} exactly once with the chosen arguments.`
          }
        ]
      }
    ],
    tools: [
      {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true
      }
    ],
    tool_choice: {
      type: "function",
      name: tool.name
    },
    ...(config.provider === "openai-codex" ? { stream: true } : {}),
    store: false
  };
}

export class RuntimeModelClient {
  constructor(
    private readonly config: ResolvedRuntimeModelConfig,
    private readonly credentials: ModelCredentialState,
    private readonly credentialStore: ModelCredentialStore | null = null
  ) {}

  get label(): string {
    return this.config.label;
  }

  get provider(): RuntimeModelProvider {
    return this.config.provider;
  }

  get supportsNativeToolCalls(): boolean {
    return this.config.provider === "openai" || this.config.provider === "openai-codex";
  }

  private async resolveToken(options: ModelCallOptions): Promise<string> {
    if (this.config.provider === "openai") {
      const token = readString(process.env.OPENAI_API_KEY) ?? this.credentials.openai.apiKey;

      if (token === null) {
        throw new ModelRuntimeError(
          "auth",
          options.operation,
          "OpenAI API key is not configured. Run model setup or set OPENAI_API_KEY.",
          options.timeoutMs
        );
      }

      return token;
    }

    if (this.config.provider === "openai-codex") {
      const credential = this.credentials.openaiCodex;

      if (credential === null) {
        throw new ModelRuntimeError(
          "auth",
          options.operation,
          "OpenAI Codex sign-in is not configured. Run model setup and choose OpenAI Codex sign-in.",
          options.timeoutMs
        );
      }

      if (credential.expires > Date.now() + 60_000) {
        return credential.access;
      }

      const refreshed = await refreshOpenAiCodexCredential(credential.refresh);
      this.credentials.openaiCodex = refreshed;
      if (this.credentialStore !== null) {
        await this.credentialStore.save(this.credentials);
      }
      return refreshed.access;
    }

    throw new ModelRuntimeError(
      "unexpected",
      options.operation,
      "Ollama calls are handled by the Ollama runtime backend.",
      options.timeoutMs
    );
  }

  async jsonCall(systemPrompt: string, options: ModelCallOptions): Promise<unknown> {
    const token = await this.resolveToken(options);
    const response = await postResponseJson(
      this.config,
      token,
      openAiJsonPayload(this.config, systemPrompt),
      options
    );
    const text = responseText(response);

    if (text === null) {
      throw new ModelRuntimeError(
        "unexpected",
        options.operation,
        `${this.config.provider} ${options.operation} response did not contain text output.`,
        options.timeoutMs
      );
    }

    try {
      return extractJson(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelRuntimeError(
        "malformed_json",
        options.operation,
        `${this.config.provider} ${options.operation} response was not valid JSON: ${message}`,
        options.timeoutMs
      );
    }
  }

  async toolCall(systemPrompt: string, tool: ResponseToolDefinition, options: ModelCallOptions): Promise<unknown> {
    const token = await this.resolveToken(options);
    const response = await postResponseJson(
      this.config,
      token,
      openAiToolPayload(this.config, systemPrompt, tool),
      options
    );

    try {
      return responseFunctionArguments(response, tool.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelRuntimeError(
        "malformed_json",
        options.operation,
        `${this.config.provider} ${options.operation} tool-call arguments were not valid JSON: ${message}`,
        options.timeoutMs
      );
    }
  }
}
