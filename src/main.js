const { app, BrowserWindow, dialog, ipcMain, shell, Menu, Tray, net, powerMonitor } = require("electron");
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
  selectMediaSession
} = require("./media");
const { EMPTY_TRACK_INFO, fetchTrackInfo } = require("./artwork");
const { buildActivity, buildButtons, rotationIntervalMs, textVariants } = require("./activity");
const { trayMenuTemplate, trayTooltip } = require("./tray");
const { musicButton, playerInfo, usesMediaVariables } = require("./renderer/presence-format");
const {
  automationStep,
  initialAutomationState,
  listProcesses,
  matchingRule,
  needsProcessList
} = require("./automation");
const {
  cleanupDownloads,
  downloadUpdate,
  expectedSha256,
  launchUpdate,
  pickReleaseAsset,
  updateFileName
} = require("./updater");

// Discord only accepts a handful of activity updates per window (about five
// every 20 seconds), so media updates are spaced out and coalesced.
const MUSIC_UPDATE_SPACING_MS = 4000;
const SPLASH_MIN_VISIBLE_MS = 600;
const MAIN_WINDOW_FALLBACK_MS = 10000;
const SEEK_REAPPLY_MIN_MS = 5000;
const RPC_CLOSE_TIMEOUT_MS = 3000;
const RECONNECT_FIRST_DELAY_MS = 5000;
const RETRY_DELAYS_MS = [15 * 1000, 30 * 1000, 60 * 1000];
const TRACK_LOOKUP_RETRY_MS = 60 * 1000;
const TRACK_LOOKUP_MISS_MS = 30 * 60 * 1000;
const AWAY_CHECK_INTERVAL_MS = 15 * 1000;
const TRAY_REFRESH_INTERVAL_MS = 60 * 1000;
const APP_ICON_TTL_MS = 60 * 60 * 1000;
const APP_ICON_RETRY_MS = 5 * 60 * 1000;
const APP_ICON_WAIT_MS = 1500;
const APP_ICON_PREFIX = "https://cdn.discordapp.com/app-icons/";
const DYNAMIC_CHECK_INTERVAL_MS = 10 * 1000;
const DYNAMIC_REFRESH_SPACING_MS = 5000;
const AUTOMATION_CHECK_INTERVAL_MS = 10 * 1000;
const UPDATE_PROGRESS_SPACING_MS = 150;

let mainWindow;
let splashWindow;
let splashShownAt = 0;
let tray;
let rpc;
let activeClientId;
let activeConfig;
let activeStartTimestamp;
let activeProfileName = "";
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
let activityTypeSupported = true;
let rotationTimer;
let rotationIndex = 0;
let rotationAt = 0;
let awayState;
let awayCheckRunning = false;
let screenLocked = false;
let musicArtSupported = true;
let appIconSupported = true;
let playerIconSupported = true;
let activityNameSupported = true;
let lastConfiguredActivity = "";
let dynamicRefreshTimer;
let lastDynamicRefreshAt = 0;
let automation = initialAutomationState();
let automationRunning = false;
let availableUpdate;
let updateInstalling = false;
let launchedAfterUpdate = process.argv.includes("--updated");
let liveProfile;
let trayProfileNames = [];
let trayMenuSignature = "";
let trayTooltipText = "";
const trackInfoCache = new Map();
const applicationCache = new Map();
const applicationIcons = new Map();
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

function cachedApplicationIcon(clientId) {
  if (!appIconSupported) return "";
  return applicationIcons.get(String(clientId || "").trim())?.url || "";
}

async function resolveApplicationIcon(clientId) {
  const id = String(clientId || "").trim();
  const cached = applicationIcons.get(id);
  if (cached && Date.now() - cached.at < (cached.url ? APP_ICON_TTL_MS : APP_ICON_RETRY_MS)) return cached.url;

  let url = "";
  try {
    url = (await lookupApplication(id)).iconUrl || "";
  } catch {
    url = cached?.url || "";
  }
  applicationIcons.set(id, { url, at: Date.now() });
  return url;
}

