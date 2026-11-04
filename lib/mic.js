"use client";

// 浏览器这一侧：麦克风 → 16k 单声道 PCM16 → R2T2 的 WebSocket。
//
// 为什么直连而不经我们的服务端：中继那条路上 key 由中继自己注入，我们手里只有
// 一个公开 token；自部署那条路服务就在隧道另一头。两种情况中间再转一道都只是
// 白加一次排队延迟，而这个应用整件事就是要让「已提交前缀」尽快出现在屏幕上。
//
// 两种方言的差异全在 lib/r2t2-protocol.js 里。

import {
  ASR_EOS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  TAIL_SILENCE_MS,
  buildHeader,
  encodeFrame,
  normalizeHeard,
  readReply,
} from "./r2t2-protocol.js";

// 拿到 is_final 定稿后，等这么久再自行收尾。目的是给自部署（native）服务留出
// 时间把最后一个词冲出来；单字重读用不着等用户手动点「停止」。
const SETTLE_DELAY_MS = 900;

export async function recordToR2T2({
  wsUrl,
  dialect = "relay",
  language = "English",
  secretKey = "",
  systemPrompt = "",
  onCommit,
  onLevel,
  onRecording,
  // 单字重读：识别到目标词后自行收尾。朗读正文不要传这个，否则停顿处的
  // is_final 会把整段会话提前结束。
  shouldFinish,
}) {
  if (!wsUrl) throw new Error("没有 R2T2 地址");

  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // 直接开 16k 的上下文，省掉自己写重采样；浏览器不给就按实际采样率线性抽。
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(media);
  const node = ctx.createScriptProcessor(4096, 1, 1);

  // 调试用录音：把麦克风原始音频用 MediaRecorder 存成 webm/ogg，停止时回传 blob。
  let recorder = null;
  let chunks = [];
  let recordingSent = false;
  if (onRecording && typeof MediaRecorder !== "undefined") {
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
      (m) => MediaRecorder.isTypeSupported(m),
    );
    if (mime) {
      recorder = new MediaRecorder(media, { mimeType: mime });
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.start(250);
    }
  }
  const finishRecording = () => {
    if (!recorder || recordingSent) return;
    recordingSent = true;
    if (recorder.state !== "recording") return;
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const ext = (recorder.mimeType || "").includes("ogg") ? "ogg" : "webm";
      if (blob.size) onRecording?.(blob, ext);
    };
    try {
      recorder.stop();
    } catch {
      if (chunks.length) onRecording?.(new Blob(chunks, { type: "audio/webm" }), "webm");
    }
  };

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const t0 = Date.now();
  const state = { text: "" };
  let finalText = "";
  let seq = 1;
  let pending = new Float32Array(0);
  let closedBy = null;
  let settleTimer = null;

  const settle = {};
  const done = new Promise((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });

  // 收尾：把到目前为止攒到的文本作为结果返回（resolve 幂等，多调无害）
  const finish = () => {
    if (settleTimer) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    settle.resolve({ heard: normalizeHeard(finalText || state.text), durationMs: Date.now() - t0 });
  };

  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    finishRecording();
    try { node.disconnect(); } catch {}
    try { source.disconnect(); } catch {}
    try { void ctx.close().catch(() => {}); } catch {}
    media.getTracks().forEach((t) => t.stop());
  };

  ws.onerror = () => {
    teardown();
    settle.reject(new Error("R2T2 连接失败"));
  };
  ws.onclose = (e) => {
    teardown();
    if (closedBy === "eos" || e.code === 1000) {
      finish();
    } else {
      settle.reject(new Error(`R2T2 断开 ${e.code}${e.reason ? ` ${e.reason}` : ""}`));
    }
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let out;
    try {
      out = readReply(dialect, e.data, state);
    } catch (err) {
      closedBy = "error";
      settle.reject(err);
      try { ws.close(); } catch {}
      return;
    }
    if (!out) return;
    if (out.final && out.text) finalText = out.text;
    const committed = normalizeHeard(out.text);
    const partial = normalizeHeard(out.partial);
    onCommit?.({
      committed,
      partial,
      at: Date.now() - t0,
    });
    // 重读纠错：听到目标词后再等一小会自行收尾，不用手动点「停止」。
    // 默认路径（朗读正文）不会传 shouldFinish，会话一直开到用户 stop()。
    if (shouldFinish?.({ committed, partial, final: out.final })) {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          closedBy = "eos";
          try {
            if (dialect === "native") {
              const tail = new Int16Array(Math.round(SAMPLE_RATE * (TAIL_SILENCE_MS / 1000)));
              ws.send(encodeFrame(dialect, tail, seq++));
            }
            ws.send(ASR_EOS);
          } catch {
            /* 收尾帧发失败也继续关 */
          }
          try { ws.close(1000); } catch {}
        }
        teardown();
        finish();
      }, SETTLE_DELAY_MS);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.addEventListener("error", () => reject(new Error("R2T2 连接失败")), { once: true });
  });

  ws.send(JSON.stringify(buildHeader(dialect, {
    requestId: `dasheng-${Date.now().toString(36)}`,
    language,
    systemPrompt,
    secretKey,
  })));

  node.onaudioprocess = (ev) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    // 上下文拿不到 16k 时（Safari）按比例抽样，宁可糙一点也别送错采样率
    const scaled = ctx.sampleRate === SAMPLE_RATE ? input : downsample(input, ctx.sampleRate, SAMPLE_RATE);

    let peak = 0;
    for (let i = 0; i < scaled.length; i++) peak = Math.max(peak, Math.abs(scaled[i]));
    onLevel?.(peak);

    const merged = new Float32Array(pending.length + scaled.length);
    merged.set(pending, 0);
    merged.set(scaled, pending.length);
    let off = 0;
    for (; off + FRAME_SAMPLES <= merged.length; off += FRAME_SAMPLES) {
      ws.send(encodeFrame(dialect, toInt16(merged.subarray(off, off + FRAME_SAMPLES)), seq++));
    }
    pending = merged.slice(off);
  };

  source.connect(node);
  node.connect(ctx.destination); // ScriptProcessor 不接出去就不会被调用

  return {
    done,
    stop() {
      if (ws.readyState !== WebSocket.OPEN) return;
      node.onaudioprocess = null;
      if (pending.length) ws.send(encodeFrame(dialect, toInt16(pending), seq++)); // 不满一帧的尾巴
      pending = new Float32Array(0);
      // 自部署的服务要靠这段静音把最后一个词冲出来，中继不需要
      if (dialect === "native") {
        const tail = new Int16Array(Math.round(SAMPLE_RATE * (TAIL_SILENCE_MS / 1000)));
        ws.send(encodeFrame(dialect, tail, seq++));
      }
      closedBy = "eos";
      ws.send(ASR_EOS);
      teardown();
    },
    abort() {
      closedBy = "eos";
      try { ws.close(1000); } catch {}
      teardown();
    },
  };
}

function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}
