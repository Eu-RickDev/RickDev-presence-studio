const { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, net } = require("electron");
const path = require("path");
const fs = require("fs");
const DiscordRPC = require("discord-rpc");
const { compareVersions } = require("./version");
const { createStartupManager } = require("./startup");
const {
  MAX_IMPORT_BYTES,
  buildProfilesExport,
  createConfigStore,
  defaultSettings,
  normalizeConfig,
  parseProfilesImport,
  writeJsonAtomic
} = require("./config");
const {
  buildMusicActivity,
  createMediaWatcher,
  derivePresentation,
  hasSeeked,
  mediaSignature,
  presenceText,
  selectMediaSession
} = require("./media");

// Discord only accepts a handful of activity updates per window (about five
// every 20 seconds), so media updates are spaced out and coalesced.
const MUSIC_UPDATE_SPACING_MS = 4000;
const SEEK_REAPPLY_MIN_MS = 5000;
const RPC_CLOSE_TIMEOUT_MS = 3000;
const RECONNECT_FIRST_DELAY_MS = 5000;
const RETRY_DELAYS_MS = [15 * 1000, 30 * 1000, 60 * 1000];

let mainWindow;
let tray;
let rpc;
let activeClientId;
let activeConfig;
let activeStartTimestamp;
let priorityInterval;
let priorityUpdatePromise;
let connectionQueue = Promise.resolve();
let retryTimer;
let retryAttempt = 0;
let retryToken = 0;
let retryKind;
let updateCheckStarted = false;
let isQuitting = false;
let trayNoticeShown = false;
let startupStatus = { ok: true, active: false };
let lastStatus = { status: "offline", message: "Desconectado" };
let corruptedConfigBackup;
let mediaWatcher;
let lastMediaPayload;
let latestMedia;
let latestPresentation = { mode: "fallback", paused: false };
let lastPlayingAt = 0;
let rendererWatchingMusic = false;
let musicUpdatePromise;
let musicUpdateTimer;
let musicUpdateQueued = false;
let musicUpdateForce = false;
let lastMusicUpdateAt = 0;
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

let runtimeSettings = { ...defaultSettings };
const startupManager = createStartupManager(app);
const configStore = createConfigStore(() => app.getPath("userData"), {
  onCorrupted: (backup) => {
    corruptedConfigBackup = backup;
  }
});

function loadConfig() {
  return configStore.load();
}