function isApplicationIcon(value) {
  return String(value || "").startsWith(APP_ICON_PREFIX);
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

    const version = String(release.tag_name || "").replace(/^v/i, "");
    const asset = pickReleaseAsset(release);
    const sha256 = expectedSha256(release, asset);
    availableUpdate = asset && sha256
      ? { version, url: asset.browser_download_url, size: Number(asset.size), sha256 }
      : undefined;

    const update = {
      currentVersion: app.getVersion(),
      version,
      name: release.name || `RickDev Presence Studio ${release.tag_name}`,
      notes: String(release.body || "Esta versão não possui notas de lançamento.").slice(0, 20000),
      url: /^https:\/\/github\.com\//i.test(release.html_url || "")
        ? release.html_url
        : `https://github.com/${githubRepository}/releases/latest`,
      canInstall: Boolean(availableUpdate && updateInstallSupported())
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

// Only the packaged portable build knows which file to replace.
function updateInstallSupported() {
  return app.isPackaged && process.platform === "win32" && Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
}

function updatesDirectory() {
  return path.join(startupManager.directory(), "updates");
}

function sendUpdateProgress(progress) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("update:progress", progress);
}

async function installUpdate() {
  if (updateInstalling) return { ok: false, error: "A atualização já está sendo baixada." };
  if (!availableUpdate || !updateInstallSupported()) {
    return { ok: false, error: "Esta versão não pode ser atualizada por aqui. Baixe pelo GitHub." };
  }

  updateInstalling = true;
  const update = availableUpdate;
  let lastProgressAt = 0;
  try {
    const target = path.join(updatesDirectory(), updateFileName(update.version));
    await downloadUpdate({
      ...update,
      target,
      fetch: (url, init) => net.fetch(url, init),
      onProgress: (progress) => {
        const now = Date.now();
        if (now - lastProgressAt < UPDATE_PROGRESS_SPACING_MS && progress.received < progress.total) return;
        lastProgressAt = now;
        sendUpdateProgress({ ...progress, stage: "download" });
      }
    });

    sendUpdateProgress({ received: update.size, total: update.size, stage: "restart" });
    launchUpdate({
      source: target,
      target: process.env.PORTABLE_EXECUTABLE_FILE,
      resume: presenceConnected() || Boolean(awayState)
    });
    setTimeout(() => app.quit(), 400);
    return { ok: true };
  } catch (error) {
    updateInstalling = false;
    return { ok: false, error: error.message || "Não foi possível atualizar." };
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

function currentText() {
  if (!activeConfig || awayState) return undefined;
  const variants = textVariants(activeConfig);
  if (variants.length < 2) return undefined;
  return { slot: variants[rotationIndex % variants.length].slot, since: rotationAt };
}

function statusPayload() {
  const connected = presenceConnected();
  return {
    ...lastStatus,
    connected,
    startedAt: connected ? activeStartTimestamp?.getTime() : undefined,
    text: connected ? currentText() : undefined,
    liveProfile: connected ? liveProfile?.index : undefined
  };
}

function sendStatus(status, message) {
  lastStatus = { status, message };
  refreshTray();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("presence:status", statusPayload());
}

function playingMedia() {
  return latestPresentation.mode === "music" && latestMedia?.active ? latestMedia : undefined;
}

function configuredActivity(
  config = activeConfig,
  startTimestamp = activeStartTimestamp,
  variant = rotationIndex,
  profileName = activeProfileName
) {
  return buildActivity(config, {
    startTimestamp,
    variant,
    includeType: activityTypeSupported,
    appIcon: cachedApplicationIcon(config.clientId),
    context: { profileName, media: playingMedia() }
  });
}

async function sendConfiguredActivity(activity = configuredActivity()) {
  await sendActivity(activity);
  lastConfiguredActivity = JSON.stringify(activity);
}

function presenceHidden() {
  return awayState?.mode === "hide";
}

function activeStatusMessage() {
  if (awayState) {
    return awayState.mode === "hide"
      ? "Ausente - presence oculta"
      : `Ausente - perfil ${awayState.profileName}`;
  }
  if (automation.applied !== undefined && liveProfile?.index === automation.applied) {
    return `Automação: perfil ${activeProfileName || automation.applied + 1} ativo`;
  }
  if (activeConfig?.musicMode) return "Modo de mídia ativo - aguardando reprodução";
  return activeConfig?.highPriority ? "Presence ativa - alta prioridade" : "Presence ativa";
}

function trackArtKey(media) {
  return `${media.artist}|${media.title}`.toLowerCase();
}

function lookupTrackInfo(media) {
  const key = trackArtKey(media);
  const cached = trackInfoCache.get(key);
  if (cached?.info) return Promise.resolve(cached.info);
  if (cached?.pending) return cached.pending;
  if (cached && cached.emptyUntil > Date.now()) return Promise.resolve(EMPTY_TRACK_INFO);

  if (trackInfoCache.size > 120) trackInfoCache.delete(trackInfoCache.keys().next().value);
  const pending = fetchTrackInfo(media, {
    fetch: (url, init) => net.fetch(url, init),
    country: app.getLocaleCountryCode()
  })
    .catch(() => ({ ...EMPTY_TRACK_INFO, failed: true }))
    .then(({ artUrl, album, failed }) => {
      const info = { artUrl, album };
      trackInfoCache.set(key, artUrl || album
        ? { info }
        : { emptyUntil: Date.now() + (failed ? TRACK_LOOKUP_RETRY_MS : TRACK_LOOKUP_MISS_MS) });
      return info;
    });
  trackInfoCache.set(key, { pending });
  return pending;
}

function cachedTrackInfo(media) {
  return trackInfoCache.get(trackArtKey(media))?.info || EMPTY_TRACK_INFO;
}

// The user can turn the cover lookup off (it sends title and artist to Apple
// and Deezer); musicArtSupported tracks whether this Discord client accepts
// image URLs.
function coverLookupAllowed() {
  return runtimeSettings.musicCoverLookup !== false;
}

function trackLookupExtras(media, info) {
  return {
    artUrl: musicArtSupported ? info.artUrl : "",
    album: media.album ? "" : info.album
  };
}

function videoApps() {
  return new Set((runtimeSettings.musicVideoApps || []).map((app) => app.toLowerCase()));
}

function trackLinks(info) {
  return info.trackUrl && info.service ? { [info.service]: info.trackUrl } : {};
}

function broadcastMusicState(force = false) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const media = latestMedia?.active ? latestMedia : undefined;
  const info = media && coverLookupAllowed() && !media.video ? cachedTrackInfo(media) : EMPTY_TRACK_INFO;
  const artUrl = info.artUrl;
  const album = media?.album || info.album;

  const ignoredApps = new Set((runtimeSettings.musicIgnoredApps || []).map((app) => app.toLowerCase()));
  const markedVideo = videoApps();
  const sources = (lastMediaPayload?.sessions || []).map((session) => ({
    app: session.app,
    player: session.player,
    title: session.title,
    playing: session.playing,
    ignored: ignoredApps.has(session.app.toLowerCase()),
    video: markedVideo.has(session.app.toLowerCase()),
    reportedVideo: session.video
  }));

  // The watcher ticks every 1.5s even when nothing changed; only wake the
  // renderer for real changes (it extrapolates the progress bar locally).
  const now = Date.now();
  const signature = [
    Boolean(mediaWatcher), musicWatcherError, latestPresentation.mode, latestPresentation.paused,
    media?.title, media?.artist, album, media?.playing, media?.durationMs, artUrl, media?.video,
    info.trackUrl, JSON.stringify(sources)
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
    media: media ? { ...media, album, artUrl, links: trackLinks(info) } : undefined
  });
}

function handleMediaState(payload) {
  lastMediaPayload = payload;
  const selected = selectMediaSession(payload, runtimeSettings.musicIgnoredApps);
  const state = selected.active && !selected.video && videoApps().has(selected.app.toLowerCase())
    ? { ...selected, video: true }
    : selected;
  latestMedia = state;
  if (state.active && state.playing) lastPlayingAt = Date.now();
  latestPresentation = derivePresentation(state, lastPlayingAt);
  broadcastMusicState();

  if (state.active && coverLookupAllowed() && !state.video) {
    const key = trackArtKey(state);
    lookupTrackInfo(state).then((info) => {
      if (!coverLookupAllowed() || !latestMedia?.active || trackArtKey(latestMedia) !== key) return;
      if (!info.artUrl && !info.album) return;
      broadcastMusicState();
      // A cover that resolved after the presence was applied does not change
      // the signature; force one reapply so Discord picks it up.
      const extras = trackLookupExtras(latestMedia, info);
      if ((extras.artUrl || extras.album) && lastAppliedMusic && !lastAppliedMusic.lookup
        && lastAppliedMusic.signature !== "fallback") {
        maybeUpdateMusicPresence(true);
      }
    });
  }

  maybeUpdateMusicPresence();
  if (activeConfig && usesMediaVariables(activeConfig)) checkDynamicPresence();
}

function shouldWatchMedia() {
  // The preview-only leg stops when the window hides to the tray; the
  // connected leg keeps the watcher alive for the presence itself.
  const windowVisible = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible());
  return (rendererWatchingMusic && windowVisible)
    || Boolean(rpc && activeConfig && (activeConfig.musicMode || usesMediaVariables(activeConfig)));
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

// Older Discord clients reject the activity type or external image URLs;
// degrade one feature at a time and remember what this session supports.
// Discord's validation errors name the failing field, so blame the cover
// first when the message points at the assets instead of burning the type.
function withoutAsset(activity, ...keys) {
  const next = { ...activity, assets: { ...activity.assets } };
  for (const key of keys) delete next.assets[key];
  if (!Object.keys(next.assets).length) delete next.assets;
  return next;
}

async function sendActivity(activity, { artUrl = "", fallbackImage = "", playerIcon = "" } = {}) {
  let current = activity;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await setRawActivity(current);
      return;
    } catch (error) {
      if (!isActivityValidationError(error)) throw error;

      const message = String(error?.message || error);
      const carriesPlayerIcon = Boolean(playerIcon) && current.assets?.small_image === playerIcon;
      if (carriesPlayerIcon && /small/i.test(message)) {
        playerIconSupported = false;
        current = withoutAsset(current, "small_image", "small_text");
        continue;
      }

      if (isApplicationIcon(current.assets?.large_image) && /assets|image/i.test(message)) {
        appIconSupported = false;
        current = { ...current, assets: { ...current.assets } };
        delete current.assets.large_image;
        if (!Object.keys(current.assets).length) delete current.assets;
        continue;
      }

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

      if (current.name !== undefined && /\bname\b/i.test(message)) {
        activityNameSupported = false;
        current = { ...current };
        delete current.name;
        continue;
      }

      if (current.type !== undefined && !/assets|image|button/i.test(message)) {
        activityTypeSupported = false;
        current = { ...current };
        delete current.type;
        continue;
      }

      if (carriesPlayerIcon && /assets|image/i.test(message)) {
        playerIconSupported = false;
        current = withoutAsset(current, "small_image", "small_text");
        continue;
      }

      throw error;
    }
  }

  throw new Error("O Discord rejeitou a presence.");
}

