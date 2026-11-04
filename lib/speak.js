// 范读与单词发音：用百度 gettts（OpenLearn 的 WORD_AUDIO_API_URL）。
//   接口：https://sensearch.baidu.com/gettts?lan=en&text=...&source=alading
// 浏览器直接请求会受 ORB/跨域限制，改走本服务的 /api/tts 代理（服务端转发百度）。
// 语速用 playbackRate 控制（现代浏览器变速不变调，preservesPitch 保持音高）。
// 百度对单次文本长度有限制，整段范读会先按标点切成短语，一段段接着念。

export function canSpeak() {
  return typeof window !== "undefined" && typeof Audio !== "undefined";
}

export function ttsUrl(text, lan = "en") {
  return `/api/tts?lan=${lan}&text=${encodeURIComponent(text)}`;
}

function clampRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0.8, Math.min(1.2, n));
}

// 把一段文本按次要标点切成短语，保证每段不太长、百度能完整念出来。
function splitForTts(text) {
  const parts = text.split(/([,.!?;:—]+)/);
  const out = [];
  let buf = "";
  for (const p of parts) {
    if (!p) continue;
    buf += p;
    if (/[,.!?;:—]/.test(p)) {
      const chunk = buf.trim();
      if (chunk) out.push(chunk);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

// 播放一段英文（整句或单个单词）。返回停止函数；onEnd 在自然播完、出错或被停止时回调。
export function speak(text, { rate = 1, onEnd, lan = "en" } = {}) {
  if (!canSpeak()) {
    onEnd?.();
    return () => {};
  }

  const chunks = splitForTts(text);
  let cancelled = false;
  let current = null;
  let resolveCurrent = null;

  const playOne = (chunk) =>
    new Promise((resolve) => {
      resolveCurrent = resolve;
      const audio = new Audio(ttsUrl(chunk, lan));
      audio.playbackRate = clampRate(rate);
      if ("preservesPitch" in audio) audio.preservesPitch = true;
      current = audio;
      const finish = () => {
        audio.removeEventListener("ended", finish);
        audio.removeEventListener("error", finish);
        resolve();
      };
      audio.addEventListener("ended", finish);
      audio.addEventListener("error", finish);
      audio.play().catch(finish);
    });

  (async () => {
    for (const chunk of chunks) {
      if (cancelled) return;
      await playOne(chunk);
    }
    if (!cancelled) onEnd?.();
  })();

  return () => {
    cancelled = true;
    current?.pause();
    resolveCurrent?.();
    onEnd?.();
  };
}
