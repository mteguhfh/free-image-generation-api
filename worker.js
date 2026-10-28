/**
 * Free AI Image Generation API
 *
 * A dependency-free Cloudflare Worker that exposes Workers AI
 * text-to-image models through a key-protected REST API.
 *
 *   GET  /                 usage + metadata
 *   GET  /health           liveness probe
 *   GET  /models           model catalog
 *   POST /                 generate -> image bytes
 *   POST /?format=json     generate -> data URI in JSON
 */

const DEFAULT_MODEL = "flux-1-schnell";
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Model registry.
 *
 * encoding  "stream" -> env.AI.run returns a ReadableStream of image bytes
 *           "base64" -> env.AI.run returns { image: "<base64>" }
 * stepsKey  the parameter name the model uses for diffusion steps
 * params    optional inputs forwarded when present in the request body
 */
const MODELS = {
  "flux-1-schnell": {
    id: "@cf/black-forest-labs/flux-1-schnell",
    label: "FLUX.1 schnell",
    author: "Black Forest Labs",
    free: true,
    encoding: "base64",
    stepsKey: "steps",
    params: ["seed", "steps"],
    limits: { prompt: 2048, steps: [1, 8] },
  },
  sdxl: {
    id: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
    label: "Stable Diffusion XL Base 1.0",
    author: "Stability AI",
    free: true,
    encoding: "stream",
    stepsKey: "num_steps",
    params: ["negative_prompt", "width", "height", "num_steps", "guidance", "seed"],
    limits: { prompt: 2048, size: [256, 2048], steps: [1, 20], guidance: [0, 20] },
  },
  "sdxl-lightning": {
    id: "@cf/bytedance/stable-diffusion-xl-lightning",
    label: "SDXL Lightning",
    author: "ByteDance",
    free: true,
    encoding: "stream",
    stepsKey: "num_steps",
    params: ["negative_prompt", "width", "height", "num_steps", "guidance", "seed"],
    limits: { prompt: 2048, size: [256, 2048], steps: [1, 20], guidance: [0, 20] },
  },
  "dreamshaper-8-lcm": {
    id: "@cf/lykon/dreamshaper-8-lcm",
    label: "Dreamshaper 8 LCM",
    author: "Lykon",
    free: true,
    encoding: "stream",
    stepsKey: "num_steps",
    params: ["negative_prompt", "width", "height", "num_steps", "guidance", "seed"],
    limits: { prompt: 2048, size: [256, 2048], steps: [1, 20], guidance: [0, 20] },
  },
  "lucid-origin": {
    id: "@cf/leonardo/lucid-origin",
    label: "Lucid Origin",
    author: "Leonardo.AI",
    free: false,
    encoding: "base64",
    stepsKey: "num_steps",
    params: ["width", "height", "num_steps", "guidance", "seed"],
    limits: { prompt: 2048, size: [256, 2500], steps: [1, 40], guidance: [0, 10] },
  },
};

const ALIASES = {
  flux: "flux-1-schnell",
  schnell: "flux-1-schnell",
  "flux-1": "flux-1-schnell",
  "stable-diffusion": "sdxl",
  "stable-diffusion-xl": "sdxl",
  "sd-xl": "sdxl",
  lightning: "sdxl-lightning",
  dreamshaper: "dreamshaper-8-lcm",
  leonardo: "lucid-origin",
  lucid: "lucid-origin",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/health") return json({ ok: true, models: Object.keys(MODELS).length }, 200, cors);
      if (url.pathname === "/models") return json(modelCatalog(), 200, cors);
      if (url.pathname === "/") return json(usage(env), 200, cors);
      return json({ error: "Not found" }, 404, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { ...cors, Allow: "GET, POST, OPTIONS" });
    }

    if (url.pathname !== "/" && url.pathname !== "/generate") {
      return json({ error: "Not found" }, 404, cors);
    }

    return generate(request, env, url, cors);
  },
};

async function generate(request, env, url, cors) {
  if (!env.API_KEY) {
    return json({ error: "Server is not configured: API_KEY secret is missing" }, 500, cors);
  }

  if (!constantTimeEqual(authToken(request), env.API_KEY)) {
    return json({ error: "Unauthorized" }, 401, { ...cors, "WWW-Authenticate": 'Bearer realm="image-api"' });
  }

  if (!env.AI) {
    return json({ error: "Server is not configured: AI binding is missing" }, 500, cors);
  }

  if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) {
    return json({ error: "Request body is too large" }, 413, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON, for example {"prompt": "a red fox"}' }, 400, cors);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Request body must be a JSON object" }, 400, cors);
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) return json({ error: '"prompt" is required' }, 400, cors);

  const modelKey = resolveModel(body.model);
  if (!modelKey) {
    return json(
      { error: `Unknown model: ${String(body.model)}`, available: Object.keys(MODELS) },
      400,
      cors
    );
  }
  const model = MODELS[modelKey];

  if (prompt.length > model.limits.prompt) {
    return json({ error: `"prompt" must be ${model.limits.prompt} characters or fewer` }, 400, cors);
  }

  const input = buildInput(model, prompt, body);
  const started = Date.now();

  let result;
  try {
    result = await env.AI.run(model.id, input);
  } catch (err) {
    return upstreamError(err, env, cors);
  }

  let bytes;
  try {
    bytes = await toBytes(result);
  } catch (err) {
    return json({ error: "Model returned an unexpected payload", ...(debug(env, err)) }, 502, cors);
  }

  if (!bytes.length) {
    return json({ error: "Model returned an empty image" }, 502, cors);
  }

  const mimeType = sniffMime(bytes);
  const elapsedMs = Date.now() - started;
  const wantsJson = url.searchParams.get("format") === "json" || body.format === "json";

  if (wantsJson) {
    return json(
      {
        model: modelKey,
        id: model.id,
        mimeType,
        seed: input.seed ?? null,
        elapsedMs,
        image: `data:${mimeType};base64,${toBase64(bytes)}`,
      },
      200,
      { ...cors, "Cache-Control": "no-store" }
    );
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": mimeType,
      "Content-Length": String(bytes.length),
      "Content-Disposition": `inline; filename="image-${started}.${extension(mimeType)}"`,
      "Cache-Control": "no-store",
      "X-Model": modelKey,
      "X-Elapsed-Ms": String(elapsedMs),
    },
  });
}