async function applyMusicPresence(signature) {
  const media = latestMedia;
  const presentation = latestPresentation;

  if (presentation.mode === "music" && media?.active) {
    const info = coverLookupAllowed() && !media.video ? await lookupTrackInfo(media) : EMPTY_TRACK_INFO;
    if (!rpc || !activeConfig?.musicMode) return;

    if (musicTrackKey !== trackArtKey(media)) {
      musicTrackKey = trackArtKey(media);
      musicTrackStartedAt = Date.now();
    }

    const extras = trackLookupExtras(media, info);
    const appIcon = cachedApplicationIcon(activeConfig.clientId);
    const player = activeConfig.musicPlayerIcon && playerIconSupported ? playerInfo(media.player || media.app) : undefined;
    const activityName = activeConfig.musicPlayerName && activityNameSupported
      ? playerInfo(media.player || media.app)?.name || ""
      : "";
    const listenButton = media.video
      ? undefined
      : musicButton(activeConfig.musicButton, media, { app: media.player || media.app, links: trackLinks(info) });
    const activity = buildMusicActivity(activeConfig, { ...media, album: media.album || extras.album }, {
      paused: presentation.paused,
      artUrl: extras.artUrl,
      appIcon,
      playerIcon: player,
      activityName,
      buttons: [listenButton, ...buildButtons(activeConfig)].filter(Boolean).slice(0, 2),
      includeType: activityTypeSupported,
      context: { profileName: activeProfileName },
      now: Date.now(),
      fallbackStart: musicTrackStartedAt
    });

    await sendActivity(activity, {
      artUrl: extras.artUrl,
      fallbackImage: activeConfig.largeImageKey.trim() || appIcon,
      playerIcon: player?.icon
    });
    lastAppliedMusic = {
      signature,
      lookup: Boolean(extras.artUrl || extras.album),
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
  await sendConfiguredActivity();
  lastAppliedMusic = { signature, lookup: false, positionMs: 0, atMs: Date.now(), playing: false };
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
  if (!rpc || !activeConfig?.musicMode || isQuitting || presenceHidden()) return;

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
  if (!rpc || !activeConfig?.musicMode || isQuitting || presenceHidden()) return;

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

function stopRotation() {
  if (rotationTimer) clearInterval(rotationTimer);
  rotationTimer = undefined;
}

function startRotation() {
  stopRotation();
  if (!activeConfig || textVariants(activeConfig).length < 2) return;

  rotationTimer = setInterval(() => {
    if (!activeConfig || presenceHidden()) return;
    if (activeConfig.musicMode && latestPresentation.mode === "music") return;
    rotationIndex = (rotationIndex + 1) % textVariants(activeConfig).length;
    rotationAt = Date.now();
    refreshConfiguredPresence();
  }, rotationIntervalMs(activeConfig));
  rotationTimer.unref();
}

function stopDynamicRefresh() {
  if (dynamicRefreshTimer) clearTimeout(dynamicRefreshTimer);
  dynamicRefreshTimer = undefined;
}

function clearActivePresence() {
  stopPriorityLoop();
  stopRotation();
  stopDynamicRefresh();
  resetMusicUpdates();
  activeConfig = undefined;
  activeStartTimestamp = undefined;
  activeProfileName = "";
  lastAppliedMusic = undefined;
  lastConfiguredActivity = "";
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
  awayState = undefined;
  liveProfile = undefined;
  automation = initialAutomationState();
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
  if (kind === "resume") return true;
  return kind === "reconnect" ? runtimeSettings.autoReconnect : runtimeSettings.autoStartPresence;
}

// Shared by the activation on startup and the reconnection after Discord
// closes: keep trying with growing intervals while Discord is unavailable.
function scheduleConnectRetries(kind, initialDelay, resolveTarget) {
  stopConnectRetries();
  if (!retryEnabled(kind)) return false;

  retryKind = kind;
  const token = retryToken;
  const label = { reconnect: "Reconexão", resume: "Reativação" }[kind] || "Autoativação";

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
        await connect(target.config, { startTimestamp: target.startTimestamp, profileName: target.profileName });
        if (target.profileIndex !== undefined) setLiveProfile(target.profileIndex);
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

function selectedProfileTarget() {
  const store = loadConfig();
  const profile = store.profiles[store.activeProfile];
  return { config: profile.config, profileName: profile.name, profileIndex: store.activeProfile };
}

function scheduleAutoStart(initialDelay = 8000, kind = "autostart") {
  scheduleConnectRetries(kind, initialDelay, selectedProfileTarget);
}

function handleClientDisconnected(client) {
  // A replaced or discarded client may still report its close later.
  if (rpc !== client) return;

  const base = awayState?.previous
    || { config: activeConfig, startTimestamp: activeStartTimestamp, profileName: activeProfileName };
  const target = base.config && !isQuitting ? base : undefined;
  awayState = undefined;
  rpc = undefined;
  activeClientId = undefined;
  clearActivePresence();

  if (target && scheduleConnectRetries("reconnect", RECONNECT_FIRST_DELAY_MS, () => target)) {
    sendStatus("connecting", `Discord desconectado. Reconectando em ${RECONNECT_FIRST_DELAY_MS / 1000}s`);
    return;
  }
  sendStatus("offline", "Discord desconectado");
}

async function refreshConfiguredPresence() {
  if (!rpc || !activeConfig || priorityUpdatePromise || presenceHidden()) return;

  if (activeConfig.musicMode) {
    maybeUpdateMusicPresence(true);
    return;
  }

  try {
    priorityUpdatePromise = sendConfiguredActivity();
    await priorityUpdatePromise;
    sendStatus("online", activeStatusMessage());
  } catch (error) {
    sendStatus("error", error.message || "Falha ao reaplicar a presence.");
  } finally {
    priorityUpdatePromise = undefined;
  }
}

// Clock variables, the "since"/"until" timer and the playing track change
// the configured activity without any user action; resend only on a change.
function checkDynamicPresence() {
  if (!rpc || !activeConfig || presenceHidden() || isQuitting) return;
  if (activeConfig.musicMode && latestPresentation.mode === "music") return;
  if (!lastConfiguredActivity) return;

  let next;
  try {
    next = JSON.stringify(configuredActivity());
  } catch {
    return;
  }
  if (next === lastConfiguredActivity || dynamicRefreshTimer) return;

  const wait = Math.max(0, lastDynamicRefreshAt + DYNAMIC_REFRESH_SPACING_MS - Date.now());
  dynamicRefreshTimer = setTimeout(() => {
    dynamicRefreshTimer = undefined;
    lastDynamicRefreshAt = Date.now();
    refreshConfiguredPresence();
  }, wait);
}

function startPriorityLoop() {
  stopPriorityLoop();
  if (!activeConfig?.highPriority) return;

  priorityInterval = setInterval(refreshConfiguredPresence, 60 * 1000);
  priorityInterval.unref();
}

async function connectNow(rawConfig, options = {}) {
  const config = normalizeConfig(rawConfig);
  const clientId = config.clientId.trim();
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error("Informe um Application ID válido do Discord.");
  }

  const startTimestamp = config.showTimer ? (options.startTimestamp || new Date()) : undefined;
  const profileName = String(options.profileName || "");
  // Validate before touching the connection: a bad field must not drop it.
  configuredActivity(config, startTimestamp, 0, profileName);
  const iconLookup = resolveApplicationIcon(clientId);

  stopPriorityLoop();
  stopRotation();
  resetMusicUpdates();
  await settlePendingUpdates();
  if (rpc && activeClientId !== clientId) await disconnectNow({ silent: true });

  if (!rpc) {
    sendStatus("connecting", "Conectando ao Discord...");
    const client = new DiscordRPC.Client({ transport: "ipc" });
    rpc = client;
    activeClientId = clientId;
    activityTypeSupported = true;
    musicArtSupported = true;
    appIconSupported = true;
    playerIconSupported = true;
    activityNameSupported = true;
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
  await Promise.race([iconLookup, new Promise((resolve) => setTimeout(resolve, APP_ICON_WAIT_MS))]);
  const sentIcon = cachedApplicationIcon(clientId);
  const firstActivity = configuredActivity(config, startTimestamp, 0, profileName);
  try {
    await sendActivity(firstActivity);
  } catch (error) {
    if (rpc === client && activeConfig) {
      // The connection is fine and Discord still shows the previous activity:
      // keep it running instead of disconnecting.
      startPriorityLoop();
      startRotation();
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
  activeProfileName = profileName;
  lastConfiguredActivity = JSON.stringify(firstActivity);
  rotationIndex = 0;
  rotationAt = Date.now();
  // The configured presence was just applied, which matches the fallback state;
  // the next media tick promotes it to the playing track.
  lastAppliedMusic = { signature: "fallback", lookup: false, positionMs: 0, atMs: Date.now(), playing: false };
  startPriorityLoop();
  startRotation();
  sendStatus("online", activeStatusMessage());

  syncMediaWatcher();
  if (activeConfig.musicMode && latestMedia) maybeUpdateMusicPresence();

  iconLookup.then(() => {
    const icon = cachedApplicationIcon(clientId);
    if (activeConfig === config && icon && icon !== sentIcon) refreshConfiguredPresence();
  });
}

function awaySettings() {
  const action = runtimeSettings.awayAction || "off";
  const profileMatch = /^profile-(\d+)$/.exec(action);
  return {
    mode: action === "hide" ? "hide" : profileMatch ? "profile" : "off",
    profileIndex: profileMatch ? Number(profileMatch[1]) : -1,
    seconds: (runtimeSettings.awayMinutes || 10) * 60
  };
}

function systemIdle(seconds) {
  if (screenLocked) return true;
  try {
    const state = powerMonitor.getSystemIdleState(seconds);
    return state === "idle" || state === "locked";
  } catch {
    return false;
  }
}

function mediaKeepsPresence() {
  const config = awayState?.previous.config || activeConfig;
  return Boolean(config?.musicMode && latestPresentation.mode === "music");
}

async function enterAway(settings) {
  const previous = { config: activeConfig, startTimestamp: activeStartTimestamp, profileName: activeProfileName };

  if (settings.mode === "hide") {
    awayState = { mode: "hide", previous };
    await enqueueConnection(async () => {
      stopPriorityLoop();
      stopRotation();
      resetMusicUpdates();
      await settlePendingUpdates();
      if (rpc && presenceHidden()) await settleWithin(() => rpc.clearActivity(), RPC_CLOSE_TIMEOUT_MS);
    });
    if (presenceHidden()) sendStatus("online", activeStatusMessage());
    return;
  }

  const profile = loadConfig().profiles[settings.profileIndex];
  if (!profile) return;
  const config = {
    ...profile.config,
    musicMode: false,
    clientId: profile.config.clientId.trim() || activeConfig.clientId
  };
  awayState = { mode: "profile", profileName: profile.name, previous };

  try {
    await connect(config, { profileName: profile.name });
  } catch (error) {
    if (awayState?.previous !== previous) return;
    awayState = undefined;
    sendStatus("error", `Ausente: ${describeConnectionError(error)}`);
    if (!presenceConnected()) {
      connect(previous.config, { startTimestamp: previous.startTimestamp, profileName: previous.profileName })
        .catch(() => {});
    }
  }
}

async function leaveAway() {
  const { previous } = awayState;
  awayState = undefined;
  try {
    await connect(previous.config, { startTimestamp: previous.startTimestamp, profileName: previous.profileName });
  } catch (error) {
    sendStatus("error", describeConnectionError(error));
  }
}

async function checkAway() {
  if (awayCheckRunning || isQuitting) return;
  awayCheckRunning = true;

  try {
    const settings = awaySettings();
    const away = presenceConnected()
      && settings.mode !== "off"
      && systemIdle(settings.seconds)
      && !mediaKeepsPresence();

    if (away && !awayState) await enterAway(settings);
    else if (!away && awayState) await leaveAway();
  } finally {
    awayCheckRunning = false;
  }
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
  rememberProfileNames(normalized);
  return { ok: true, count: imported.count, store: { ...normalized, startupStatus } };
}

function createSplash() {
  splashWindow = new BrowserWindow({
    show: false,
    width: 480,
    height: 270,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    center: true,
    title: "RickDev Presence Studio",
    backgroundColor: "#141415",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  splashWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  splashWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  splashWindow.once("ready-to-show", () => {
    if (!splashWindow || splashWindow.isDestroyed()) return;
    splashWindow.show();
    splashShownAt = Date.now();
  });
  splashWindow.on("closed", () => {
    splashWindow = undefined;
  });
  splashWindow.loadFile(path.join(__dirname, "renderer", "splash.html"));
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = undefined;
}

function revealMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
  const remaining = splashShownAt ? SPLASH_MIN_VISIBLE_MS - (Date.now() - splashShownAt) : 0;
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  }, Math.max(0, remaining));
}

function createWindow(show = true) {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#141415",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0f0f10",
      symbolColor: "#a1a1a6",
      height: 40
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

  if (show) setTimeout(revealMainWindow, MAIN_WINDOW_FALLBACK_MS).unref();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.webContents.once("did-finish-load", scheduleUpdateCheck);

  mainWindow.on("hide", () => syncMediaWatcher());
  mainWindow.on("show", () => {
    closeSplash();
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

function rememberProfileNames(store) {
  trayProfileNames = store.profiles.map((profile) => profile.name);
  refreshTray();
}

function setLiveProfile(index) {
  liveProfile = { index, since: Date.now() };
  refreshTray();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("presence:status", statusPayload());
}

function trayState() {
  const connected = presenceConnected();
  return {
    names: trayProfileNames,
    connected,
    connecting: !connected && (Boolean(retryKind) || lastStatus.status === "connecting"),
    liveIndex: liveProfile?.index,
    since: liveProfile?.since,
    away: awayState && { mode: awayState.mode, profileName: awayState.profileName }
  };
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;

  const state = trayState();
  const template = trayMenuTemplate(state, {
    selectProfile: activateProfile,
    activate: () => activateProfile(loadConfig().activeProfile),
    disconnect: () => disconnect().catch(() => {}),
    open: showWindow,
    quit: () => app.quit()
  });
  const signature = JSON.stringify(template);
  if (signature !== trayMenuSignature) {
    trayMenuSignature = signature;
    tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  const tooltip = trayTooltip(state);
  if (tooltip !== trayTooltipText) {
    trayTooltipText = tooltip;
    tray.setToolTip(tooltip);
  }
}

// A choice made by hand wins over the automation until its rules change.
function markManualChoice() {
  automation = { ...automation, seed: true, applied: undefined, base: undefined };
}

// The automation switches what Discord shows without changing the profile
// selected in the editor, so it never interrupts an edit or the next startup.
async function activateProfile(index, { source = "tray" } = {}) {
  const store = loadConfig();
  const profile = store.profiles[index];
  if (!profile) return false;

  const automatic = source === "automation";
  if (!automatic) markManualChoice();
  stopConnectRetries();
  awayState = undefined;
  try {
    await connect(profile.config, { profileName: profile.name });
  } catch (error) {
    const message = describeConnectionError(error);
    if (presenceConnected()) sendStatus(automatic ? "error" : "online", automatic
      ? `Automação: não foi possível ativar ${profile.name}`
      : "A presence anterior continua ativa");
    else sendStatus("error", message);
    if (!automatic) {
      tray.displayBalloon({ iconType: "warning", title: `Não foi possível ativar ${profile.name}`, content: message });
    }
    return false;
  }

  setLiveProfile(index);
  if (!automatic && store.activeProfile !== index) saveConfig({ ...store, activeProfile: index });
  if (automatic) sendStatus("online", activeStatusMessage());
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("profiles:selected", { index, source, name: profile.name });
  }
  return true;
}

async function checkAutomation() {
  if (automationRunning || isQuitting) return;
  const rules = runtimeSettings.automationRules || [];
  if (!rules.some((rule) => rule.enabled)) {
    automation = initialAutomationState();
    return;
  }
  if (!presenceConnected() || awayState || retryKind) return;

  automationRunning = true;
  try {
    const processes = needsProcessList(rules) ? await listProcesses() : new Set();
    if (!processes || !presenceConnected() || awayState || retryKind) return;

    const { state, action } = automationStep(automation, matchingRule(rules, { now: new Date(), processes }), liveProfile?.index);
    automation = state;
    if (action) await activateProfile(action.profile, { source: "automation" });
  } finally {
    automationRunning = false;
  }
}

function createTray() {
  tray = new Tray(path.join(__dirname, "..", "build", "icon.png"));
  refreshTray();
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
  if (!launchedHidden) createSplash();
  runtimeSettings = { ...startupStore.settings };
  startupStatus = await startupManager.configure(runtimeSettings.startWithWindows);

  createWindow(!launchedHidden);
  createTray();
  rememberProfileNames(startupStore);
  trayNoticeShown = launchedHidden;

  ipcMain.handle("config:load", () => {
    const store = loadConfig();
    const corruptedBackup = corruptedConfigBackup;
    corruptedConfigBackup = undefined;
    const updated = launchedAfterUpdate;
    launchedAfterUpdate = false;
    return {
      ...store,
      startupStatus,
      presenceStatus: statusPayload(),
      corruptedBackup,
      appVersion: app.getVersion(),
      updated
    };
  });
  ipcMain.handle("link:open", (_event, url) => openExternalLink(url));
  ipcMain.on("ui:ready", (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents) revealMainWindow();
  });
  ipcMain.handle("config:save", async (_event, config) => {
    const previous = runtimeSettings;
    const normalized = saveConfig(config);
    runtimeSettings = { ...normalized.settings };
    rememberProfileNames(normalized);
    if (runtimeSettings.startWithWindows !== previous.startWithWindows) {
      startupStatus = await startupManager.configure(runtimeSettings.startWithWindows);
    }

    if (retryKind && !retryEnabled(retryKind)) {
      stopConnectRetries();
      if (!presenceConnected()) sendStatus("offline", "Desconectado");
    }

    // Turning the cover lookup off must take the cover and album out of Discord now.
    if (previous.musicCoverLookup && !runtimeSettings.musicCoverLookup && lastAppliedMusic?.lookup) {
      maybeUpdateMusicPresence(true);
    }

    // A blacklist edit must reselect the media source right away.
    if (lastMediaPayload) handleMediaState(lastMediaPayload);

    if (previous.awayAction !== runtimeSettings.awayAction || previous.awayMinutes !== runtimeSettings.awayMinutes) {
      checkAway();
    }

    if (JSON.stringify(previous.automationRules) !== JSON.stringify(runtimeSettings.automationRules)) {
      checkAutomation();
    }

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
    awayState = undefined;
    markManualChoice();
    try {
      const store = loadConfig();
      await connect(config, { profileName: store.profiles[store.activeProfile].name });
      setLiveProfile(store.activeProfile);
      return { ok: true };
    } catch (error) {
      const message = describeConnectionError(error);
      if (presenceConnected()) sendStatus("online", "A presence anterior continua ativa");
      else sendStatus("error", message);
      return { ok: false, error: message };
    }
  });
  ipcMain.handle("presence:disconnect", () => disconnect());
  ipcMain.handle("automation:processes", async () => [...(await listProcesses()) || []].sort());
  ipcMain.handle("update:install", () => installUpdate());

  setInterval(checkAway, AWAY_CHECK_INTERVAL_MS).unref();
  setInterval(refreshTray, TRAY_REFRESH_INTERVAL_MS).unref();
  setInterval(checkDynamicPresence, DYNAMIC_CHECK_INTERVAL_MS).unref();
  setInterval(checkAutomation, AUTOMATION_CHECK_INTERVAL_MS).unref();
  powerMonitor.on("lock-screen", () => {
    screenLocked = true;
    checkAway();
  });
  powerMonitor.on("unlock-screen", () => {
    screenLocked = false;
    checkAway();
  });

  if (process.argv.includes("--resume")) {
    scheduleAutoStart(3000, "resume");
  } else if (runtimeSettings.autoStartPresence) {
    scheduleAutoStart(launchedHidden ? 12000 : 3000);
  }

  if (app.isPackaged) {
    const cleanup = setTimeout(() => cleanupDownloads(updatesDirectory(), process.env.PORTABLE_EXECUTABLE_FILE), 20000);
    cleanup.unref();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopConnectRetries();
  stopPriorityLoop();
  stopRotation();
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
