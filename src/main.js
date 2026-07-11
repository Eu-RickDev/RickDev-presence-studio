const { app, BrowserWindow, ipcMain, shell, Menu, Tray, net } = require("electron");
const path = require("path");
const fs = require("fs");
const DiscordRPC = require("discord-rpc");
const { compareVersions } = require("./version");
const { createStartupManager } = require("./startup");
const {
  buildMusicActivity,
  createMediaWatcher,
  derivePresentation,
  hasSeeked,
  mediaSignature,
  selectMediaSession
} = require("./media");

let mainWindow;
let tray;
let rpc;
let activeClientId;
let activeConfig;
let activeStartTimestamp;
let priorityInterval;
let priorityUpdatePromise;
let autoStartTimer;
let autoStartAttempt = 0;
let autoStartToken = 0;
let updateCheckStarted = false;
let isQuitting = false;
let trayNoticeShown = false;
let startupStatus = { ok: true, active: false };
let mediaWatcher;
let lastMediaPayload;
let latestMedia;
let latestPresentation = { mode: "fallback", paused: false };
let lastPlayingAt = 0;
let rendererWatchingMusic = false;
let musicUpdatePromise;
let lastAppliedMusic;
let lastBroadcastMusic;
let musicTrackKey;
let musicTrackStartedAt = 0;
let musicWatcherError = "";
let musicTypeSupported = true;
let musicArtSupported = true;
const trackArtCache = new Map();
const applicationCache = new Map();
const githubRepository = "Eu-RickDev/RickDev-presence-studio";

const defaultSettings = {
  startWithWindows: false,
  autoStartPresence: false,
  musicIgnoredApps: []
};

