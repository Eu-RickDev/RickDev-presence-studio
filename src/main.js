const { app, BrowserWindow, ipcMain, shell, Menu, Tray, net } = require("electron");
const path = require("path");
const fs = require("fs");
const DiscordRPC = require("discord-rpc");

let mainWindow;
let tray;
let rpc;
let activeClientId;
let isQuitting = false;
let trayNoticeShown = false;
const applicationCache = new Map();

const defaults = {
  clientId: "",
  details: "Criando algo incrivel",
  state: "No RickDev Presence Studio",
  largeImageKey: "",
  largeImageText: "",
  smallImageKey: "",
  smallImageText: "",
  button1Label: "",
  button1Url: "",
  button2Label: "",
  button2Url: "",
  showTimer: true
};

function configPath() {
  return path.join(app.getPath("userData"), "presence-config.json");
}

function emptyProfile(index) {
  return {
    name: `Perfil ${index + 1}`,
    config: { ...defaults }
  };
}

function normalizeProfiles(data) {
  if (Array.isArray(data?.profiles)) {
    return {
      activeProfile: Math.min(Math.max(Number(data.activeProfile) || 0, 0), 4),
      profiles: Array.from({ length: 5 }, (_item, index) => {
        const profile = data.profiles[index] || emptyProfile(index);
        return {
          name: String(profile.name || `Perfil ${index + 1}`).slice(0, 24),
          config: { ...defaults, ...(profile.config || {}) }
        };
      })
    };
  }

  return {
    activeProfile: 0,
    profiles: [
      { name: "Perfil 1", config: { ...defaults, ...(data || {}) } },
      ...Array.from({ length: 4 }, (_item, index) => emptyProfile(index + 1))
    ]
  };
}

function loadConfig() {
  try {
    return normalizeProfiles(JSON.parse(fs.readFileSync(configPath(), "utf8")));
  } catch {
    return normalizeProfiles();
  }
}

function saveConfig(profiles) {
  fs.writeFileSync(configPath(), JSON.stringify(normalizeProfiles(profiles), null, 2), "utf8");
}

function applicationIconUrl(clientId, icon) {
  if (!icon) return "";
  const extension = icon.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/app-icons/${clientId}/${icon}.${extension}?size=256`;
}

function applicationAssetUrl(clientId, assetId) {
  return `https://cdn.discordapp.com/app-assets/${clientId}/${assetId}.png`;
}

async function fetchDiscordJson(url) {
  const response = await net.fetch(url, {
    headers: { "User-Agent": "RickDev Presence Studio" }
  });

  if (!response.ok) {
    throw new Error(response.status === 404
      ? "Aplicativo nao encontrado no Discord."
      : "Nao foi possivel consultar o aplicativo no Discord.");
  }

  return response.json();
}

async function lookupApplication(value) {
  const clientId = String(value || "").trim();
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error("Informe um Application ID valido do Discord.");
  }

  const cached = applicationCache.get(clientId);
  if (cached && Date.now() - cached.createdAt < 5 * 60 * 1000) {
    return cached.data;
  }

  const [application, assets] = await Promise.all([
    fetchDiscordJson(`https://discord.com/api/v10/oauth2/applications/${clientId}/rpc`),
    fetchDiscordJson(`https://discord.com/api/v10/oauth2/applications/${clientId}/assets`)
      .catch(() => [])
  ]);

  const data = {
    id: clientId,
    name: application.name || `App ${clientId.slice(0, 8)}`,
    iconUrl: applicationIconUrl(clientId, application.icon),
    assets: Object.fromEntries(assets.map((asset) => [
      asset.name,
      applicationAssetUrl(clientId, asset.id)
    ]))
  };

  applicationCache.set(clientId, { createdAt: Date.now(), data });
  return data;
}

