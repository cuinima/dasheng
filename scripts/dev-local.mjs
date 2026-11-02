import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { WebSocket } from "undici";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(root);

const container = process.env.R2T2_DOCKER_CONTAINER || "confucius4-r2t2-ws";
const sourceDir =
  process.env.R2T2_CONTAINER_SOURCE_DIR || "/data/shared/confucius4-r2t2/r2t2-src";
const pidFile = "/tmp/dasheng-r2t2-ws.pid";
const configFile = "/tmp/dasheng-r2t2-ws.config";
const serverPort = process.env.R2T2_SERVER_PORT || "8272";
const endpointPort = process.env.R2T2_WS_URL?.match(/:(\d+)\//)?.[1];
const hostPort = process.env.R2T2_PORT || endpointPort || serverPort;
const modelPath = process.env.R2T2_MODEL_PATH || "netease-youdao/Confucius4-R2T2";
const vadModelPath = process.env.R2T2_VAD_MODEL_PATH || "checkpoints/vad/Stream-VAD";
const gpu = process.env.R2T2_GPU || "0";
const gpuMemoryUtilization = process.env.R2T2_GPU_MEMORY_UTILIZATION || "0.9";
const maxModelLen = process.env.R2T2_MAX_MODEL_LEN || "8192";
const secretKey = process.env.R2T2_SECRET_KEY || "test0102";
const serviceConfig = JSON.stringify({
  serverPort,
  hostPort,
  modelPath,
  vadModelPath,
  gpu,
  gpuMemoryUtilization,
  maxModelLen,
  secretKey,
});

function runDocker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr.trim() || `docker ${args[0]} failed`);
  }
  return result;
}

function isLocalNativeEndpoint() {
  if ((process.env.ASR_PROVIDER || "mock").trim().toLowerCase() !== "r2t2") return false;
  const wsUrl = process.env.R2T2_WS_URL || "";
  const dialect = (process.env.R2T2_DIALECT || "").trim().toLowerCase();
  return (
    ["localhost", "127.0.0.1"].some(
      (host) => wsUrl.startsWith(`ws://${host}:`) || wsUrl.startsWith(`ws://${host}/`),
    ) &&
    wsUrl.includes("/asr_stream_api_v1") &&
    (!dialect || dialect === "native")
  );
}