function saveConfig(data) {
  return configStore.save(data);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "RickDev Presence Studio" }
    });

    if (!response.ok) {
      throw new Error(response.status === 404
        ? "Aplicativo não encontrado no Discord."
        : "Não foi possível consultar o aplicativo no Discord.");
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function lookupApplication(value) {
  const clientId = String(value || "").trim();
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error("Informe um Application ID válido do Discord.");
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
    assets: Object.fromEntries((Array.isArray(assets) ? assets : []).map((asset) => [
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
      notes: String(release.body || "Esta versão não possui notas de lançamento.").slice(0, 20000),
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
        content: "Uma nova versão está disponível. Clique para ver as novidades."
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

function presenceConnected() {
  return Boolean(rpc && activeConfig);
}

function statusPayload() {
  const connected = presenceConnected();
  return {
    ...lastStatus,
    connected,
    startedAt: connected ? activeStartTimestamp?.getTime() : undefined
  };
}

function sendStatus(status, message) {
  lastStatus = { status, message };
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("presence:status", statusPayload());
}

function normalizeUrl(value) {
  const trimmed = String(value || "").trim();
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
    [config.button1Label.trim(), config.button1Url.trim(), "Botão 1"],
    [config.button2Label.trim(), config.button2Url.trim(), "Botão 2"]
  ];

  for (const [label, url, name] of pairs) {
    if ((label && !url) || (!label && url)) {
      throw new Error(`${name}: preencha o texto e a URL.`);
    }

    if (label && label.length > 32) {
      throw new Error(`${name}: o texto deve ter no máximo 32 caracteres.`);
    }

    if (url) {
      try {
        new URL(normalizeUrl(url));
      } catch {
        throw new Error(`${name}: informe uma URL válida.`);
      }
    }
  }
}

function buildActivity(config, startTimestamp) {
  validateButtons(config);

  // presenceText pads one-character texts, which Discord would reject.
  const activity = {
    details: presenceText(config.details) || undefined,
    state: presenceText(config.state) || undefined,
    largeImageKey: config.largeImageKey.trim() || undefined,
    largeImageText: presenceText(config.largeImageText) || undefined,
    smallImageKey: config.smallImageKey.trim() || undefined,
    smallImageText: presenceText(config.smallImageText) || undefined,
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

// The user can turn the iTunes lookup off (it sends title and artist to Apple);
// musicArtSupported tracks whether this Discord client accepts image URLs.
function coverLookupAllowed() {
  return runtimeSettings.musicCoverLookup !== false;
}

function coverLookupEnabled() {
  return coverLookupAllowed() && musicArtSupported;
}

function broadcastMusicState(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const media = latestMedia?.active ? latestMedia : undefined;
  const cachedArt = media && coverLookupAllowed() ? trackArtCache.get(trackArtKey(media)) : undefined;
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

  if (state.active && coverLookupEnabled()) {
    const key = trackArtKey(state);
    lookupTrackArt(state).then((url) => {
      if (!url || !coverLookupEnabled() || !latestMedia?.active || trackArtKey(latestMedia) !== key) return;
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

  throw new Error("O Discord rejeitou a presence de mídia.");
}

async function applyMusicPresence(signature) {
  const media = latestMedia;
  const presentation = latestPresentation;

  if (presentation.mode === "music" && media?.active) {
    const artUrl = coverLookupEnabled() ? await lookupTrackArt(media) : "";
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
      ? `Modo de mídia: em pausa - ${media.title}`
      : `Modo de mídia: ${media.title}${media.artist ? ` - ${media.artist}` : ""}`).slice(0, 140));
    return;
  }

  if (!rpc || !activeConfig) return;
  await rpc.setActivity(buildActivity(activeConfig, activeStartTimestamp));
  lastAppliedMusic = { signature, artUrl: "", positionMs: 0, atMs: Date.now(), playing: false };
  sendStatus("online", "Modo de mídia: nenhuma mídia agora - presence configurada ativa");
}

function musicPresenceOutdated(signature, now = Date.now()) {
  if (lastAppliedMusic?.signature !== signature) return true;
  return hasSeeked(lastAppliedMusic, latestMedia, now)
    && now - lastAppliedMusic.atMs >= SEEK_REAPPLY_MIN_MS;
}

function resetMusicUpdates() {
  if (musicUpdateTimer) clearTimeout(musicUpdateTimer);
  musicUpdateTimer = undefined;
  musicUpdateQueued = false;
  musicUpdateForce = false;
}

// Skipping through tracks produces a change on every watcher tick. Updates are
// spaced out and, once the slot frees up, the latest state is the one applied,
// so a burst never ends on a stale track.
function maybeUpdateMusicPresence(force = false) {
  if (!rpc || !activeConfig?.musicMode || isQuitting) return;

  const wantsForce = force || musicUpdateForce;
  if (!wantsForce && !musicPresenceOutdated(mediaSignature(latestPresentation, latestMedia))) return;
  musicUpdateForce = wantsForce;

  if (musicUpdatePromise) {
    musicUpdateQueued = true;
    return;
  }
  if (musicUpdateTimer) return;

  const wait = lastMusicUpdateAt + MUSIC_UPDATE_SPACING_MS - Date.now();
  if (wait > 0) {
    musicUpdateTimer = setTimeout(() => {
      musicUpdateTimer = undefined;
      runMusicUpdate();
    }, wait);
    return;
  }

  runMusicUpdate();
}

function runMusicUpdate() {
  const force = musicUpdateForce;
  musicUpdateForce = false;
  musicUpdateQueued = false;
  if (!rpc || !activeConfig?.musicMode || isQuitting) return;

  const signature = mediaSignature(latestPresentation, latestMedia);
  if (!force && !musicPresenceOutdated(signature)) return;

  lastMusicUpdateAt = Date.now();
  musicUpdatePromise = applyMusicPresence(signature)
    .catch((error) => {
      if (rpc && activeConfig?.musicMode) {
        sendStatus("error", error.message || "Falha ao atualizar o modo de mídia.");
      }
    })
    .finally(() => {
      musicUpdatePromise = undefined;
      if (musicUpdateQueued) {
        musicUpdateQueued = false;
        maybeUpdateMusicPresence();
      }
    });
}

function stopPriorityLoop() {
  if (priorityInterval) clearInterval(priorityInterval);
  priorityInterval = undefined;
}

function clearActivePresence() {
  stopPriorityLoop();
  resetMusicUpdates();
  activeConfig = undefined;
  activeStartTimestamp = undefined;
  lastAppliedMusic = undefined;
  syncMediaWatcher();
}

async function settlePendingUpdates() {
  await Promise.allSettled([musicUpdatePromise, priorityUpdatePromise].filter(Boolean));
}

// Closing an IPC client waits for Discord to answer; never let a hung client
// block the connection queue forever.
function settleWithin(operation, timeoutMs) {
  let timer;
  const pending = Promise.resolve()
    .then(operation)
    .catch(() => {});
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([pending, timeout]).finally(() => clearTimeout(timer));
}

function isDiscordUnavailableError(error) {
  return /RPC_CONNECTION_TIMEOUT|Could not connect|connection closed|ECONNREFUSED|ENOENT/i
    .test(String(error?.message || error));
}

function describeConnectionError(error) {
  const message = String(error?.message || error || "");
  if (/Could not connect|ECONNREFUSED|ENOENT/i.test(message)) {
    return "Discord não encontrado. Abra o Discord desktop e tente novamente.";
  }
  if (/RPC_CONNECTION_TIMEOUT/i.test(message)) {
    return "O Discord não respondeu a tempo. Tente novamente em instantes.";
  }
  if (/connection closed/i.test(message)) {
    return "O Discord encerrou a conexão. Confira se o Application ID está correto.";
  }
  if (isActivityValidationError(error)) {
    return `O Discord recusou a presence: ${message}`;
  }
  return message || "Não foi possível conectar.";
}

// Every connect/disconnect runs one at a time, so a manual click can never
// interleave with an automatic retry or with another click.
function enqueueConnection(task) {
  const run = connectionQueue.then(task);
  connectionQueue = run.then(() => undefined, () => undefined);
  return run;
}

function connect(config, options) {
  return enqueueConnection(() => connectNow(config, options));
}

function disconnect() {
  stopConnectRetries();
  return enqueueConnection(() => disconnectNow());
}

async function discardRpcClient() {
  const client = rpc;
  rpc = undefined;
  activeClientId = undefined;
  clearActivePresence();
  if (client) await settleWithin(() => client.destroy(), RPC_CLOSE_TIMEOUT_MS);
}

async function disconnectNow(options = {}) {
  const client = rpc;
  clearActivePresence();
  await settlePendingUpdates();
  // Detach before closing so the client's own "disconnected" event is ignored.
  rpc = undefined;
  activeClientId = undefined;

  if (client) {
    await settleWithin(() => client.clearActivity(), RPC_CLOSE_TIMEOUT_MS);
    await settleWithin(() => client.destroy(), RPC_CLOSE_TIMEOUT_MS);
  }
  if (!options.silent) sendStatus("offline", "Desconectado");
}

function stopConnectRetries() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = undefined;
  retryAttempt = 0;
  retryToken += 1;
  retryKind = undefined;
}

function retryEnabled(kind) {
  return kind === "reconnect" ? runtimeSettings.autoReconnect : runtimeSettings.autoStartPresence;
}

// Shared by the activation on startup and the reconnection after Discord
// closes: keep trying with growing intervals while Discord is unavailable.
function scheduleConnectRetries(kind, initialDelay, resolveTarget) {
  stopConnectRetries();
  if (!retryEnabled(kind)) return false;

  retryKind = kind;
  const token = retryToken;
  const label = kind === "reconnect" ? "Reconexão" : "Autoativação";

  const scheduleAttempt = (delay) => {
    retryTimer = setTimeout(async () => {
      retryTimer = undefined;
      if (token !== retryToken || isQuitting || !retryEnabled(kind)) return;

      retryAttempt += 1;
      sendStatus("connecting", kind === "reconnect"
        ? `Reconectando ao Discord - tentativa ${retryAttempt}`
        : `Aguardando o Discord - tentativa ${retryAttempt}`);

      try {
        const target = resolveTarget();
        await connect(target.config, { startTimestamp: target.startTimestamp });
        if (token === retryToken) {
          retryAttempt = 0;
          retryKind = undefined;
        }
      } catch (error) {
        if (token !== retryToken || isQuitting || !retryEnabled(kind)) return;

        if (!isDiscordUnavailableError(error)) {
          retryKind = undefined;
          sendStatus("error", `${label}: ${describeConnectionError(error)}`);
          return;
        }

        const retryDelay = RETRY_DELAYS_MS[Math.min(retryAttempt - 1, RETRY_DELAYS_MS.length - 1)];
        sendStatus("connecting", `Discord indisponível. Nova tentativa em ${retryDelay / 1000}s`);
        scheduleAttempt(retryDelay);
      }
    }, delay);
    retryTimer.unref?.();
  };

  scheduleAttempt(initialDelay);
  return true;
}

function scheduleAutoStart(initialDelay = 8000) {
  scheduleConnectRetries("autostart", initialDelay, () => {
    const store = loadConfig();
    return { config: store.profiles[store.activeProfile].config };
  });
}

function handleClientDisconnected(client) {
  // A replaced or discarded client may still report its close later.
  if (rpc !== client) return;

  const target = activeConfig && !isQuitting
    ? { config: activeConfig, startTimestamp: activeStartTimestamp }
    : undefined;
  rpc = undefined;
  activeClientId = undefined;
  clearActivePresence();

  if (target && scheduleConnectRetries("reconnect", RECONNECT_FIRST_DELAY_MS, () => target)) {
    sendStatus("connecting", `Discord desconectado. Reconectando em ${RECONNECT_FIRST_DELAY_MS / 1000}s`);
    return;
  }
  sendStatus("offline", "Discord desconectado");
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

async function connectNow(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig);
  const clientId = config.clientId.trim();
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error("Informe um Application ID válido do Discord.");
  }

  const startTimestamp = config.showTimer ? (options.startTimestamp || new Date()) : undefined;
  // Validate before touching the connection: a bad field must not drop it.
  const activity = buildActivity(config, startTimestamp);

  stopPriorityLoop();
  resetMusicUpdates();
  await settlePendingUpdates();
  if (rpc && activeClientId !== clientId) await disconnectNow({ silent: true });

  if (!rpc) {
    sendStatus("connecting", "Conectando ao Discord...");
    const client = new DiscordRPC.Client({ transport: "ipc" });
    rpc = client;
    activeClientId = clientId;
    musicTypeSupported = true;
    musicArtSupported = true;
    client.on("disconnected", () => handleClientDisconnected(client));

    try {
      await client.login({ clientId });
    } catch (error) {
      if (rpc === client) await discardRpcClient();
      throw error;
    }
    if (rpc !== client) throw new Error("connection closed");
  }

  const client = rpc;
  try {
    await client.setActivity(activity);
  } catch (error) {
    if (rpc === client && activeConfig) {
      // The connection is fine and Discord still shows the previous activity:
      // keep it running instead of disconnecting.
      startPriorityLoop();
      maybeUpdateMusicPresence();
    } else if (rpc === client) {
      await discardRpcClient();
    }
    throw error;
  }

  // A reconnection scheduled while this call was running would bring back the
  // old configuration; this one is now the live presence.
  stopConnectRetries();
  activeConfig = config;
  activeStartTimestamp = startTimestamp;
  // The configured presence was just applied, which matches the fallback state;
  // the next media tick promotes it to the playing track.
  lastAppliedMusic = { signature: "fallback", artUrl: "", positionMs: 0, atMs: Date.now(), playing: false };
  startPriorityLoop();
  sendStatus("online", config.musicMode
    ? "Modo de mídia ativo - aguardando reprodução"
    : config.highPriority ? "Presence ativa - alta prioridade" : "Presence ativa");

  syncMediaWatcher();
  if (activeConfig.musicMode && latestMedia) maybeUpdateMusicPresence();
}

function openExternalLink(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw new Error("Link não permitido.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Link não permitido.");
  }
  return shell.openExternal(parsed.toString());
}

function profileFileFilters() {
  return [{ name: "Perfis do RickDev Presence Studio", extensions: ["json"] }];
}

async function exportProfiles() {
  const store = loadConfig();
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: "Exportar perfis",
    buttonLabel: "Exportar",
    defaultPath: path.join(app.getPath("documents"), "rickdev-presence-perfis.json"),
    filters: profileFileFilters()
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  writeJsonAtomic(filePath, buildProfilesExport(store, app.getVersion()));
  return { ok: true, filePath, count: store.profiles.length };
}

async function importProfiles() {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Importar perfis",
    buttonLabel: "Importar",
    properties: ["openFile"],
    filters: profileFileFilters()
  });
  if (canceled || !filePaths?.length) return { ok: false, canceled: true };

  const filePath = filePaths[0];
  if (fs.statSync(filePath).size > MAX_IMPORT_BYTES) {
    throw new Error("O arquivo é grande demais para ser um arquivo de perfis.");
  }
  const imported = parseProfilesImport(fs.readFileSync(filePath, "utf8"));

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    title: "Importar perfis",
    message: imported.count === 1
      ? "Substituir os perfis atuais pelo perfil do arquivo?"
      : `Substituir os perfis atuais pelos ${imported.count} perfis do arquivo?`,
    detail: "Os 5 perfis atuais serão substituídos. Para guardar uma cópia, exporte-os antes. "
      + "A presence ativa só muda quando você clicar em Atualizar presence.",
    buttons: ["Importar", "Cancelar"],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  });
  if (response !== 0) return { ok: false, canceled: true };

  const current = loadConfig();
  const normalized = saveConfig({
    ...current,
    activeProfile: imported.activeProfile,
    profiles: imported.profiles
  });
  return { ok: true, count: imported.count, store: { ...normalized, startupStatus } };
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
      nodeIntegration: false,
      sandbox: true
    }
  });

  // The window only ever shows the bundled page: links open in the browser and
  // dropped files or URLs never replace the app (and its preload API).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    Promise.resolve()
      .then(() => openExternalLink(url))
      .catch(() => {});
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
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

  ipcMain.handle("config:load", () => {
    const store = loadConfig();
    const corruptedBackup = corruptedConfigBackup;
    corruptedConfigBackup = undefined;
    return { ...store, startupStatus, presenceStatus: statusPayload(), corruptedBackup };
  });
  ipcMain.handle("link:open", (_event, url) => openExternalLink(url));
  ipcMain.handle("config:save", async (_event, config) => {
    const previous = runtimeSettings;
    const normalized = saveConfig(config);
    runtimeSettings = { ...normalized.settings };
    if (runtimeSettings.startWithWindows !== previous.startWithWindows) {
      startupStatus = await startupManager.configure(runtimeSettings.startWithWindows);
    }

    if (retryKind && !retryEnabled(retryKind)) {
      stopConnectRetries();
      if (!presenceConnected()) sendStatus("offline", "Desconectado");
    }

    // Turning the cover lookup off must take the cover out of Discord now.
    if (previous.musicCoverLookup && !runtimeSettings.musicCoverLookup && lastAppliedMusic?.artUrl) {
      maybeUpdateMusicPresence(true);
    }

    // A blacklist edit must reselect the media source right away.
    if (lastMediaPayload) handleMediaState(lastMediaPayload);

    return { ...normalized, startupStatus };
  });
  ipcMain.handle("profiles:export", async () => {
    try {
      return await exportProfiles();
    } catch (error) {
      return { ok: false, error: error.message || "Não foi possível exportar os perfis." };
    }
  });
  ipcMain.handle("profiles:import", async () => {
    try {
      return await importProfiles();
    } catch (error) {
      return { ok: false, error: error.message || "Não foi possível importar os perfis." };
    }
  });
  ipcMain.handle("application:lookup", (_event, clientId) => lookupApplication(clientId));
  ipcMain.handle("music:watch", (_event, enabled) => {
    rendererWatchingMusic = Boolean(enabled);
    syncMediaWatcher();
    broadcastMusicState(true);
  });
  ipcMain.handle("presence:connect", async (_event, config) => {
    stopConnectRetries();
    try {
      await connect(config);
      return { ok: true };
    } catch (error) {
      const message = describeConnectionError(error);
      if (presenceConnected()) sendStatus("online", "A presence anterior continua ativa");
      else sendStatus("error", message);
      return { ok: false, error: message };
    }
  });
  ipcMain.handle("presence:disconnect", () => disconnect());

  if (runtimeSettings.autoStartPresence) {
    scheduleAutoStart(launchedHidden ? 12000 : 3000);
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopConnectRetries();
  stopPriorityLoop();
  resetMusicUpdates();
  if (mediaWatcher) {
    mediaWatcher.stop();
    mediaWatcher = undefined;
  }
  const client = rpc;
  rpc = undefined;
  if (client) client.destroy().catch(() => {});
});

app.on("window-all-closed", () => {
  // Keep the process alive so the Discord presence remains active in the tray.
});

app.on("activate", () => {
  showWindow();
});