let runtimeSettings = { ...defaultSettings };
const startupManager = createStartupManager(app);

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
  showTimer: true,
  highPriority: false,
  musicMode: false
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
  // A test build briefly stored per-type rules as an object; its keys count
  // as blocked apps.
  const rawIgnored = Array.isArray(data?.settings?.musicIgnoredApps)
    ? data.settings.musicIgnoredApps
    : data?.settings?.musicSourceRules && typeof data.settings.musicSourceRules === "object"
      ? Object.keys(data.settings.musicSourceRules)
      : [];

  const settings = {
    startWithWindows: Boolean(data?.settings?.startWithWindows),
    autoStartPresence: Boolean(data?.settings?.autoStartPresence),
    musicIgnoredApps: [...new Set(rawIgnored
      .map((app) => String(app).trim().toLowerCase().slice(0, 128))
      .filter(Boolean))].slice(0, 30)
  };

  if (Array.isArray(data?.profiles)) {
    return {
      activeProfile: Math.min(Math.max(Number(data.activeProfile) || 0, 0), 4),
      settings,
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
    settings,
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
  const normalized = normalizeProfiles(profiles);
  fs.writeFileSync(configPath(), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
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

async function fetchLatestRelease() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await net.fetch(`https://api.github.com/repos/${githubRepository}/releases/latest`, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "RickDev-Presence-Studio",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (!response.ok) return undefined;
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function checkForUpdates() {
  try {
    const release = await fetchLatestRelease();
    if (!release || release.draft || compareVersions(app.getVersion(), release.tag_name) <= 0) return;

    const update = {
      currentVersion: app.getVersion(),
      version: String(release.tag_name || "").replace(/^v/i, ""),
      name: release.name || `RickDev Presence Studio ${release.tag_name}`,
      notes: String(release.body || "Esta versao nao possui notas de lancamento.").slice(0, 20000),
      url: /^https:\/\/github\.com\//i.test(release.html_url || "")
        ? release.html_url
        : `https://github.com/${githubRepository}/releases/latest`
    };

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("update:available", update);
    }

    if (mainWindow?.isVisible() === false && process.platform === "win32") {
      tray?.displayBalloon({
        title: `RickDev Presence Studio ${update.version}`,
        content: "Uma nova versao esta disponivel. Clique para ver as novidades."
      });
    }
  } catch {
    // Update checks must never block startup or affect Discord RPC.
  }
}

function scheduleUpdateCheck() {
  if (updateCheckStarted) return;
  updateCheckStarted = true;
  const timer = setTimeout(checkForUpdates, 1500);
  timer.unref();
}

function sendStatus(status, message) {
  mainWindow?.webContents.send("presence:status", {
    status,
    message,
    startedAt: status === "online" ? activeStartTimestamp?.getTime() : undefined
  });
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

function buildActivity(config, startTimestamp) {
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

  if (config.showTimer && startTimestamp) activity.startTimestamp = startTimestamp;

  const buttons = buildButtons(config);

  if (buttons.length) activity.buttons = buttons;
  return activity;
}

function trackArtKey(media) {
  return `${media.artist}|${media.title}`.toLowerCase();
}

async function fetchTrackArt(media) {
  const term = encodeURIComponent(`${media.artist} ${media.title}`.trim());
  if (!term) return "";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await net.fetch(`https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=1`, {
      signal: controller.signal,
      headers: { "User-Agent": "RickDev Presence Studio" }
    });
    if (!response.ok) return "";

    const data = await response.json();
    const artwork = String(data?.results?.[0]?.artworkUrl100 || "");
    if (!artwork.startsWith("https://")) return "";

    const url = artwork.replace("100x100bb", "512x512bb");
    return url.length <= 256 ? url : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function lookupTrackArt(media) {
  const key = trackArtKey(media);
  const cached = trackArtCache.get(key);
  if (typeof cached === "string") return Promise.resolve(cached);
  if (typeof cached?.then === "function") return cached;
  // Empty results may be transient network failures; retry them after a while.
  if (cached && cached.emptyUntil > Date.now()) return Promise.resolve("");

  if (trackArtCache.size > 120) trackArtCache.delete(trackArtCache.keys().next().value);
  const pending = fetchTrackArt(media).then((url) => {
    trackArtCache.set(key, url || { emptyUntil: Date.now() + 60 * 1000 });
    return url;
  });
  trackArtCache.set(key, pending);
  return pending;
}

function broadcastMusicState(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const media = latestMedia?.active ? latestMedia : undefined;
  const cachedArt = media ? trackArtCache.get(trackArtKey(media)) : undefined;
  const artUrl = typeof cachedArt === "string" ? cachedArt : "";

  const ignoredApps = new Set((runtimeSettings.musicIgnoredApps || []).map((app) => app.toLowerCase()));
  const sources = (lastMediaPayload?.sessions || []).map((session) => ({
    app: session.app,
    title: session.title,
    playing: session.playing,
    ignored: ignoredApps.has(session.app.toLowerCase())
  }));

  // The watcher ticks every 1.5s even when nothing changed; only wake the
  // renderer for real changes (it extrapolates the progress bar locally).
  const now = Date.now();
  const signature = [
    Boolean(mediaWatcher), musicWatcherError, latestPresentation.mode, latestPresentation.paused,
    media?.title, media?.artist, media?.album, media?.playing, media?.durationMs, artUrl,
    JSON.stringify(sources)
  ].join("|");
  let positionDrift = 0;
  if (media && lastBroadcastMusic && lastBroadcastMusic.signature === signature) {
    const expected = lastBroadcastMusic.positionMs + (media.playing ? now - lastBroadcastMusic.atMs : 0);
    positionDrift = Math.abs(media.positionMs - expected);
  }
  if (!force && lastBroadcastMusic?.signature === signature && positionDrift < 2500) return;
  lastBroadcastMusic = { signature, positionMs: media?.positionMs || 0, atMs: now };

  mainWindow.webContents.send("music:state", {
    watching: Boolean(mediaWatcher),
    error: musicWatcherError,
    presentation: latestPresentation,
    sources,
    media: media ? { ...media, artUrl } : undefined
  });
}

function handleMediaState(payload) {
  lastMediaPayload = payload;
  const state = selectMediaSession(payload, runtimeSettings.musicIgnoredApps);
  latestMedia = state;
  if (state.active && state.playing) lastPlayingAt = Date.now();
  latestPresentation = derivePresentation(state, lastPlayingAt);
  broadcastMusicState();

  if (state.active && musicArtSupported) {
    const key = trackArtKey(state);
    lookupTrackArt(state).then((url) => {
      if (!url || !latestMedia?.active || trackArtKey(latestMedia) !== key) return;
      broadcastMusicState();
      // A cover that resolved after the presence was applied does not change
      // the signature; force one reapply so Discord picks it up.
      if (lastAppliedMusic && lastAppliedMusic.artUrl === "" && lastAppliedMusic.signature !== "fallback") {
        maybeUpdateMusicPresence(true);
      }
    });
  }

  maybeUpdateMusicPresence();
}

function shouldWatchMedia() {
  // The preview-only leg stops when the window hides to the tray; the
  // connected leg keeps the watcher alive for the presence itself.
  const windowVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  return (rendererWatchingMusic && windowVisible) || Boolean(rpc && activeConfig?.musicMode);
}

function syncMediaWatcher() {
  if (shouldWatchMedia()) {
    if (mediaWatcher) return;

    musicWatcherError = "";
    mediaWatcher = createMediaWatcher({
      onState: handleMediaState,
      onError: (message) => {
        musicWatcherError = message;
        if (rpc && activeConfig?.musicMode) sendStatus("error", message);
        broadcastMusicState();
      }
    });
    mediaWatcher.start();
    broadcastMusicState();
    return;
  }

  if (!mediaWatcher) return;
  mediaWatcher.stop();
  mediaWatcher = undefined;
  lastMediaPayload = undefined;
  latestMedia = undefined;
  latestPresentation = { mode: "fallback", paused: false };
  broadcastMusicState();
}

function setRawActivity(activity) {
  if (!rpc) return Promise.reject(new Error("Discord desconectado."));
  return rpc.request("SET_ACTIVITY", { pid: process.pid, activity });
}

function isActivityValidationError(error) {
  return /invalid|validation|fails|decod/i.test(String(error?.message || error));
}

// Older Discord clients reject the "listening" type or external image URLs;
// degrade one feature at a time and remember what this session supports.
// Discord's validation errors name the failing field, so blame the cover
// first when the message points at the assets instead of burning the type.
async function setMusicActivity(activity, artUrl, fallbackImage) {
  let current = activity;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await setRawActivity(current);
      return;
    } catch (error) {
      if (!isActivityValidationError(error)) throw error;

      const message = String(error?.message || error);
      const carriesArt = Boolean(artUrl) && current.assets?.large_image === artUrl;
      const blamesArt = carriesArt && /assets|image/i.test(message);

      if (carriesArt && (blamesArt || current.type === undefined)) {
        musicArtSupported = false;
        current = { ...current, assets: { ...current.assets } };
        if (fallbackImage && fallbackImage !== artUrl) current.assets.large_image = fallbackImage;
        else delete current.assets.large_image;
        if (!Object.keys(current.assets).length) delete current.assets;
        continue;
      }

      if (current.type !== undefined) {
        musicTypeSupported = false;
        current = { ...current };
        delete current.type;
        continue;
      }

      throw error;
    }
  }

  throw new Error("O Discord rejeitou a presence de midia.");
}

async function applyMusicPresence(signature) {
  const media = latestMedia;
  const presentation = latestPresentation;

  if (presentation.mode === "music" && media?.active) {
    const artUrl = musicArtSupported ? await lookupTrackArt(media) : "";
    if (!rpc || !activeConfig?.musicMode) return;

    if (musicTrackKey !== trackArtKey(media)) {
      musicTrackKey = trackArtKey(media);
      musicTrackStartedAt = Date.now();
    }

    const activity = buildMusicActivity(activeConfig, media, {
      paused: presentation.paused,
      artUrl,
      buttons: buildButtons(activeConfig),
      includeType: musicTypeSupported,
      now: Date.now(),
      fallbackStart: musicTrackStartedAt
    });

    await setMusicActivity(activity, artUrl, activeConfig.largeImageKey.trim());
    lastAppliedMusic = {
      signature,
      artUrl,
      positionMs: media.positionMs,
      atMs: Date.now(),
      playing: media.playing && !presentation.paused
    };
    sendStatus("online", (presentation.paused
      ? `Modo de midia: em pausa - ${media.title}`
      : `Modo de midia: ${media.title}${media.artist ? ` - ${media.artist}` : ""}`).slice(0, 140));
    return;
  }

  await rpc.setActivity(buildActivity(activeConfig, activeStartTimestamp));
  lastAppliedMusic = { signature, artUrl: "", positionMs: 0, atMs: Date.now(), playing: false };
  sendStatus("online", "Modo de midia: sem midia agora - presence configurada ativa");
}

function maybeUpdateMusicPresence(force = false) {
  if (!rpc || !activeConfig?.musicMode || isQuitting) return;

  const signature = mediaSignature(latestPresentation, latestMedia);
  const now = Date.now();

  if (!force && lastAppliedMusic?.signature === signature) {
    if (!hasSeeked(lastAppliedMusic, latestMedia, now)) return;
    if (now - lastAppliedMusic.atMs < 5000) return;
  }

  if (musicUpdatePromise) return;
  musicUpdatePromise = applyMusicPresence(signature)
    .catch((error) => {
      if (rpc && activeConfig?.musicMode) {
        sendStatus("error", error.message || "Falha ao atualizar o modo de midia.");
      }
    })
    .finally(() => {
      musicUpdatePromise = undefined;
    });
}

function stopPriorityLoop() {
  if (priorityInterval) clearInterval(priorityInterval);
  priorityInterval = undefined;
}

function clearActivePresence() {
  stopPriorityLoop();
  activeConfig = undefined;
  activeStartTimestamp = undefined;
  lastAppliedMusic = undefined;
  syncMediaWatcher();
}

function stopAutoStartRetries() {
  if (autoStartTimer) clearTimeout(autoStartTimer);
  autoStartTimer = undefined;
  autoStartAttempt = 0;
  autoStartToken += 1;
}

function isDiscordUnavailableError(error) {
  return /RPC_CONNECTION_TIMEOUT|Could not connect|connection closed|ECONNREFUSED|ENOENT/i
    .test(String(error?.message || error));
}

async function discardRpcClient() {
  const client = rpc;
  rpc = undefined;
  activeClientId = undefined;
  clearActivePresence();

  if (!client) return;
  try {
    await client.destroy();
  } catch {
    // A failed IPC connection may not have a transport to close.
  }
}

function scheduleAutoStart(initialDelay = 8000) {
  stopAutoStartRetries();
  if (!runtimeSettings.autoStartPresence) return;

  const token = autoStartToken;

  const scheduleAttempt = (delay) => {
    autoStartTimer = setTimeout(async () => {
      autoStartTimer = undefined;
      if (token !== autoStartToken || isQuitting || !runtimeSettings.autoStartPresence) return;

      autoStartAttempt += 1;
      sendStatus("connecting", `Aguardando o Discord - tentativa ${autoStartAttempt}`);

      try {
        const store = loadConfig();
        const config = store.profiles[store.activeProfile].config;
        await connect(config);
        if (token === autoStartToken) autoStartAttempt = 0;
      } catch (error) {
        await discardRpcClient();
        if (token !== autoStartToken || isQuitting || !runtimeSettings.autoStartPresence) return;

        if (!isDiscordUnavailableError(error)) {
          sendStatus("error", `Autoativacao: ${error.message || "configuracao invalida"}`);
          return;
        }

        const retryDelay = Math.min(15 * 1000 * (2 ** Math.min(autoStartAttempt - 1, 2)), 60 * 1000);
        sendStatus("connecting", `Discord indisponivel. Nova tentativa em ${retryDelay / 1000}s`);
        scheduleAttempt(retryDelay);
      }
    }, delay);
    autoStartTimer.unref();
  };

  scheduleAttempt(initialDelay);
}

function startPriorityLoop() {
  stopPriorityLoop();
  if (!activeConfig?.highPriority) return;

  priorityInterval = setInterval(async () => {
    if (!rpc || !activeConfig || priorityUpdatePromise) return;

    if (activeConfig.musicMode) {
      maybeUpdateMusicPresence(true);
      return;
    }

    try {
      priorityUpdatePromise = rpc.setActivity(buildActivity(activeConfig, activeStartTimestamp));
      await priorityUpdatePromise;
      sendStatus("online", "Presence ativa - alta prioridade");
    } catch (error) {
      sendStatus("error", error.message || "Falha ao reaplicar a presence.");
    } finally {
      priorityUpdatePromise = undefined;
    }
  }, 60 * 1000);
  priorityInterval.unref();
}

async function disconnect(cancelAutoStart = true) {
  if (cancelAutoStart) stopAutoStartRetries();
  clearActivePresence();
  if (musicUpdatePromise) await musicUpdatePromise;
  if (priorityUpdatePromise) {
    try {
      await priorityUpdatePromise;
    } catch {
      // The pending refresh already reports its own error.
    }
  }
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

  stopPriorityLoop();
  if (musicUpdatePromise) await musicUpdatePromise;
  if (priorityUpdatePromise) {
    try {
      await priorityUpdatePromise;
    } catch {
      // A manual activation below will replace the failed refresh.
    }
  }
  if (rpc && activeClientId !== clientId) await disconnect(false);

  if (!rpc) {
    sendStatus("connecting", "Conectando ao Discord...");
    rpc = new DiscordRPC.Client({ transport: "ipc" });
    activeClientId = clientId;
    musicTypeSupported = true;
    musicArtSupported = true;

    rpc.on("disconnected", () => {
      clearActivePresence();
      rpc = undefined;
      activeClientId = undefined;
      sendStatus("offline", "Discord desconectado");
    });

    await rpc.login({ clientId });
  }

  activeConfig = { ...config };
  activeStartTimestamp = config.showTimer ? new Date() : undefined;
  await rpc.setActivity(buildActivity(activeConfig, activeStartTimestamp));
  startPriorityLoop();
  sendStatus("online", config.musicMode
    ? "Modo de midia ativo - aguardando reproducao"
    : config.highPriority ? "Presence ativa - alta prioridade" : "Presence ativa");

  // The configured presence was just applied, which matches the fallback state;
  // the next media tick promotes it to the playing track.
  lastAppliedMusic = { signature: "fallback", artUrl: "", positionMs: 0, atMs: Date.now(), playing: false };
  syncMediaWatcher();
  if (activeConfig.musicMode && latestMedia) maybeUpdateMusicPresence();
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    show,
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
  mainWindow.webContents.once("did-finish-load", scheduleUpdateCheck);

  mainWindow.on("hide", () => syncMediaWatcher());
  mainWindow.on("show", () => {
    syncMediaWatcher();
    broadcastMusicState(true);
  });

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
    createWindow(true);
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
  tray.on("balloon-click", showWindow);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", (_event, commandLine) => {
  if (commandLine.includes("--hidden")) return;
  if (app.isReady()) showWindow();
  else app.once("ready", showWindow);
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;

  const startupStore = loadConfig();
  const launchedHidden = process.argv.includes("--hidden");
  runtimeSettings = { ...startupStore.settings };
  startupStatus = await startupManager.configure(runtimeSettings.startWithWindows);

  createWindow(!launchedHidden);
  createTray();
  trayNoticeShown = launchedHidden;

  ipcMain.handle("config:load", () => ({ ...loadConfig(), startupStatus }));
  ipcMain.handle("link:open", (_event, url) => {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Link nao permitido.");
    }
    return shell.openExternal(parsed.toString());
  });
  ipcMain.handle("config:save", async (_event, config) => {
    const previousStartWithWindows = runtimeSettings.startWithWindows;
    const normalized = saveConfig(config);
    runtimeSettings = { ...normalized.settings };
    if (runtimeSettings.startWithWindows !== previousStartWithWindows) {
      startupStatus = await startupManager.configure(runtimeSettings.startWithWindows);
    }

    if (!runtimeSettings.autoStartPresence) {
      stopAutoStartRetries();
    }

    // A blacklist edit must reselect the media source right away.
    if (lastMediaPayload) handleMediaState(lastMediaPayload);

    return { ...normalized, startupStatus };
  });
  ipcMain.handle("application:lookup", (_event, clientId) => lookupApplication(clientId));
  ipcMain.handle("music:watch", (_event, enabled) => {
    rendererWatchingMusic = Boolean(enabled);
    syncMediaWatcher();
    broadcastMusicState(true);
  });
  ipcMain.handle("presence:connect", async (_event, config) => {
    stopAutoStartRetries();
    try {
      await connect(config);
      return { ok: true };
    } catch (error) {
      await discardRpcClient();
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
      await discardRpcClient();
      sendStatus("error", error.message || "Falha ao atualizar.");
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle("presence:disconnect", disconnect);

  if (runtimeSettings.autoStartPresence) {
    scheduleAutoStart(launchedHidden ? 12000 : 3000);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopAutoStartRetries();
  stopPriorityLoop();
  if (mediaWatcher) {
    mediaWatcher.stop();
    mediaWatcher = undefined;
  }
  if (rpc) rpc.destroy();
});

app.on("window-all-closed", () => {
  // Keep the process alive so the Discord presence remains active in the tray.
});

app.on("activate", () => {
  showWindow();
});
