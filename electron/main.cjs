/**
 * Electron main process.
 *
 * In dev mode (NEXT_DEV_URL set), opens a BrowserWindow that loads the
 * already-running Next.js dev server.
 *
 * In packaged / "start" mode, spawns the Next.js standalone server as a
 * child process and waits for it to bind, then opens the window.
 *
 * The kie.ai API key is read from the environment (or .env.local at the
 * project root). It is passed only to the spawned Next.js child process —
 * never embedded in the renderer bundle.
 */
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

let nextProcess = null;
let mainWindow = null;

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function envForChild() {
  const projectEnv = loadEnvFile(path.join(__dirname, "..", ".env.local"));
  return {
    ...process.env,
    ...projectEnv,
    NODE_ENV: "production",
    PORT: process.env.PORT || "3210",
    HOSTNAME: "127.0.0.1",
  };
}

function waitForServer(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http
        .get(url, () => resolve())
        .on("error", () => {
          if (Date.now() - start > timeoutMs) reject(new Error("server boot timeout"));
          else setTimeout(tick, 250);
        });
      req.setTimeout(2000, () => req.destroy());
    };
    tick();
  });
}

async function startNextStandalone() {
  const standaloneDir = path.join(__dirname, "..", ".next", "standalone");
  const serverJs = path.join(standaloneDir, "server.js");
  if (!fs.existsSync(serverJs)) {
    throw new Error(
      `Next.js standalone build not found at ${serverJs}. ` +
        `Run \`npm run build\` first, or use \`npm run electron:dev\` for the dev workflow.`
    );
  }
  const env = envForChild();
  nextProcess = spawn(process.execPath, [serverJs], {
    env,
    cwd: standaloneDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  nextProcess.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      // eslint-disable-next-line no-console
      console.error(`Next.js server exited with code ${code}`);
    }
  });
  await waitForServer(`http://127.0.0.1:${env.PORT}`);
  return `http://127.0.0.1:${env.PORT}`;
}

async function createWindow() {
  const devUrl = process.env.NEXT_DEV_URL;
  let url;
  if (devUrl) {
    url = devUrl;
  } else {
    url = await startNextStandalone();
  }

  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 800,
    backgroundColor: "#07070a",
    title: "Virtualized DJ",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: "deny" };
  });

  mainWindow.loadURL(url);
}

app.whenReady().then(createWindow).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (nextProcess) {
    try {
      nextProcess.kill();
    } catch {
      // ignore
    }
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (nextProcess) {
    try {
      nextProcess.kill();
    } catch {
      // ignore
    }
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
