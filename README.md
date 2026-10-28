# Free AI Image Generation API

A small, dependency-free Cloudflare Worker that turns [Workers AI](https://developers.cloudflare.com/workers-ai/) text-to-image models into a key-protected REST API. Send a prompt, get image bytes back.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://developers.cloudflare.com/workers/)
[![Workers AI](https://img.shields.io/badge/Workers%20AI-image%20models-purple.svg)](https://developers.cloudflare.com/workers-ai/models/)

---

## What changed in v2

The previous version of this repo did not work as documented. It has been rewritten:

| Before | After |
| --- | --- |
| No CORS headers, `OPTIONS` returned `405` — browser clients could never call it | Preflight handled, configurable `ALLOWED_ORIGINS` |
| Assumed every model returns raw bytes, so FLUX produced corrupt images | Handles both binary streams and base64 payloads, sniffs the real MIME type |
| `@cf/blackforestlabs/ux-1-schnell` (does not exist) | Verified model IDs, all current text-to-image models |
| `Bearer undefined` authenticated when `API_KEY` was unset | Fails closed with `500` when the secret is missing |
| API key compared with `!==` | Constant-time comparison |
| Completeness claims of "100,000 calls/day" | Documented reality: 10,000 Neurons/day on the free tier |
| Single hardcoded model | Model registry with per-model parameter validation and clamping |
| No config files | `wrangler.toml`, `package.json`, `LICENSE`, `.gitignore` |

---

## Quick start

```bash
npm install

# Set the API key used by every request
npx wrangler secret put API_KEY

# Deploy
npx wrangler deploy
```

The deployed worker is available at `https://free-image-generation-api.<your-subdomain>.workers.dev`. The `AI` binding is already declared in `wrangler.toml`.

### Deploy from the dashboard instead

1. **Workers & Pages → Create → Worker** and deploy the hello-world template.
2. **Edit code** and paste `worker.js`.
3. **Settings → Variables → Add variable**: `API_KEY` = a long random string (use **Encrypt**).
4. **Settings → Bindings → Add → Workers AI**: variable name `AI`.
5. **Save and deploy**.

---

## Configuration

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `API_KEY` | yes | — | Bearer token required on every generation request. Store it as a secret, not a plain variable. |
| `AI` | yes | — | Workers AI binding, declared in `wrangler.toml`. |
| `ALLOWED_ORIGINS` | no | `*` | Comma-separated list of browser origins allowed to call the API. Set this in production. |
| `DEBUG` | no | `false` | When `"true"`, responses include upstream error text. Disable it afterwards — it can leak provider details. |

---

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/` | no | Usage metadata and a request example. |
| `GET` | `/health` | no | Liveness probe: `{"ok":true}`. |
| `GET` | `/models` | no | Model catalog with limits and identifiers. |
| `POST` | `/` or `/generate` | yes | Generates an image, returns binary bytes. |
| `POST` | `/?format=json` | yes | Generates an image, returns a base64 data URI. |
| `OPTIONS` | any | no | CORS preflight. |

Successful binary responses include `X-Model`, `X-Elapsed-Ms`, a sniffed `Content-Type`, and `Content-Disposition` so a browser can save the file directly.

### Request body

| Field | Type | Notes |
| --- | --- | --- |
| `prompt` | string | Required. Trimmed, max 2048 characters. |
| `model` | string | Model key, alias, or full `@cf/...` ID. Defaults to `flux-1-schnell`. |
| `steps` / `num_steps` | integer | Diffusion steps. Clamped to the model's range. |
| `seed` | integer | Reproducibility. |
| `width` / `height` | integer | Pixels. Clamped to the model's range. |
| `negative_prompt` | string | Only on models that support it (ignored elsewhere). |
| `guidance` | number | Only on models that support it. |
| `format` | string | `"json"` returns a data URI instead of bytes. |

Unknown fields are ignored rather than forwarded, so a typo cannot reach the model. Out-of-range numbers are clamped, not rejected.

### Models

| Key | Model ID | Output | Free tier |
| --- | --- | --- | --- |
| `flux-1-schnell` *(default)* | `@cf/black-forest-labs/flux-1-schnell` | JPEG | yes, fastest and cheapest |
| `sdxl` | `@cf/stabilityai/stable-diffusion-xl-base-1.0` | PNG | listed at $0.00/step |
| `sdxl-lightning` | `@cf/bytedance/stable-diffusion-xl-lightning` | PNG | listed at $0.00/step |
| `dreamshaper-8-lcm` | `@cf/lykon/dreamshaper-8-lcm` | PNG | listed at $0.00/step |
| `lucid-origin` | `@cf/leonardo/lucid-origin` | JPEG | **no**, partner model, ~636 Neurons per 512×512 tile |

Aliases: `flux`, `schnell`, `sd-xl`, `stable-diffusion-xl`, `lightning`, `dreamshaper`, `leonardo`, `lucid`.

`flux-2-dev` and `flux-2-klein-*` are intentionally absent: they take `multipart` input with reference images, so they do not fit a JSON prompt-only API.

---

## Usage

### cURL, binary output

```bash
curl -X POST https://free-image-generation-api.<subdomain>.workers.dev \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a lighthouse at dusk, long exposure","model":"flux-1-schnell"}' \
  --output image.jpg
```

### cURL, JSON output

```bash
curl -X POST "https://free-image-generation-api.<subdomain>.workers.dev/?format=json" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a red fox in snow","steps":4}'
```

```json
{
  "model": "flux-1-schnell",
  "id": "@cf/black-forest-labs/flux-1-schnell",
  "mimeType": "image/jpeg",
  "seed": null,
  "elapsedMs": 1840,
  "image": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

### JavaScript

```js
const res = await fetch("https://free-image-generation-api.<subdomain>.workers.dev/", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ prompt: "a futuristic city in the clouds", model: "sdxl" }),
});

if (!res.ok) throw new Error((await res.json()).error);

const url = URL.createObjectURL(await res.blob());
document.querySelector("img").src = url;
```

### Python

```python
import requests

res = requests.post(
    "https://free-image-generation-api.<subdomain>.workers.dev/",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={"prompt": "a paper crane on a windowsill", "model": "flux-1-schnell"},
    timeout=120,
)
res.raise_for_status()
open("image.jpg", "wb").write(res.content)
```

### Demo page

`frontend_demo.html` is a self-contained client: Worker URL, API key, model picker, and a gallery. Open it from disk or any static host, then point it at your worker. Append `?api=https://your-worker.workers.dev` to prefill the URL.

---

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Bad JSON, missing `prompt`, prompt too long, or unknown model. |
| `401` | Missing or wrong bearer token. |
| `405` | Method or path not allowed. |
| `413` | Request body over 16 KB. |
| `429` | Daily Workers AI quota exhausted. |
| `500` | Worker misconfigured (`API_KEY` or `AI` binding missing) or generation failed. |
| `502` | Workers AI rejected the request or returned an unusable payload. |
| `504` | Model timed out. Lower `steps` or `width`/`height`. |

Error bodies are `{"error": "..."}`. Set `DEBUG=true` to add an upstream `details` field while troubleshooting.

---

## Free tier reality check

The old README promised "100,000 API calls per day". That is not how Workers AI bills anymore.

- Free allocation is **10,000 Neurons per day**, resetting at **00:00 UTC**. Beyond that you need the Workers Paid plan at **$0.011 per 1,000 Neurons**.
- Text-to-image models are rate limited to **720 requests per minute** per account.
- Cost depends on model, resolution, and steps. `flux-1-schnell` charges **4.80 Neurons per 512×512 tile** plus **9.60 Neurons per step**, so a 1024×1024 image at 4 steps is ~57.6 Neurons — roughly **170 images per day** on the free tier. Lucid Origin is ~2,592 Neurons for the same request, about **3 images per day**.

Check the live numbers before promising anyone a quota:

- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
- [Model catalog](https://developers.cloudflare.com/workers-ai/models/)

---

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # then edit API_KEY
npm run dev                      # http://localhost:8787
```

```bash
curl -X POST http://localhost:8787/ \
  -H "Authorization: Bearer change-me-to-a-long-random-string" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a test pattern"}' --output out.jpg
npm run tail    # stream production logs
```

---

## Security notes

- The API key is a **single shared secret**. Anyone holding it can spend your quota. Rotate with `wrangler secret put API_KEY`.
- There is **no per-client rate limiting** in this worker. If you expose it publicly, put Cloudflare rate limiting rules or a gateway in front of it.
- `ALLOWED_ORIGINS` controls browsers only. CORS is not authentication — non-browser clients ignore it. The bearer token is the actual gate.
- Generated content comes from third-party models. Review the model license before commercial use.

---

## License

MIT — see [LICENSE](LICENSE).
