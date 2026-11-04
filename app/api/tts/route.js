// 百度 gettts 的 TTS 代理：浏览器直接请求会受 ORB/跨域限制，
// 经这里转发（服务端到百度走普通 HTTP），并把音频原样回给前端。
// 与 OpenLearn 的 WORD_AUDIO_API_URL 一致：sensearch.baidu.com/gettts。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BAIDU_TTS = "https://sensearch.baidu.com/gettts";
const MAX_TEXT = 220;

export async function GET(request) {
  const url = new URL(request.url);
  const text = (url.searchParams.get("text") || "").trim();
  const lan = url.searchParams.get("lan") || "en";

  if (!text) {
    return Response.json({ error: "missing text" }, { status: 400 });
  }
  if (text.length > MAX_TEXT) {
    return Response.json({ error: "text too long" }, { status: 400 });
  }

  try {
    const upstream = `${BAIDU_TTS}?${new URLSearchParams({
      lan,
      text,
      source: "alading",
    })}`;
    const resp = await fetch(upstream, {
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      return Response.json({ error: `tts upstream ${resp.status}` }, { status: 502 });
    }
    const buf = await resp.arrayBuffer();
    return new Response(buf, {
      headers: {
        "Content-Type": resp.headers.get("content-type") || "audio/mpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    return Response.json({ error: "tts unavailable" }, { status: 502 });
  }
}