function sendStatus(status, message) {
  mainWindow?.webContents.send("presence:status", { status, message });
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function buildButtons(config) {
  return [
    { label: config.button1Label.trim(), url: normalizeUrl(config.button1Url) },
    { label: config.button2Label.trim(), url: normalizeUrl(config.button2Url) }
  ].filter((button) => button.label && button.url);
}

function validateButtons(config) {
  const pairs = [
    [config.button1Label.trim(), config.button1Url.trim(), "Botao 1"],
    [config.button2Label.trim(), config.button2Url.trim(), "Botao 2"]
  ];

  for (const [label, url, name] of pairs) {
    if ((label && !url) || (!label && url)) {
      throw new Error(`${name}: preencha o texto e a URL.`);
    }

    if (label && label.length > 32) {
      throw new Error(`${name}: o texto deve ter no maximo 32 caracteres.`);
    }

    if (url) {
      try {
        new URL(normalizeUrl(url));
      } catch {
        throw new Error(`${name}: informe uma URL valida.`);
      }
    }
  }
}

function buildActivity(config) {
  validateButtons(config);

  const activity = {
    details: config.details.trim() || undefined,
    state: config.state.trim() || undefined,
    largeImageKey: config.largeImageKey.trim() || undefined,
    largeImageText: config.largeImageText.trim() || undefined,
    smallImageKey: config.smallImageKey.trim() || undefined,
    smallImageText: config.smallImageText.trim() || undefined,
    instance: false
  };

  if (config.showTimer) activity.startTimestamp = new Date();

  const buttons = buildButtons(config);

  if (buttons.length) activity.buttons = buttons;
  return activity;
}

async function disconnect() {
  if (rpc) {
    try {
      await rpc.clearActivity();
      rpc.destroy();
    } catch {
      // The Discord client may already be closed.
    }
  }
  rpc = undefined;
  activeClientId = undefined;
  sendStatus("offline", "Desconectado");
}

async function connect(config) {
  const clientId = config.clientId.trim();
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error("Informe um Application ID valido do Discord.");
  }

  if (rpc && activeClientId !== clientId) await disconnect();

  if (!rpc) {
    sendStatus("connecting", "Conectando ao Discord...");
    rpc = new DiscordRPC.Client({ transport: "ipc" });
    activeClientId = clientId;

    rpc.on("disconnected", () => {
      rpc = undefined;
      activeClientId = undefined;
      sendStatus("offline", "Discord desconectado");
    });

    await rpc.login({ clientId });
  }

  await rpc.setActivity(buildActivity(config));
  sendStatus("online", "Presence ativa");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#090a0f",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#090a0f",
      symbolColor: "#a9aab7",
      height: 38
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  mainWindow.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();
    mainWindow.hide();

    if (!trayNoticeShown) {
      tray.displayBalloon({
        title: "RickDev Presence Studio",
        content: "O app continua ativo na bandeja para manter sua Rich Presence."
      });
      trayNoticeShown = true;
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  tray = new Tray(path.join(__dirname, "..", "build", "icon.png"));
  tray.setToolTip("RickDev Presence Studio");
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: "Abrir RickDev Presence Studio",
      click: showWindow
    },
    { type: "separator" },
    {
      label: "Encerrar",
      click: () => app.quit()
    }
  ]));
  tray.on("double-click", showWindow);
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  ipcMain.handle("config:load", () => loadConfig());
  ipcMain.handle("link:open", (_event, url) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Link nao permitido.");
    }
    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle("config:save", (_event, config) => {
    saveConfig(config);
  });
  ipcMain.handle("application:lookup", (_event, clientId) => lookupApplication(clientId));
  ipcMain.handle("presence:connect", async (_event, config) => {
    try {
      await connect(config);
      return { ok: true };
    } catch (error) {
      rpc = undefined;
      activeClientId = undefined;
      sendStatus("error", error.message || "Nao foi possivel conectar.");
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("presence:update", async (_event, config) => {
    try {
      await connect(config);
      sendStatus("online", "Presence atualizada");
      return { ok: true };
    } catch (error) {
      sendStatus("error", error.message || "Falha ao atualizar.");
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("presence:disconnect", disconnect);
});

app.on("before-quit", () => {
  isQuitting = true;
  if (rpc) rpc.destroy();
});

app.on("window-all-closed", () => {
  // Keep the process alive so the Discord presence remains active in the tray.
});

app.on("activate", () => {
  showWindow();
});