function buildInput(model, prompt, body) {
  const input = { prompt };

  if (model.params.includes("negative_prompt") && typeof body.negative_prompt === "string") {
    const negative = body.negative_prompt.trim();
    if (negative) input.negative_prompt = negative;
  }

  if (model.params.includes("width")) {
    const width = clampInt(body.width, model.limits.size);
    if (width !== undefined) input.width = width;
  }

  if (model.params.includes("height")) {
    const height = clampInt(body.height, model.limits.size);
    if (height !== undefined) input.height = height;
  }

  if (model.params.includes("guidance")) {
    const guidance = clampNumber(body.guidance, model.limits.guidance);
    if (guidance !== undefined) input.guidance = guidance;
  }

  const steps = clampInt(body.steps ?? body.num_steps, model.limits.steps);
  if (steps !== undefined) input[model.stepsKey] = steps;

  if (model.params.includes("seed")) {
    const seed = clampInt(body.seed, [0, 2147483647]);
    if (seed !== undefined) input.seed = seed;
  }

  return input;
}

function clampInt(value, [min, max]) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function clampNumber(value, [min, max]) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

async function toBytes(result) {
  if (result instanceof ReadableStream) {
    return new Uint8Array(await new Response(result).arrayBuffer());
  }
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  if (ArrayBuffer.isView(result)) return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  if (result && typeof result.image === "string") return fromBase64(result.image);
  if (result && Array.isArray(result.image)) return new Uint8Array(result.image);
  throw new Error("Unsupported model output");
}

function resolveModel(name) {
  if (name === undefined || name === null || name === "") return DEFAULT_MODEL;
  const raw = String(name).trim();
  if (MODELS[raw]) return raw;

  const lower = raw.toLowerCase();
  if (MODELS[lower]) return lower;
  if (ALIASES[lower]) return ALIASES[lower];

  for (const [key, model] of Object.entries(MODELS)) {
    if (model.id.toLowerCase() === lower) return key;
  }
  return null;
}

function authToken(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();
  return (request.headers.get("X-API-Key") || "").trim();
}

function constantTimeEqual(a, b) {
  const left = new TextEncoder().encode(String(a ?? ""));
  const right = new TextEncoder().encode(String(b ?? ""));
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function corsHeaders(request, env) {
  const configured = String(env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.get("Origin");

  let allowOrigin = "*";
  if (!configured.includes("*")) {
    allowOrigin = origin && configured.includes(origin) ? origin : configured[0];
  }

  const headers = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-API-Key",
    "Access-Control-Max-Age": "86400",
  };
  if (allowOrigin !== "*") headers["Vary"] = "Origin";
  return headers;
}

function upstreamError(err, env, cors) {
  const message = String(err?.message || err || "");
  const extra = debug(env, err);

  if (/neuron|daily free|allocation|quota|exceeded/i.test(message)) {
    return json(
      {
        error: "Daily Workers AI quota reached",
        hint: "The free tier allows 10,000 Neurons per day and resets at 00:00 UTC. Upgrade to Workers Paid for more.",
        ...extra,
      },
      429,
      cors
    );
  }
  if (/401|unauthorized|authentication|api token/i.test(message)) {
    return json({ error: "Workers AI rejected the request", ...extra }, 502, cors);
  }
  if (/not found|no such model|deprecated|404/i.test(message)) {
    return json({ error: "Model is unavailable in this account or region", ...extra }, 502, cors);
  }
  if (/timeout|timed out|1102|524/i.test(message)) {
    return json({ error: "Model timed out; try fewer steps or a smaller size", ...extra }, 504, cors);
  }
  return json({ error: "Image generation failed", ...extra }, 500, cors);
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function debug(env, err) {
  return env.DEBUG === "true" ? { details: String(err?.message || err) } : {};
}

function sniffMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return "image/png";
}

function extension(mimeType) {
  return { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mimeType] || "png";
}

function fromBase64(value) {
  const comma = value.indexOf(",");
  const payload = comma === -1 ? value : value.slice(comma + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes) {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function modelCatalog() {
  return {
    default: DEFAULT_MODEL,
    models: Object.entries(MODELS).map(([key, model]) => ({
      key,
      id: model.id,
      label: model.label,
      author: model.author,
      free: model.free,
      stepsParam: model.stepsKey,
      limits: model.limits,
    })),
  };
}

function usage(env) {
  return {
    name: "free-image-generation-api",
    version: "2.0.0",
    defaultModel: DEFAULT_MODEL,
    endpoints: {
      "GET /": "this document",
      "GET /health": "liveness probe",
      "GET /models": "model catalog",
      "POST /": "generate an image, returns image bytes",
      "POST /?format=json": "generate an image, returns a base64 data URI",
    },
    example: {
      method: "POST",
      headers: { Authorization: "Bearer <API_KEY>", "Content-Type": "application/json" },
      body: { prompt: "a lighthouse at dusk, long exposure", model: "flux-1-schnell", steps: 4 },
    },
    allowedOrigins: String(env.ALLOWED_ORIGINS || "*")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  };
}
