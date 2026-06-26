/**
 * JOKER AI STUDIO - Worker
 * Secure proxy between the frontend and Pollinations AI.
 * The secret API key is stored ONLY as a Cloudflare secret (env.POLLINATIONS_API_KEY),
 * never written in this file or in any client-facing code.
 */

const ALLOWED_ORIGINS = [
  "https://dark-surf-15c1.ahmedllaya49.workers.dev",
  "http://localhost:8788",
];

const POLLINATIONS_BASE = "https://gen.pollinations.ai";

const VIDEO_MODEL_LIMITS = {
  "veo": { min: 4, max: 8, allowedValues: [4, 6, 8] },
  "seedance": { min: 2, max: 10 },
  "seedance-pro": { min: 2, max: 10 },
  "wan": { min: 2, max: 15 },
  "nova-reel": { min: 6, max: 120, step: 6 },
};

function clampDurationForModel(model, requested) {
  const limits = VIDEO_MODEL_LIMITS[model] || VIDEO_MODEL_LIMITS["wan"];
  if (limits.allowedValues) {
    return limits.allowedValues.reduce(function (closest, v) {
      return Math.abs(v - requested) < Math.abs(closest - requested) ? v : closest;
    });
  }
  let d = Math.min(limits.max, Math.max(limits.min, requested));
  if (limits.step) d = Math.round(d / limits.step) * limits.step;
  return d;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonError(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8" },
      corsHeaders(origin)
    ),
  });
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function safeText(response) {
  try {
    return await response.text();
  } catch (e) {
    return "";
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    if (!env.POLLINATIONS_API_KEY) {
      return jsonError(
        "Server not configured: missing POLLINATIONS_API_KEY secret.",
        500,
        origin
      );
    }

    // Route 1: Image generation
    // GET /generate/image?prompt=...&width=...&height=...
    if (url.pathname === "/generate/image" && request.method === "GET") {
      const prompt = url.searchParams.get("prompt");
      if (!prompt || prompt.trim().length === 0) {
        return jsonError("Missing required parameter: prompt", 400, origin);
      }

      const width = clampInt(url.searchParams.get("width"), 256, 1792, 1024);
      const height = clampInt(url.searchParams.get("height"), 256, 1792, 1024);
      const seed = url.searchParams.get("seed") || String(Math.floor(Math.random() * 1000000000));

      const upstreamUrl =
        POLLINATIONS_BASE + "/image/" + encodeURIComponent(prompt) +
        "?model=flux&width=" + width + "&height=" + height + "&seed=" + seed +
        "&nologo=true&safe=true";

      try {
        const upstream = await fetch(upstreamUrl, {
          headers: { Authorization: "Bearer " + env.POLLINATIONS_API_KEY },
        });

        if (!upstream.ok) {
          const text = await safeText(upstream);
          return jsonError(
            "Image generation failed (" + upstream.status + "): " + (text || "unknown error"),
            upstream.status,
            origin
          );
        }

        return new Response(upstream.body, {
          status: 200,
          headers: Object.assign(
            {
              "Content-Type": upstream.headers.get("Content-Type") || "image/jpeg",
              "Cache-Control": "no-store",
            },
            corsHeaders(origin)
          ),
        });
      } catch (err) {
        return jsonError("Error connecting to image service: " + err.message, 502, origin);
      }
    }

    // Route 2: Video generation
    // GET /generate/video?prompt=...&model=...&duration=...&ratio=...
    // Real Pollinations endpoint is GET /video/{prompt}, returns the video file directly.
    if (url.pathname === "/generate/video" && request.method === "GET") {
      const prompt = url.searchParams.get("prompt");
      if (!prompt || prompt.trim().length === 0) {
        return jsonError("Missing required parameter: prompt", 400, origin);
      }

      const requestedModel = url.searchParams.get("model");
      const model = VIDEO_MODEL_LIMITS[requestedModel] ? requestedModel : "wan";

      const requestedDuration = clampInt(url.searchParams.get("duration"), 1, 120, 10);
      const duration = clampDurationForModel(model, requestedDuration);

      const aspectRatio = (url.searchParams.get("ratio") === "9:16") ? "9:16" : "16:9";

      const upstreamUrl =
        POLLINATIONS_BASE + "/video/" + encodeURIComponent(prompt) +
        "?model=" + model + "&duration=" + duration + "&aspectRatio=" + aspectRatio +
        "&nologo=true&safe=true";

      try {
        const controller = new AbortController();
        const timeout = setTimeout(function () { controller.abort(); }, 4 * 60 * 1000);

        const upstream = await fetch(upstreamUrl, {
          headers: { Authorization: "Bearer " + env.POLLINATIONS_API_KEY },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!upstream.ok) {
          const text = await safeText(upstream);
          return jsonError(
            "Video generation failed (" + upstream.status + "): " +
              (text || "Pollen balance may be insufficient, or model unavailable"),
            upstream.status,
            origin
          );
        }

        return new Response(upstream.body, {
          status: 200,
          headers: Object.assign(
            {
              "Content-Type": upstream.headers.get("Content-Type") || "video/mp4",
              "Cache-Control": "no-store",
            },
            corsHeaders(origin)
          ),
        });
      } catch (err) {
        const message = (err.name === "AbortError")
          ? "Request timed out after 4 minutes. The service may be busy, try again shortly."
          : "Error connecting to video service: " + err.message;
        return jsonError(message, 504, origin);
      }
    }

    // Route 3: Health check
    // GET /health
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", time: new Date().toISOString() }), {
        headers: Object.assign(
          { "Content-Type": "application/json; charset=utf-8" },
          corsHeaders(origin)
        ),
      });
    }

    return jsonError("Route not found", 404, origin);
  },

};