async function websocketReady() {
  const url = process.env.R2T2_WS_URL;
  return new Promise((resolveReady) => {
    let settled = false;
    let socket;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.close();
      resolveReady(ready);
    };
    const timer = setTimeout(() => finish(false), 1500);

    try {
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            requestId: `dasheng-startup-${process.pid}`,
            channels: 1,
            sample_rate: 16000,
            language: process.env.R2T2_LANGUAGE || "English",
            use_vad: false,
            secret_key: secretKey,
            mode: process.env.R2T2_MODE || "slow",
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        try {
          finish(JSON.parse(event.data).status === "connected");
        } catch {
          finish(false);
        }
      });
      socket.addEventListener("error", () => finish(false));
      socket.addEventListener("close", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

function isMarkedServiceAlive() {
  const check = [
    "import os,sys",
    `p='${pidFile}'`,
    "pid=int(open(p).read()) if os.path.exists(p) else 0",
    "cmd=open(f'/proc/{pid}/cmdline','rb').read() if pid and os.path.exists(f'/proc/{pid}/cmdline') else b''",
    "sys.exit(0 if b'dasheng-r2t2-ws' in cmd else 1)",
  ].join(";");
  return runDocker(["exec", container, "python", "-c", check], { allowFailure: true }).status === 0;
}

function serviceConfigMatches() {
  const check = [
    "import os,sys",
    `p='${configFile}'`,
    "current=open(p).read() if os.path.exists(p) else ''",
    "sys.exit(0 if current==os.environ.get('DASHENG_R2T2_CONFIG','') else 1)",
  ].join(";");
  return (
    runDocker(
      ["exec", "-e", `DASHENG_R2T2_CONFIG=${serviceConfig}`, container, "python", "-c", check],
      { allowFailure: true },
    ).status === 0
  );
}

function stopMarkedService() {
  const stop = [
    "import os,signal",
    `p='${pidFile}'`,
    "pid=int(open(p).read()) if os.path.exists(p) else 0",
    "os.kill(pid,signal.SIGTERM) if pid else None",
  ].join(";");
  runDocker(["exec", container, "python", "-c", stop]);
}

async function waitForServiceExit(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isMarkedServiceAlive()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("旧 R2T2 服务未能停止；请检查容器日志后重试。");
}

async function waitForWebSocketReady(timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await websocketReady()) return;
    if (!isMarkedServiceAlive()) {
      throw new Error("R2T2 服务启动失败；查看容器内 /tmp/dasheng-r2t2-ws.log。");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  throw new Error("R2T2 服务预热超时；查看容器内 /tmp/dasheng-r2t2-ws.log。");
}

function startWebSocketService() {
  const serviceCode = `
import os,sys
p='ws_server.py'
pid_file='${pidFile}'
config_file='${configFile}'
server_port=os.environ.get('R2T2_SERVER_PORT','8272')
os.environ['CUDA_VISIBLE_DEVICES']=os.environ.get('R2T2_GPU','0')
log=open('/tmp/dasheng-r2t2-ws.log','a',buffering=1)
sys.stdout=log
sys.stderr=log
open(pid_file,'w').write(str(os.getpid()))
open(config_file,'w').write(os.environ.get('DASHENG_R2T2_CONFIG',''))
sys.argv=[p,'--port',server_port,'--asr_model_path',os.environ.get('R2T2_MODEL_PATH','netease-youdao/Confucius4-R2T2'),'--vad_model_path',os.environ.get('R2T2_VAD_MODEL_PATH','checkpoints/vad/Stream-VAD')]
src=open(p,encoding='utf-8').read()
old='gpu_memory_utilization=0.95, #0.8'
assert old in src, 'ws_server.py changed; update the local startup override'
memory=float(os.environ.get('R2T2_GPU_MEMORY_UTILIZATION','0.9'))
max_model_len=int(os.environ.get('R2T2_MAX_MODEL_LEN','8192'))
src=src.replace(old,f'gpu_memory_utilization={memory}, max_model_len={max_model_len},',1)
old_secret='secret_key_list=["test0102"] # only for debug'
assert old_secret in src, 'ws_server.py secret configuration changed; update the local startup override'
secret=os.environ.get('R2T2_SECRET_KEY','test0102')
src=src.replace(old_secret,f'secret_key_list=[{secret!r}]',1)
try:
 exec(compile(src,p,'exec'),{'__name__':'__main__','__file__':p})
finally:
 try:
  if open(pid_file).read()==str(os.getpid()): os.remove(pid_file)
 except OSError:
  pass
`;
  const encoded = Buffer.from(serviceCode, "utf8").toString("base64");
  const pythonCommand = `import base64;exec(base64.b64decode('${encoded}'))`;
  const proxy = process.env.R2T2_HTTP_PROXY || "http://host.docker.internal:7890";
  runDocker([
    "exec",
    "-d",
    "-e",
    "HF_HUB_DISABLE_XET=1",
    "-e",
    `R2T2_SERVER_PORT=${serverPort}`,
    "-e",
    `R2T2_MODEL_PATH=${modelPath}`,
    "-e",
    `R2T2_VAD_MODEL_PATH=${vadModelPath}`,
    "-e",
    `R2T2_GPU=${gpu}`,
    "-e",
    `R2T2_GPU_MEMORY_UTILIZATION=${gpuMemoryUtilization}`,
    "-e",
    `R2T2_MAX_MODEL_LEN=${maxModelLen}`,
    "-e",
    `R2T2_SECRET_KEY=${secretKey}`,
    "-e",
    `DASHENG_R2T2_CONFIG=${serviceConfig}`,
    "-e",
    `HTTP_PROXY=${proxy}`,
    "-e",
    `HTTPS_PROXY=${proxy}`,
    "-e",
    `http_proxy=${proxy}`,
    "-e",
    `https_proxy=${proxy}`,
    "-w",
    sourceDir,
    container,
    "python",
    "-c",
    pythonCommand,
    "dasheng-r2t2-ws",
  ]);
  console.log("R2T2 WebSocket 正在容器内加载模型和 VAD；首次启动需要等待预热完成。");
}

function startNext() {
  const nextCli = join(root, "node_modules", "next", "dist", "bin", "next");
  const next = spawn(process.execPath, [nextCli, "dev"], {
    cwd: root,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => next.kill(signal));
  }
  next.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  next.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

async function dashengAlreadyRunning() {
  try {
    const response = await fetch("http://127.0.0.1:3000/api/asr", {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;
    const config = await response.json();
    return typeof config.provider === "string";
  } catch {
    return false;
  }
}

async function main() {
  if (!isLocalNativeEndpoint()) {
    startNext();
    return;
  }

  const inspect = runDocker(["inspect", container]);
  const state = JSON.parse(inspect.stdout)[0];
  const bindings = state.NetworkSettings.Ports?.[`${serverPort}/tcp`] || [];
  if (!bindings.some((binding) => binding.HostPort === hostPort)) {
    throw new Error(
      `${container} 需要把容器端口 ${serverPort} 发布到主机端口 ${hostPort}，请重建容器。`,
    );
  }
  if (!state.State.Running) runDocker(["start", container]);

  const ready = await websocketReady();
  const managed = isMarkedServiceAlive();
  if (managed && !serviceConfigMatches()) {
    console.log("R2T2 本地配置已变化，正在重启 WebSocket 服务。");
    stopMarkedService();
    await waitForServiceExit();
    startWebSocketService();
    await waitForWebSocketReady();
    console.log("R2T2 WebSocket 已就绪。");
  } else if (managed && !ready) {
    console.log("R2T2 WebSocket 正在预热，等待模型就绪。");
    await waitForWebSocketReady();
  } else if (!ready && !managed) {
    startWebSocketService();
    await waitForWebSocketReady();
    console.log("R2T2 WebSocket 已就绪。");
  } else if (ready && !managed) {
    console.log("R2T2 WebSocket 已在运行，复用未由启动器管理的服务。");
  } else {
    console.log("R2T2 WebSocket 已在运行，复用现有服务。");
  }

  if (await dashengAlreadyRunning()) {
    console.log("Dasheng 已在 http://localhost:3000 运行，复用现有开发服务器。");
    return;
  }

  startNext();
}

main().catch((error) => {
  console.error(`本地服务启动失败：${error.message}`);
  process.exitCode = 1;
});