<div align="center">

<img src="docs/logo.svg" width="72" alt="大声读">

# 大声读 · ReadAloud

**对着屏幕念一段英文，念完就知道哪个词念错了。**

[![Confucius4-R2T2](https://img.shields.io/badge/ASR-Confucius4--R2T2-000?style=flat-square&logo=huggingface&logoColor=white)](https://huggingface.co/netease-youdao/Confucius4-R2T2)
[![Jev](https://img.shields.io/badge/判词-Jev%201.13-5b4ee8?style=flat-square)](https://zenmux.ai/typesafe/jev-1.13)
[![Streaming](https://img.shields.io/badge/流式-160ms%20步长-0aa06e?style=flat-square)](https://huggingface.co/netease-youdao/Confucius4-R2T2)
[![Next.js](https://img.shields.io/badge/Next.js-16-000?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Self-hosted](https://img.shields.io/badge/自部署-12GB%20显存够用-f59e0b?style=flat-square&logo=nvidia&logoColor=white)](docs/deploy-r2t2.md)

</div>

---

英语流利说那一套，一个开源的实时 ASR 模型加一个开源的判词模型就能平替 ——
**而且可以整套跑在你自己的显卡上，不联网、不上传、不按分钟计费。**

念的时候字是一个个亮起来的，念错的当场标红，念完点一下出总分。
一台 12GB 的卡就够。

## 两个模型，各干各的

**R2T2 负责听。** 它是真流式，最低 160ms 的步长往外吐词，还有个叫
**stable prefix** 的机制：已经提交的文本只增不改。传统流式 ASR 会来回改词，
`I want to book` 变成 `I want to look` 再变回来 —— 给人看字幕还行，可下游要是
接了另一个模型，它就得跟着反复撤销自己刚做的判断。正因为有这一层，屏幕上划过的
线不会闪、判过的分不用重判，漏读多读也能直接拿识别结果算。

**Jev 负责判。** 它只在你事先声明好的空间里回答：是否、选一个、1–5 打分，
并且给概率。所以这里只问它文本层面的事 —— 念的是不是原文那个词、错法属于哪一类、
整段意思有没有走样。选它的理由很直接：**快**，一次判决几十到几百毫秒，几乎不花钱。

## 一条链路

```
麦克风 → R2T2（流式转写，只增不改 + 时间戳） → 对齐 → Jev（封闭问题判决） → 本机算术 → 划线 + 总分
```

对齐这一步挑出对不上的那几个词，只有它们值得问模型；剩下的全是算术，留在本机。

| 评什么 | 谁算 |
|---|---|
| 读对没读对（逐词「是不是同一个词」） | Jev `noul` + 概率 |
| 错误属于哪一类（替换 / ASR 拼写变体 / 自我纠正） | Jev `choice` |
| 听到的还是不是同一句话 | Jev `score`（1–5 级） |
| 漏读、多读、完整度 | 对齐，算术 |
| 语速与停顿 | R2T2 时间戳，算术 |
| 总分 | 本机加权（`lib/score.js` 的 `WEIGHTS`） |
| **发音、重音、口音** | **不出分** — Jev 只读文本，判不了声学，要评得另接音素级发音评测模型 |

## 三分钟跑起来

不用显卡也能先看效果 —— `ASR_PROVIDER=mock` 不碰麦克风，按 160ms 的节奏吐词并
预埋三类真实错误，整条判分链路照样跑通。

```bash
npm install
npm run dev        # http://localhost:3000（被占用会自动换端口）
npm test           # 对齐 / mock / 节奏算术的单测，不联网
```

## 用样例音频测试

默认页面 `/` 会选中 `The Gettysburg Address`，对应 `scripts/examples/The Gettysburg Address.m4a`。

直接运行 `npm run dev` 时，默认 `ASR_PROVIDER=mock`，不会读取音频文件；点击“开始朗读”可以测试页面、对齐和判分流程。要用样例音频测试真实 ASR：

1. 在 `.env.local` 中配置 `ASR_PROVIDER=r2t2`、`R2T2_WS_URL` 和 `R2T2_LANGUAGE=English`；判分还需要配置 `JEV_API_KEY`、`JEV_ENDPOINT` 和 `JEV_MODEL`。
2. 运行 `npm run dev`，打开首页并保持默认选中的 Gettysburg 文稿。
3. 在另一台设备上播放 `scripts/examples/The Gettysburg Address.m4a`，把扬声器靠近运行页面设备的麦克风，然后点击“开始朗读”。页面目前使用麦克风输入，不会直接上传或读取该文件。
4. 等音频播放结束后停止朗读并查看判分结果。线上中继单次会话最多约 30 秒；超过时长时使用自部署 R2T2，或只播放样例的前 30 秒。

### 真实复现末尾的 `equal`

要复现真实 ASR 的末尾词识别，不要用默认的 mock 模式：mock 不读取 `.m4a`，只按预设文本生成模拟结果。按上面的配置把 `.env.local` 设为 `ASR_PROVIDER=r2t2` 并重启开发服务，然后先打开 `http://localhost:3000/api/asr`，确认返回 JSON 中的 `provider` 是 `r2t2`。若仍是 `mock`，这次运行就没有经过真实 ASR。

在浏览器开发者工具的 Network 面板勾选 Preserve log 并筛选 `score`，用另一台设备播放完整样例，播放结束后点击停止。打开 `POST /api/score` 的请求载荷，检查 `heard` 字段是否包含 `equal`：

- `heard` 不含 `equal`：R2T2 没有识别出最后一个词。检查音频是否完整播放、麦克风是否收到声音，并在样例结束后再点停止；要排除环境变量 `R2T2_MAX_SECONDS` 或线上中继时长限制造成的截断。
- `heard` 含 `equal`，但页面仍将它标为漏读：ASR 已经听到该词，问题在识别结果与参考文本的对齐或标记；保留这份请求载荷即可复现和继续排查。

`JEV_API_KEY` 等判分配置只影响最终判分；检查实时识别结果时，关键是 `ASR_PROVIDER=r2t2`、可用的 R2T2 地址，以及浏览器麦克风权限。也可以使用下方的自动回放方式把音频直接送入浏览器音频流；它使用真实 R2T2，但会绕过扬声器和实体麦克风的声学链路。

### 自动回放并验证正文位置

需要重复验证页面是否在朗读时移动正文时，可以把样例音频直接接入浏览器的麦克风流，不依赖扬声器和实体麦克风。此方法需要已配置并运行的真实 R2T2；`ASR_PROVIDER=mock` 不会请求麦克风。部分浏览器不能直接解码 M4A，下面先用 PyAV 转成临时 WAV：

```powershell
python -m pip install av
$env:DASHENG_TEST_WAV = Join-Path $env:TEMP "dasheng-gettysburg.wav"
@'
import av, os

source = av.open("scripts/examples/The Gettysburg Address.m4a")
output = av.open(os.environ["DASHENG_TEST_WAV"], "w", format="wav")
stream = output.add_stream("pcm_s16le", rate=16000)
stream.layout = "mono"
resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)

for input_frame in source.decode(audio=0):
		for frame in resampler.resample(input_frame):
				for packet in stream.encode(frame):
						output.mux(packet)
for packet in stream.encode(None):
		output.mux(packet)

output.close()
source.close()
print(os.environ["DASHENG_TEST_WAV"])
'@ | python
```

在另一个 PowerShell 终端运行临时音频服务：

```powershell
node -e "const http=require('node:http'),fs=require('node:fs'),path=require('node:path');const data=fs.readFileSync(path.join(process.env.TEMP,'dasheng-gettysburg.wav'));http.createServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','audio/wav');res.setHeader('Content-Length',data.length);res.end(data)}).listen(4180,'127.0.0.1',()=>console.log('Audio fixture server listening on 4180'))"
```

打开首页开发者工具的 Console，先运行下面代码，再点击“开始朗读”。音频会在页面请求麦克风时开始播放，并作为麦克风输入送入 R2T2；计时器每 200ms 记录一次正文顶部坐标：

```js
(() => {
	const context = new AudioContext();
	const audio = new Audio();
	audio.crossOrigin = "anonymous";
	audio.src = "http://localhost:4180/";
	const source = context.createMediaElementSource(audio);
	const destination = context.createMediaStreamDestination();
	source.connect(destination);

	navigator.mediaDevices.getUserMedia = async () => {
		await context.resume();
		await audio.play();
		return destination.stream;
	};

	window.__dashengAudioReplay = { audio, context };
	window.__dashengPassageY = [];
	window.__dashengYTimer = setInterval(() => {
		window.__dashengPassageY.push(
			document.querySelector(".passage")?.getBoundingClientRect().top,
		);
	}, 200);
})();
```

音频播放结束后，在 Console 查看坐标变化；`delta` 为 `0` 表示播放期间正文没有移动：

```js
clearInterval(window.__dashengYTimer);
const positions = window.__dashengPassageY.filter(Number.isFinite);
console.log({
	minY: Math.min(...positions),
	maxY: Math.max(...positions),
	delta: Math.max(...positions) - Math.min(...positions),
});
```

测试后停止音频服务（在对应终端按 `Ctrl+C`），并重新加载页面以恢复浏览器原有的麦克风 API。临时 WAV 位于 `%TEMP%\dasheng-gettysburg.wav`，可自行删除。

## OpenLearn 待复习句子

Dasheng 现有一个独立的 `/review` 页面，用来读取 OpenLearn 里“到期待复习”的句子，并保留原来的首页 demo 不变。流程是：

1. 先启动 OpenLearn：在 `D:\work\OpenLearn` 目录执行 `python app.py`，默认监听 `http://127.0.0.1:5050`。
2. 再启动 Dasheng：`npm run dev`，访问 `http://localhost:3000/review`。
3. 在页面中输入 OpenLearn 用户名；当前 OpenLearn 允许的用户名仅为 `test` 或 `xue`。
4. 页面会通过 Dasheng 的 `GET /api/review?username=...` 代理访问 OpenLearn 的 `GET /review_list`，只展示待复习句子，不会提交答案、更新评分或复习等级。
5. 如果你把 OpenLearn 放在别的地址或端口，可以在 Dasheng 的 `.env.local` 里设置 `OPENLEARN_API_URL`，例如：

```bash
OPENLEARN_API_URL=http://127.0.0.1:5050
```

> 说明：OpenLearn 的 `/review_list` 会自动补齐用户的 `user_sentence` 关联记录；这一步是服务端为新用户补表，不属于 Dasheng 自己创建业务数据。Dasheng 这边只负责读取和展示，不触碰复习结果写回。

`.env.local`（**不要提交**）：

```bash
JEV_API_KEY=sk-ai-v1-...                          # ZenMux 的 key
JEV_ENDPOINT=https://zenmux.ai/api/v1/systemone   # Jev 走自己的 System One 接口，不是 chat/completions
JEV_MODEL=typesafe/jev-1.13

ASR_PROVIDER=r2t2                                 # mock = 不用麦克风，按节奏吐词并预埋三类错误
R2T2_WS_URL=wss://...                             # 见下
R2T2_LANGUAGE=English
```

本机 Docker 自部署时，`npm run dev` 会按 `.env.local` 的 `R2T2_*` 设置启动或复用 WebSocket 服务。可在本地配置中调整 `R2T2_DIALECT`、`R2T2_LANGUAGE`、`R2T2_SECRET_KEY`、`R2T2_GPU`、`R2T2_GPU_MEMORY_UTILIZATION`、`R2T2_MAX_MODEL_LEN`、`R2T2_MODEL_PATH`、`R2T2_VAD_MODEL_PATH`、`R2T2_PORT` 和 `R2T2_HTTP_PROXY`；修改端口时也要让 Docker 容器的端口映射与之匹配。

> 变量叫 `JEV_API_KEY` 而不是 `ZENMUX_API_KEY`：机器 shell 里可能已有别的项目的
> `ZENMUX_API_KEY`，而 shell 变量在 Next 里盖得过 `.env.local`。
> 开了 Clash 之类代理时，Node 的全局 `fetch` 不认 `https_proxy`（curl 认），
> `lib/jev.js` 检测到代理会改用 undici `ProxyAgent` 并显式带上 SNI。

## 接真模型

模型：[netease-youdao/Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)
（Qwen3-ASR 微调，~2B，真流式，最小 160ms 步长）·
[GitHub](https://github.com/netease-youdao/Confucius4-R2T2)

**想马上试**：用有道线上 demo 的中继（[r2t2.youdao.com/demo](https://r2t2.youdao.com/demo)
页面里就有 token），单次会话 30 秒上限，填进 `R2T2_WS_URL` 即可。

**想要自己的**：有张 NVIDIA 的卡就行，12GB 够用（Ampere 以上）。跑起来之后音频不出本机，
也没有时长限制。

自部署要 CUDA（Mac 跑不了，infer_mode 绑死 vLLM），步骤与七八个会咬人的坑
——`language` 传错会让流式退化成整句、显存参数按大卡写死、服务默认 `0.0.0.0` + 写死的
secret_key、浏览器采音与离线跑 wav 的两处差异——都在 **[docs/deploy-r2t2.md](docs/deploy-r2t2.md)**。

别设 `R2T2_SYSTEM_PROMPT` 塞原文 —— LLM 解码器会顺着提示把念错的词改回去，分就假了。

## 目录

```
app/page.js   待读 → 朗读中 → 判词中 → 读完（总分钮 → 明细面板）
app/api/      asr：mock 的 SSE 流 / r2t2 的中继地址 · score：一次判分
lib/align.js  词级对齐 —— 决定哪些词值得问 Jev
lib/jev.js    ZenMux System One 客户端（含代理兜底）
lib/score.js  问题构造、判决解析、四项子分与总分
lib/asr.js    provider：mock / r2t2（WebSocket + PCM16）
lib/mic.js    浏览器采音与重采样 · lib/speak.js 范读与逐词高亮
```
