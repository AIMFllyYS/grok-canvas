const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  LOCAL_ORIGIN,
  serverLaunch,
  serverEnvironment,
  externalHttpUrl,
  isAppUrl,
} = require("./runtime.cjs");

const DEVELOPMENT = process.argv.includes("--dev") || !app.isPackaged;
const START_TIMEOUT_MS = 45_000;
const APP_ID = "com.aimfllyys.grokcanvas";

let mainWindow = null;
let serverProcess = null;
let serverLog = "";
let quitting = false;

app.setAppUserModelId(APP_ID);

function captureServerOutput(chunk) {
  serverLog = `${serverLog}${chunk}`.slice(-8_000);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function endpointReady() {
  try {
    const response = await fetch(LOCAL_ORIGIN, {
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(800),
    });
    return response.status > 0;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = START_TIMEOUT_MS, stopped = () => false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopped()) throw new Error(`本地服务启动失败\n\n${serverLog.slice(-4_000)}`);
    if (await endpointReady()) return;
    await delay(250);
  }
  throw new Error(`本地服务未在 ${Math.round(timeoutMs / 1000)} 秒内就绪`);
}

async function startServer() {
  if (await endpointReady()) {
    throw new Error("端口 3210 已被占用。请先关闭正在运行的 Grok Canvas 或其他开发服务。");
  }

  const launch = serverLaunch({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  if (!fs.existsSync(launch.entry)) {
    throw new Error(`缺少桌面端服务文件：${launch.entry}`);
  }

  serverProcess = spawn(process.execPath, [launch.entry], {
    cwd: launch.cwd,
    env: serverEnvironment(process.env, launch.nodePath),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  serverProcess.stdout?.on("data", captureServerOutput);
  serverProcess.stderr?.on("data", captureServerOutput);

  const child = serverProcess;
  child.once("exit", (code) => {
    if (serverProcess === child) serverProcess = null;
    if (quitting) return;
    serverLog = `${serverLog}\n本地服务已退出，退出码 ${code ?? "unknown"}`.trim();
  });

  await waitForServer(START_TIMEOUT_MS, () => child.exitCode !== null);
}

function stopServer() {
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  child.kill("SIGTERM");
}

function createWindow() {
  const icon = path.join(__dirname, "..", "build", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    backgroundColor: "#111111",
    title: "Grok Canvas",
    icon: fs.existsSync(icon) ? icon : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.removeMenu();
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const external = externalHttpUrl(url);
    if (external && !isAppUrl(external)) void shell.openExternal(external);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    const external = externalHttpUrl(url);
    if (external) void shell.openExternal(external);
  });
  void mainWindow.loadURL(LOCAL_ORIGIN);
}

async function boot() {
  if (DEVELOPMENT) {
    await waitForServer();
  } else if (!(await endpointReady())) {
    await startServer();
  }
  createWindow();
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("Grok Canvas 无法启动", message);
  quitting = true;
  stopServer();
  app.quit();
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  ipcMain.handle("desktop:open-external", (_event, value) => {
    const url = typeof value === "string" ? externalHttpUrl(value) : null;
    return url ? shell.openExternal(url) : undefined;
  });

  app.whenReady().then(() => boot().catch(fail));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !quitting) void boot().catch(fail);
  });
  app.on("before-quit", () => {
    quitting = true;
    stopServer();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
