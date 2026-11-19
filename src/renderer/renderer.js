const form = document.querySelector("#presenceForm");
const mediaTab = document.querySelector("#tabMedia");
const fields = [...document.querySelectorAll("#presenceForm input[name], #presenceForm select[name], #tabMedia input[name], #tabMedia select[name]")];
const statusPill = document.querySelector("#statusPill");
const statusText = document.querySelector("#statusText");
const connectButton = document.querySelector("#connectButton");
const disconnectButton = document.querySelector("#disconnectButton");
const profileName = document.querySelector("#profileName");
const profileTabs = [...document.querySelectorAll("#profileTabs button")];
const importProfilesButton = document.querySelector("#importProfilesButton");
const exportProfilesButton = document.querySelector("#exportProfilesButton");
const startWithWindows = document.querySelector("#startWithWindows");
const autoStartPresence = document.querySelector("#autoStartPresence");
const autoReconnect = document.querySelector("#autoReconnect");
const musicCoverLookup = document.querySelector("#musicCoverLookup");
const awayAction = document.querySelector("#awayAction");
const awayMinutes = document.querySelector("#awayMinutes");
const rotationFields = document.querySelector("#rotationFields");
const imageRotationFields = document.querySelector("#imageRotationFields");
const startupStatus = document.querySelector("#startupStatus");
const settingsButton = document.querySelector("#settingsButton");
const settingsModal = document.querySelector("#settingsModal");
const updateModal = document.querySelector("#updateModal");
const updateTitle = document.querySelector("#updateTitle");
const updateVersion = document.querySelector("#updateVersion");
const updateNotes = document.querySelector("#updateNotes");
const toast = document.querySelector("#toast");
const appVersion = document.querySelector("#appVersion");
const timerFields = document.querySelector("#timerFields");
const musicPlayerIconLargeRow = document.querySelector("#musicPlayerIconLargeRow");
const checkUpdateButton = document.querySelector("#checkUpdateButton");
const timerTimeField = document.querySelector("#timerTimeField");
const timerModeInfo = document.querySelector("#timerModeInfo");
const variableBar = document.querySelector("#variableBar");
const variableToggle = document.querySelector("#variableToggle");
const variableList = document.querySelector("#variableList");
const automationList = document.querySelector("#automationRules");
const addRuleButton = document.querySelector("#addRuleButton");
const processList = document.querySelector("#processList");
const updateOpenButton = document.querySelector("#updateOpenButton");
const updateInstallButton = document.querySelector("#updateInstallButton");
const updateLaterButton = document.querySelector("#updateLaterButton");
const updateProgress = document.querySelector("#updateProgress");
const updateProgressFill = document.querySelector("#updateProgressFill");
const updateProgressText = document.querySelector("#updateProgressText");
const ACTIVITY_LABELS = { playing: "Jogando", listening: "Ouvindo", watching: "Assistindo", competing: "Competindo em" };
const ROTATION_SLOTS = [2, 3, 4];
const TEXT_FIELD_PATTERN = /^(?:details\d?|state\d?|largeImageText|smallImageText)$/;
const TIMER_NOTES = {
  elapsed: "O tempo começa quando a presence é ativada e continua depois de uma reconexão.",
  since: "Conta desde a última vez que o relógio marcou esse horário. Com 09:00, mostra há quanto tempo você começou hoje.",
  until: "Mostra quanto falta para esse horário. Depois dele, a contagem vai para o mesmo horário do dia seguinte."
};
const TIMER_DEFAULTS = { since: "09:00", until: "18:00" };
const WEEKDAY_LABELS = ["D", "S", "T", "Q", "Q", "S", "S"];
const WEEKDAY_NAMES = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const MAX_RULES = 10;
const tooltip = document.createElement("div");
tooltip.className = "tooltip";
tooltip.setAttribute("role", "tooltip");
document.body.append(tooltip);
let tooltipTarget;
let liveProfileIndex;
let saveTimeout;
let previewVariant = 0;
let previewVariantAt = Date.now();
let previewImageVariant = 0;
let previewImageVariantAt = Date.now();
let timerStartedAt = Date.now();
let connected = false;
const failedPreviewImages = new Set();
let profileStore;
let activeProfile = 0;
let loadingProfile = false;
let applicationPreview;
let applicationLookupTimeout;
let applicationLookupRequest = 0;
let updateUrl = "";
let musicState;
let musicStateAt = 0;
let watchingMedia;
let lastTextField = document.querySelector("#details");
let automationSaveTimeout;
let processListAt = 0;
let installingUpdate = false;

function getConfig() {
  return Object.fromEntries(fields.map((field) => [
    field.name,
    field.type === "checkbox" ? field.checked : field.value
  ]));
}

function setConfig(config) {
  fields.forEach((field) => {
    if (!(field.name in config)) return;
    if (field.type === "checkbox") field.checked = Boolean(config[field.name]);
    else field.value = config[field.name] ?? "";
  });
}

function currentProfile() {
  return profileStore.profiles[activeProfile];
}

function updateCurrentProfile() {
  if (!profileStore || loadingProfile) return;
  currentProfile().config = getConfig();
  currentProfile().name = profileName.value.trim() || `Perfil ${activeProfile + 1}`;
}

function renderProfiles() {
  if (!profileStore) return;
  profileTabs.forEach((button, index) => {
    button.textContent = profileStore.profiles[index].name;
    button.classList.toggle("active", index === activeProfile);
    button.classList.toggle("live", index === liveProfileIndex);
    button.title = index === liveProfileIndex ? `${profileStore.profiles[index].name} (no ar)` : profileStore.profiles[index].name;
    const option = awayAction.querySelector(`option[value="profile-${index}"]`);
    if (option) option.textContent = `Mostrar o perfil ${profileStore.profiles[index].name}`;
  });
  automationList.querySelectorAll('select[data-field="profile"]').forEach((select) => {
    [...select.options].forEach((option, index) => {
      option.textContent = profileStore.profiles[index]?.name || `Perfil ${index + 1}`;
    });
  });
}

function saveProfiles() {
  if (!profileStore) return Promise.resolve();
  updateCurrentProfile();
  profileStore.activeProfile = activeProfile;
  renderProfiles();
  return window.presenceAPI.saveConfig(profileStore);
}

// Writes any edit still waiting for the debounce, so the file on disk matches
// what is on screen.
function flushProfiles() {
  clearTimeout(saveTimeout);
  saveTimeout = undefined;
  return saveProfiles();
}

function scheduleSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = undefined;
    saveProfiles();
  }, 350);
}

function renderGlobalSettings(settings = {}) {
  startWithWindows.checked = Boolean(settings.startWithWindows);
  autoStartPresence.checked = Boolean(settings.autoStartPresence);
  autoReconnect.checked = settings.autoReconnect !== false;
  musicCoverLookup.checked = settings.musicCoverLookup !== false;
  awayAction.value = settings.awayAction || "off";
  awayMinutes.value = String(settings.awayMinutes || 10);
  awayMinutes.disabled = awayAction.value === "off";
}

async function saveGlobalSettings() {
  if (!profileStore) return undefined;
  clearTimeout(automationSaveTimeout);
  automationSaveTimeout = undefined;
  profileStore.settings = {
    startWithWindows: startWithWindows.checked,
    autoStartPresence: autoStartPresence.checked,
    autoReconnect: autoReconnect.checked,
    musicCoverLookup: musicCoverLookup.checked,
    musicIgnoredApps: profileStore.settings?.musicIgnoredApps || [],
    musicVideoApps: profileStore.settings?.musicVideoApps || [],
    musicDiscreetApps: profileStore.settings?.musicDiscreetApps || [],
    awayAction: awayAction.value,
    awayMinutes: Number(awayMinutes.value),
    automationRules: profileStore.settings?.automationRules || []
  };
  clearTimeout(saveTimeout);
  saveTimeout = undefined;
  const result = await saveProfiles();
  if (result?.settings) profileStore.settings = { ...result.settings };
  renderStartupStatus(result?.startupStatus);
  renderMusicSources();
  return result?.startupStatus;
}

function renderStartupStatus(status) {
  startupStatus.className = "startup-status";
  startupStatus.textContent = "";
  settingsButton.classList.toggle("attention", Boolean(status && !status.ok));
  if (!status) return;

  if (!status.ok) {
    startupStatus.textContent = status.error;
    startupStatus.classList.add("visible", "error");
    return;
  }

  if (status.development && startWithWindows.checked) {
    startupStatus.textContent = "A configuração será aplicada ao executar a versão compilada.";
  } else if (status.active && status.managed) {
    startupStatus.textContent = status.updated
      ? "Cópia de inicialização criada ou atualizada com sucesso."
      : "Inicialização protegida pela cópia gerenciada no LocalAppData.";
  } else if (status.retained) {
    startupStatus.textContent = "Inicialização desativada. A cópia em uso foi mantida e não será aberta pelo Windows.";
  }

  if (startupStatus.textContent) startupStatus.classList.add("visible");
}

function showActiveProfile() {
  loadingProfile = true;
  profileName.value = currentProfile().name;
  setConfig(currentProfile().config);
  loadingProfile = false;
  renderProfiles();
  renderPreview();
  scheduleApplicationLookup(currentProfile().config.clientId, true);
  syncMediaWatch(currentProfile().config);
}

// The preview needs the playing media for the media mode and for the
// {música} and {artista} variables.
function syncMediaWatch(config = getConfig()) {
  const wanted = Boolean(config.musicMode) || PresenceFormat.usesMediaVariables(config);
  if (wanted === watchingMedia) return;
  watchingMedia = wanted;
  window.presenceAPI.watchMusic(wanted);
}

function loadProfile(index) {
  if (!profileStore) return;
  updateCurrentProfile();
  activeProfile = index;
  profileStore.activeProfile = index;
  showActiveProfile();
  flushProfiles();
}

// Replaces everything on screen with a store that came from the main process
// (startup or an import).
function applyStore(store) {
  clearTimeout(saveTimeout);
  saveTimeout = undefined;
  profileStore = store;
  activeProfile = store.activeProfile;
  renderGlobalSettings(store.settings);
  renderStartupStatus(store.startupStatus);
  showActiveProfile();
  renderMusicSources();
  renderAutomationRules();
}

function setPreviewImage(containerId, imageId, url, alt) {
  const container = document.querySelector(containerId);
  const image = document.querySelector(imageId);
  const next = url && !failedPreviewImages.has(url) ? url : "";
  container.classList.toggle("has-image", Boolean(next));
  // Reassigning the same src restarts animated GIFs on every re-render.
  if ((image.getAttribute("src") ?? "") !== next) image.src = next;
  image.alt = next ? alt : "";
}

for (const image of document.querySelectorAll("#largeAssetImage, #smallAssetImage")) {
  image.addEventListener("error", () => {
    const src = image.getAttribute("src");
    if (!src) return;
    failedPreviewImages.add(src);
    image.parentElement.classList.remove("has-image");
    image.alt = "";
  });
}

async function lookupApplication(clientId) {
  const request = ++applicationLookupRequest;
  applicationPreview = undefined;
  failedPreviewImages.clear();
  renderPreview();

  try {
    const result = await window.presenceAPI.lookupApplication(clientId);
    if (request !== applicationLookupRequest) return;
    applicationPreview = result;
  } catch {
    if (request !== applicationLookupRequest) return;
    applicationPreview = { id: clientId, unavailable: true };
  }

  renderPreview();
}

function scheduleApplicationLookup(clientId, immediate = false) {
  clearTimeout(applicationLookupTimeout);
  const normalizedId = clientId.trim();

  if (!/^\d{17,20}$/.test(normalizedId)) {
    applicationLookupRequest += 1;
    applicationPreview = undefined;
    renderPreview();
    return;
  }

  if (applicationPreview?.id === normalizedId) return;
  applicationLookupTimeout = setTimeout(
    () => lookupApplication(normalizedId),
    immediate ? 0 : 500
  );
}

function normalizeUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function imageFields(config) {
  const list = [[config.largeImageKey, "Imagem grande"], [config.smallImageKey, "Imagem pequena"]];
  if (!config.rotateImages) return list;
  for (const slot of ROTATION_SLOTS) {
    list.push([config[`largeImageKey${slot}`] || "", `Imagem grande ${slot}`]);
    list.push([config[`smallImageKey${slot}`] || "", `Imagem pequena ${slot}`]);
  }
  return list;
}

function getImageError(config) {
  for (const [value, name] of imageFields(config)) {
    const image = value.trim();
    if (!/^https?:\/\//i.test(image)) continue;
    try {
      if (new URL(image).protocol !== "https:") return `${name}: o link da imagem precisa começar com https://.`;
    } catch {
      return `${name}: informe um link de imagem válido.`;
    }
  }
  return "";
}

function previewImage(key, application) {
  const value = key.trim();
  if (!value) return "";
  return /^https:\/\//i.test(value) ? value : application?.assets?.[value] || "";
}

function previewVariants(config) {
  const variants = [{ details: config.details, state: config.state, slot: 1 }];
  if (!config.rotateTexts) return variants;

  for (const slot of ROTATION_SLOTS) {
    const details = config[`details${slot}`] || "";
    const state = config[`state${slot}`] || "";
    if (details.trim() || state.trim()) variants.push({ details, state, slot });
  }
  return variants;
}

function previewImageVariants(config) {
  const main = { large: config.largeImageKey.trim(), small: config.smallImageKey.trim(), slot: 1 };
  const variants = [main];
  if (!config.rotateImages) return variants;

  for (const slot of ROTATION_SLOTS) {
    const large = (config[`largeImageKey${slot}`] || "").trim();
    const small = (config[`smallImageKey${slot}`] || "").trim();
    if (large || small) variants.push({ large: large || main.large, small: small || main.small, slot });
  }
  return variants;
}

function followPreviewImage(field) {
  const match = /^(?:largeImageKey|smallImageKey)(\d)?$/.exec(field?.name || "");
  if (!match) return;
  const slot = Number(match[1] || 1);
  const index = previewImageVariants(getConfig()).findIndex((variant) => variant.slot === slot);
  if (index < 0) return;
  previewImageVariant = index;
  previewImageVariantAt = Date.now();
}

function followPreviewVariant(field) {
  followPreviewImage(field);
  const match = /^(?:details|state)(\d)?$/.exec(field?.name || "");
  if (!match) return;
  const slot = Number(match[1] || 1);
  const index = previewVariants(getConfig()).findIndex((variant) => variant.slot === slot);
  if (index < 0) return;
  previewVariant = index;
  previewVariantAt = Date.now();
}

function rotationDue(count, since, interval) {
  return count > 1 && Date.now() - since >= (Number(interval) || 30) * 1000;
}

function advancePreviewVariant() {
  const config = getConfig();
  const texts = previewVariants(config).length;
  const images = previewImageVariants(config).length;
  let changed = false;
  if (rotationDue(texts, previewVariantAt, config.rotationInterval)) {
    previewVariant = (previewVariant + 1) % texts;
    previewVariantAt = Date.now();
    changed = true;
  }
  if (rotationDue(images, previewImageVariantAt, config.imageRotationInterval)) {
    previewImageVariant = (previewImageVariant + 1) % images;
    previewImageVariantAt = Date.now();
    changed = true;
  }
  if (changed) renderPreview();
}

function getButtonError(config) {
  const pairs = [
    [config.button1Label.trim(), config.button1Url.trim(), "Botão 1"],
    [config.button2Label.trim(), config.button2Url.trim(), "Botão 2"]
  ];

  for (const [label, url, name] of pairs) {
    if ((label && !url) || (!label && url)) return `${name}: preencha o texto e a URL.`;
    if (url) {
      try {
        new URL(normalizeUrl(url));
      } catch {
        return `${name}: informe uma URL válida.`;
      }
    }
  }

  return "";
}

function playingMedia() {
  return musicState?.presentation?.mode === "music" ? musicState.media : undefined;
}

function currentMusic(config) {
  return config.musicMode ? playingMedia() : undefined;
}

function textContext() {
  return {
    now: Date.now(),
    profileName: profileName.value.trim() || `Perfil ${activeProfile + 1}`,
    media: playingMedia()
  };
}

function sourceLabel(app) {
  const base = app.replace(/\.exe$/i, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function renderMusicSources() {
  const container = document.querySelector("#musicSources");
  const ignoredApps = profileStore?.settings?.musicIgnoredApps || [];
  const detected = musicState?.sources || [];
  const videoApps = profileStore?.settings?.musicVideoApps || [];
  const discreetApps = profileStore?.settings?.musicDiscreetApps || [];

  const rows = detected.map((source) => ({ ...source, detected: true }));
  for (const app of ignoredApps) {
    if (!detected.some((source) => source.app.toLowerCase() === app)) {
      rows.push({ app, title: "", playing: false, ignored: true, video: videoApps.includes(app), discreet: discreetApps.includes(app), detected: false });
    }
  }

  // Skip identical re-renders so a button never disappears mid-click.
  const signature = JSON.stringify([rows, Boolean(musicState?.watching)]);
  if (renderMusicSources.signature === signature) return;
  renderMusicSources.signature = signature;

  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "music-sources-empty";
    empty.textContent = musicState?.watching
      ? "Nenhuma mídia detectada agora. Dê play em algo para a fonte aparecer aqui."
      : "Ative o modo de mídia para detectar as fontes.";
    container.replaceChildren(empty);
    return;
  }

  container.replaceChildren(...rows.map((row) => {
    const item = document.createElement("div");
    item.className = `music-source${row.ignored ? " ignored" : ""}`;

    const info = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = row.player ? `${sourceLabel(row.app)} · ${row.player}` : sourceLabel(row.app);
    const detail = document.createElement("span");
    const kind = `${row.video || row.reportedVideo ? " · vídeo" : ""}${row.discreet ? " · discreta" : ""}`;
    detail.textContent = !row.detected
      ? "Bloqueada (sem mídia agora)"
      : row.ignored
        ? "Bloqueada"
        : `${row.playing ? "Tocando" : "Em pausa"}${kind}${row.title ? ` - ${row.title}` : ""}`;
    info.append(name, detail);

    const actions = document.createElement("div");
    actions.className = "music-source-actions";
    if (!row.ignored && !row.reportedVideo) {
      const video = document.createElement("button");
      video.type = "button";
      video.className = `ghost-button${row.video ? " selected" : ""}`;
      video.textContent = row.video ? "Vídeo" : "Marcar como vídeo";
      video.title = row.video ? "Voltar a tratar como música" : "Mostrar como Assistindo no Discord";
      video.dataset.app = row.app;
      video.dataset.video = row.video ? "0" : "1";
      actions.append(video);
    }

    if (!row.ignored) {
      const discreet = document.createElement("button");
      discreet.type = "button";
      discreet.className = `ghost-button${row.discreet ? " selected" : ""}`;
      discreet.textContent = "Discreta";
      discreet.title = row.discreet
        ? "Voltar a mostrar o que toca nesta fonte"
        : "Mostrar só Música ou Vídeo no Discord, sem título, artista nem capa";
      discreet.dataset.app = row.app;
      discreet.dataset.discreet = row.discreet ? "0" : "1";
      actions.append(discreet);
    }

    const action = document.createElement("button");
    action.type = "button";
    action.className = "ghost-button";
    action.textContent = row.ignored ? "Desbloquear" : "Bloquear";
    action.dataset.app = row.app;
    action.dataset.ignore = row.ignored ? "0" : "1";
    actions.append(action);

    item.append(info, actions);
    return item;
  }));
}

async function toggleVideoSource(app, video) {
  if (!profileStore) return;
  const list = new Set(profileStore.settings?.musicVideoApps || []);
  if (video) list.add(app.toLowerCase());
  else list.delete(app.toLowerCase());
  profileStore.settings.musicVideoApps = [...list];
  renderMusicSources.signature = undefined;
  await saveGlobalSettings();
  showToast(video
    ? `${sourceLabel(app)} aparece como Assistindo.`
    : `${sourceLabel(app)} volta a aparecer como Ouvindo.`);
}

async function toggleDiscreetSource(app, discreet) {
  if (!profileStore) return;
  const list = new Set(profileStore.settings?.musicDiscreetApps || []);
  if (discreet) list.add(app.toLowerCase());
  else list.delete(app.toLowerCase());
  profileStore.settings.musicDiscreetApps = [...list];
  renderMusicSources.signature = undefined;
  await saveGlobalSettings();
  showToast(discreet
    ? `${sourceLabel(app)} fica discreta: o Discord mostra só Música ou Vídeo.`
    : `${sourceLabel(app)} volta a mostrar o que está tocando.`);
}

async function toggleIgnoredSource(app, ignore) {
  if (!profileStore) return;
  const list = new Set(profileStore.settings?.musicIgnoredApps || []);
  if (ignore) list.add(app.toLowerCase());
  else list.delete(app.toLowerCase());
  profileStore.settings.musicIgnoredApps = [...list];
  renderMusicSources.signature = undefined;
  await saveGlobalSettings();
  showToast(ignore
    ? `${sourceLabel(app)} bloqueado no modo de mídia.`
    : `${sourceLabel(app)} desbloqueado.`);
}

function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatClockDuration(ms) {
  const elapsed = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return `${hours ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function renderTimer(config = getConfig()) {
  const now = Date.now();
  const timestamps = PresenceFormat.timerTimestamps(config, { startMs: timerStartedAt, nowMs: now });
  document.querySelector("#previewTimer").textContent = timestamps?.end
    ? `${formatClockDuration(timestamps.end - now)} restante`
    : `${formatClockDuration(now - (timestamps?.start ?? now))} decorrido`;
}

function renderMusicProgress() {
  const config = getConfig();
  const music = currentMusic(config);
  const progress = document.querySelector("#musicProgress");

  if (!music || musicState.presentation.paused || !music.playing || !music.durationMs) {
    progress.classList.remove("visible");
    return;
  }

  const position = Math.min(music.positionMs + (Date.now() - musicStateAt), music.durationMs);
  document.querySelector("#musicProgressFill").style.width =
    `${Math.min(100, (position / music.durationMs) * 100).toFixed(2)}%`;
  document.querySelector("#musicElapsed").textContent = formatTime(position);
  document.querySelector("#musicDuration").textContent = formatTime(music.durationMs);
  progress.classList.add("visible");
}

function renderPreview() {
  const config = getConfig();
  const matchingApplication = applicationPreview?.id === config.clientId.trim()
    ? applicationPreview
    : undefined;
  const music = currentMusic(config);
  const musicPaused = Boolean(music && musicState.presentation.paused);
  const discreet = Boolean(music && (config.musicDiscreet || music.discreet));
  const images = previewImageVariants(config);
  if (previewImageVariant >= images.length) previewImageVariant = 0;
  const image = music ? images[0] : images[previewImageVariant];
  const iconLarge = Boolean(config.musicPlayerIconLarge);
  const player = music && config.musicPlayerIcon && (iconLarge || !image.small)
    ? PresenceFormat.playerInfo(music.player || music.app)
    : undefined;
  const largePlayer = iconLarge ? player : undefined;
  const smallPlayer = iconLarge ? undefined : player;
  const largeImageUrl = largePlayer?.icon
    || (discreet ? "" : music?.artUrl)
    || previewImage(image.large, matchingApplication)
    || (!image.large ? matchingApplication?.iconUrl : "");
  const smallImageUrl = smallPlayer?.icon || previewImage(image.small, matchingApplication);
  const variants = previewVariants(config);
  if (previewVariant >= variants.length) previewVariant = 0;
  const text = variants[previewVariant];
  const context = textContext();
  const largeKeyIsLink = /^https?:\/\//i.test(image.large);
  const musicTitle = discreet ? PresenceFormat.discreetTitle(music) : music?.title || "";
  const musicArtist = discreet ? "" : music?.artist || "";

  rotationFields.hidden = !config.rotateTexts;
  imageRotationFields.hidden = !config.rotateImages;
  timerFields.hidden = !config.showTimer;
  musicPlayerIconLargeRow.hidden = !config.musicPlayerIcon;
  timerTimeField.hidden = config.timerMode === "elapsed";
  setInfo(timerModeInfo, TIMER_NOTES[config.timerMode] || TIMER_NOTES.elapsed);
  document.querySelector("#previewMode").textContent = music
    ? (config.musicAsPlaying ? "Jogando" : music.video ? "Assistindo" : "Ouvindo")
    : ACTIVITY_LABELS[config.activityType] || "Jogando";
  const playerName = music && config.musicPlayerName ? PresenceFormat.playerInfo(music.player || music.app)?.name : "";
  document.querySelector("#previewApp").textContent = playerName
    || matchingApplication?.name
    || (config.clientId ? `App ${config.clientId.slice(0, 8)}` : "Seu aplicativo");
  const previewDetails = document.querySelector("#previewDetails");
  previewDetails.textContent = music
    ? musicTitle
    : PresenceFormat.resolveText(text.details, context).trim();
  previewDetails.title = previewDetails.textContent;
  const previewState = document.querySelector("#previewState");
  previewState.textContent = music
    ? (musicPaused ? (musicArtist ? `Em pausa - ${musicArtist}` : "Em pausa") : musicArtist)
    : PresenceFormat.resolveText(text.state, context).trim();
  previewState.title = previewState.textContent;
  const intervalOption = document.querySelector('select[name="rotationInterval"]').selectedOptions[0];
  document.querySelector("#previewRotation").textContent = !music && variants.length > 1
    ? `Mostrando o texto ${previewVariant + 1} de ${variants.length}, que troca a cada ${intervalOption?.textContent || "30 segundos"}`
    : "";
  const imageOption = document.querySelector('select[name="imageRotationInterval"]').selectedOptions[0];
  document.querySelector("#previewImageRotation").textContent = !music && images.length > 1
    ? `Mostrando a imagem ${previewImageVariant + 1} de ${images.length}, que troca a cada ${imageOption?.textContent || "30 segundos"}`
    : "";
  const shownLine = { details: previewDetails.textContent, state: previewState.textContent }[config.statusDisplay];
  document.querySelector("#previewMemberList").textContent = shownLine
    ? `Na lista de membros: ${document.querySelector("#previewMode").textContent} ${shownLine}`
    : "";
  document.querySelector("#largeAssetFallback").textContent = music
    ? musicTitle.slice(0, 1).toUpperCase()
    : image.large && !largeKeyIsLink
      ? image.large.slice(0, 2).toUpperCase()
      : matchingApplication?.name?.slice(0, 1).toUpperCase() || "R";
  document.querySelector("#largeAsset").title = largePlayer?.name || "";
  setPreviewImage("#largeAsset", "#largeAssetImage", largeImageUrl, "Imagem grande da presence");
  document.querySelector("#smallAsset").title = smallPlayer?.name || "";
  setPreviewImage("#smallAsset", "#smallAssetImage", smallImageUrl, "Imagem pequena da presence");
  document.querySelector("#previewTimer").style.display = !music && config.showTimer ? "block" : "none";
  renderTimer(config);

  const hint = document.querySelector("#musicHint");
  if (config.musicMode && musicState?.error) {
    hint.textContent = musicState.error;
  } else if (config.musicMode && !music && !connected) {
    hint.textContent = "Nenhuma mídia tocando agora, então a presence do perfil aparece";
  } else {
    hint.textContent = "";
  }
  hint.style.display = hint.textContent ? "block" : "none";

  renderMusicProgress();
  renderPreviewButtons(config, music);
}

function renderPreviewButtons(config, music) {
  const listen = music && !music.video && !config.musicDiscreet && !music.discreet
    ? PresenceFormat.musicButton(config.musicButton, music, { app: music.player || music.app, links: music.links || {} })
    : undefined;
  const buttons = [
    listen,
    { label: config.button1Label, url: config.button1Url },
    { label: config.button2Label, url: config.button2Url }
  ].filter((button) => button?.label.trim()).slice(0, 2);

  // Skip identical re-renders: replacing the nodes mid-press would swallow
  // the click, and music state refreshes re-render the preview repeatedly.
  const signature = JSON.stringify(buttons);
  if (renderPreviewButtons.signature === signature) return;
  renderPreviewButtons.signature = signature;

  document.querySelector("#previewButtons").replaceChildren(...buttons.map((button) => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = button.label;
    element.dataset.url = normalizeUrl(button.url);
    element.disabled = !button.url.trim();
    return element;
  }));
}

// "connected" comes from the main process: an error while the presence is
// still live (a failed refresh, a media watcher issue) keeps it true.
function syncPreviewVariant(text) {
  if (!text || /^(?:details|state)\d?$/.test(document.activeElement?.name || "")) return;
  const index = previewVariants(getConfig()).findIndex((variant) => variant.slot === text.slot);
  if (index < 0) return;
  const since = Number.isFinite(text.since) ? text.since : Date.now();
  if (index === previewVariant && since === previewVariantAt) return;
  previewVariant = index;
  previewVariantAt = since;
  renderPreview();
}

function syncPreviewImage(image) {
  if (!image || /^(?:largeImageKey|smallImageKey)\d?$/.test(document.activeElement?.name || "")) return;
  const index = previewImageVariants(getConfig()).findIndex((variant) => variant.slot === image.slot);
  if (index < 0) return;
  const since = Number.isFinite(image.since) ? image.since : Date.now();
  if (index === previewImageVariant && since === previewImageVariantAt) return;
  previewImageVariant = index;
  previewImageVariantAt = since;
  renderPreview();
}

function setStatus({ status, message, startedAt, connected: isConnected, text, image, liveProfile }) {
  const wasConnected = connected;
  connected = typeof isConnected === "boolean" ? isConnected : status === "online";
  const nextLive = connected && Number.isInteger(liveProfile) ? liveProfile : undefined;
  if (nextLive !== liveProfileIndex) {
    liveProfileIndex = nextLive;
    renderProfiles();
  }
  if (connected && Number.isFinite(startedAt)) timerStartedAt = startedAt;
  statusPill.className = `connection-pill ${status}`;
  statusText.textContent = message;
  connectButton.querySelector("span").textContent = connected ? "Atualizar presence" : "Ativar presence";
  if (connected) {
    syncPreviewVariant(text);
    syncPreviewImage(image);
  }
  if (connected !== wasConnected) renderPreview();
}

function showToast(message, duration = 2800) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("visible"), duration);
}

function cleanReleaseText(value) {
  return value
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
}

function renderReleaseNotes(notes) {
  updateNotes.replaceChildren();
  const fragment = document.createDocumentFragment();
  let list;

  for (const rawLine of notes.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      list = undefined;
      continue;
    }

    let element;
    if (line.startsWith("### ")) {
      element = document.createElement("h4");
      element.textContent = cleanReleaseText(line.slice(4));
      list = undefined;
    } else if (line.startsWith("## ")) {
      element = document.createElement("h3");
      element.textContent = cleanReleaseText(line.slice(3));
      list = undefined;
    } else if (line.startsWith("# ")) {
      element = document.createElement("h3");
      element.textContent = cleanReleaseText(line.slice(2));
      list = undefined;
    } else if (line.startsWith("- ")) {
      if (!list) {
        list = document.createElement("ul");
        fragment.append(list);
      }
      element = document.createElement("li");
      element.textContent = cleanReleaseText(line.slice(2));
    } else {
      element = document.createElement("p");
      element.textContent = cleanReleaseText(line);
      list = undefined;
    }

    if (element.tagName !== "LI") fragment.append(element);
    else list.append(element);
  }

  updateNotes.append(fragment);
}

function showUpdate(update) {
  updateUrl = update.url;
  updateTitle.textContent = update.name;
  updateVersion.textContent = `${update.currentVersion} → ${update.version}`;
  renderReleaseNotes(update.notes);
  updateInstallButton.hidden = !update.canInstall;
  updateOpenButton.className = update.canInstall ? "secondary-button" : "primary-button";
  if (!installingUpdate) updateProgress.hidden = true;
  openModal(updateModal, update.canInstall ? updateInstallButton : updateOpenButton);
}

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1).replace(".", ",");
}

function renderUpdateProgress({ received = 0, total = 0, stage } = {}) {
  updateProgress.hidden = false;
  const ratio = total ? Math.min(1, received / total) : 0;
  updateProgressFill.style.width = `${(ratio * 100).toFixed(1)}%`;
  updateProgressText.textContent = stage === "restart"
    ? "Download conferido. Reiniciando na nova versão..."
    : total
      ? `Baixando ${megabytes(received)} de ${megabytes(total)} MB`
      : `Baixando ${megabytes(received)} MB`;
}

async function installUpdate() {
  if (installingUpdate) return;
  installingUpdate = true;
  updateInstallButton.disabled = true;
  updateLaterButton.disabled = true;
  renderUpdateProgress();
  updateProgressText.textContent = "Preparando o download...";
  try {
    const result = await window.presenceAPI.installUpdate();
    if (result?.ok) return;
    showToast(result?.error || "Não foi possível atualizar.", 6000);
  } catch (error) {
    showToast(error?.message || "Não foi possível atualizar.", 6000);
  }
  installingUpdate = false;
  updateInstallButton.disabled = false;
  updateLaterButton.disabled = false;
  updateProgress.hidden = true;
}

function closeUpdate() {
  closeModal(updateModal);
}

function openModal(modal, focusTarget) {
  modal.classList.add("visible");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  focusTarget?.focus();
}

function closeModal(modal) {
  modal.classList.remove("visible");
  modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal-overlay.visible")) document.body.classList.remove("modal-open");
}

function openSettings() {
  settingsButton.setAttribute("aria-expanded", "true");
  openModal(settingsModal, document.querySelector("#settingsCloseButton"));
  loadProcessList();
}

function automationRules() {
  if (!profileStore) return [];
  if (!Array.isArray(profileStore.settings.automationRules)) profileStore.settings.automationRules = [];
  return profileStore.settings.automationRules;
}

async function loadProcessList(force = false) {
  if (!force && Date.now() - processListAt < 10000) return;
  processListAt = Date.now();
  const names = await window.presenceAPI.listProcesses().catch(() => []);
  processList.replaceChildren(...names.slice(0, 500).map((name) => {
    const option = document.createElement("option");
    option.value = name;
    return option;
  }));
}

function ruleControl(tag, field, attributes = {}) {
  const element = document.createElement(tag);
  if (field) element.dataset.field = field;
  Object.assign(element, attributes);
  return element;
}

function ruleElement(rule, index, count) {
  const row = document.createElement("div");
  row.className = `rule-row${rule.enabled ? "" : " off"}`;
  row.dataset.index = String(index);

  const head = document.createElement("div");
  head.className = "rule-head";
  const toggle = document.createElement("label");
  toggle.className = "mini-switch";
  toggle.title = rule.enabled ? "Desligar esta regra" : "Ligar esta regra";
  toggle.append(ruleControl("input", "enabled", { type: "checkbox", checked: rule.enabled }), document.createElement("i"));

  const type = ruleControl("select", "type", { title: "Quando a regra vale" });
  type.append(new Option("Programa aberto", "process"), new Option("Horário", "schedule"));
  type.value = rule.type;

  const arrow = document.createElement("span");
  arrow.className = "rule-arrow";
  arrow.textContent = "ativa";

  const profile = ruleControl("select", "profile", { title: "Perfil que a regra ativa" });
  profileStore.profiles.forEach((item, profileIndex) => profile.append(new Option(item.name, String(profileIndex))));
  profile.value = String(rule.profile);

  const up = ruleControl("button", "", { type: "button", className: "rule-icon", title: "Subir: a regra de cima tem prioridade", disabled: index === 0 });
  up.dataset.action = "up";
  const remove = ruleControl("button", "", { type: "button", className: "rule-icon", title: "Remover regra" });
  remove.dataset.action = "remove";
  head.append(toggle, type, arrow, profile, up, remove);

  const body = document.createElement("div");
  body.className = "rule-body";
  if (rule.type === "process") {
    const input = ruleControl("input", "process", { value: rule.process, maxLength: 64, placeholder: "Nome do programa, como Code.exe", spellcheck: false });
    input.setAttribute("list", "processList");
    body.append(input);
  } else {
    const days = document.createElement("div");
    days.className = "rule-days";
    WEEKDAY_LABELS.forEach((label, day) => {
      const button = ruleControl("button", "", { type: "button", textContent: label, title: WEEKDAY_NAMES[day] });
      button.dataset.day = String(day);
      button.classList.toggle("active", rule.days.includes(day));
      button.setAttribute("aria-pressed", String(rule.days.includes(day)));
      days.append(button);
    });
    const until = document.createElement("span");
    until.className = "rule-arrow";
    until.textContent = "até";
    body.append(days, ruleControl("input", "start", { type: "time", value: rule.start, title: "Começa" }), until,
      ruleControl("input", "end", { type: "time", value: rule.end, title: "Termina (pode passar da meia-noite)" }));
  }

  row.append(head, body);
  if (count === 1) up.hidden = true;
  return row;
}

function renderAutomationRules() {
  const rules = automationRules();
  addRuleButton.disabled = rules.length >= MAX_RULES;
  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "music-sources-empty";
    empty.textContent = "Nenhuma regra ainda. Ex.: com o Code.exe aberto, ativar o perfil Programação.";
    automationList.replaceChildren(empty);
    return;
  }
  automationList.replaceChildren(...rules.map((rule, index) => ruleElement(rule, index, rules.length)));
}

function saveAutomation({ rerender = false, delay = 0 } = {}) {
  clearTimeout(automationSaveTimeout);
  if (rerender) renderAutomationRules();
  automationSaveTimeout = setTimeout(() => {
    automationSaveTimeout = undefined;
    saveGlobalSettings();
  }, delay);
}

function ruleFromEvent(event) {
  const row = event.target.closest(".rule-row");
  if (!row) return undefined;
  const index = Number(row.dataset.index);
  return { index, rule: automationRules()[index] };
}

function closeSettings() {
  closeModal(settingsModal);
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.focus();
}

async function checkUpdate() {
  checkUpdateButton.disabled = true;
  checkUpdateButton.textContent = "Buscando...";
  try {
    const result = await window.presenceAPI.checkUpdate();
    if (result?.status === "available") {
      closeSettings();
      showUpdate(result.update);
    } else if (result?.status === "latest") {
      showToast(`Você já tem a versão mais recente (${result.version}).`);
    } else {
      showToast("Não foi possível buscar atualização. Confira a internet e tente de novo.");
    }
  } catch {
    showToast("Não foi possível buscar atualização. Confira a internet e tente de novo.");
  } finally {
    checkUpdateButton.disabled = false;
    checkUpdateButton.textContent = "Buscar atualização";
  }
}

async function submitPresence() {
  const config = getConfig();
  if (!config.clientId.trim()) {
    document.querySelector("#clientId").focus();
    showToast("Informe o Application ID para conectar.");
    return;
  }

  const fieldError = getButtonError(config) || getImageError(config);
  if (fieldError) {
    showToast(fieldError);
    return;
  }

  const wasConnected = connected;
  connectButton.disabled = true;
  try {
    await flushProfiles();
    const result = await window.presenceAPI.connect(config);
    if (!result?.ok) showToast(result?.error || "Não foi possível ativar a presence.", 4500);
    else showToast(wasConnected ? "Presence atualizada." : "Presence ativada.");
  } catch (error) {
    showToast(error?.message || "Não foi possível ativar a presence.", 4500);
  } finally {
    connectButton.disabled = false;
  }
}

async function exportProfile() {
  if (!profileStore) return;
  exportProfilesButton.disabled = true;
  try {
    await flushProfiles();
    const result = await window.presenceAPI.exportProfile(activeProfile);
    if (result?.ok) showToast(`${result.name} exportado.`);
    else if (!result?.canceled) showToast(result?.error || "Não foi possível exportar o perfil.", 4500);
  } catch (error) {
    showToast(error?.message || "Não foi possível exportar o perfil.", 4500);
  } finally {
    exportProfilesButton.disabled = false;
  }
}

async function importProfile() {
  if (!profileStore) return;
  importProfilesButton.disabled = true;
  try {
    await flushProfiles();
    const result = await window.presenceAPI.importProfile(activeProfile);
    if (result?.ok) {
      applyStore(result.store);
      showToast(`${result.name} importado.`);
    } else if (!result?.canceled) {
      showToast(result?.error || "Não foi possível importar o perfil.", 4500);
    }
  } catch (error) {
    showToast(error?.message || "Não foi possível importar o perfil.", 4500);
  } finally {
    importProfilesButton.disabled = false;
  }
}

function handleConfigInput(event) {
  // Only named fields belong to the profile; global settings save themselves.
  const isField = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
  if (!isField || !event.target.name) return;
  if (event.target.name === "timerMode" && TIMER_DEFAULTS[event.target.value] && !document.querySelector("#timerTime").value) {
    document.querySelector("#timerTime").value = TIMER_DEFAULTS[event.target.value];
  }
  followPreviewVariant(event.target);
  renderPreview();
  if (event.target.name === "clientId") scheduleApplicationLookup(event.target.value);
  syncMediaWatch();
  if (event.target.name === "musicMode" && connected) {
    showToast("Clique em Atualizar presence para aplicar a mudança.");
  }
  updateCurrentProfile();
  scheduleSave();
}

form.addEventListener("input", handleConfigInput);
mediaTab.addEventListener("input", handleConfigInput);
form.addEventListener("focusin", (event) => {
  if (TEXT_FIELD_PATTERN.test(event.target.name || "")) lastTextField = event.target;
  const before = [previewVariant, previewImageVariant].join();
  followPreviewVariant(event.target);
  if ([previewVariant, previewImageVariant].join() !== before) renderPreview();
});

variableBar.addEventListener("mousedown", (event) => {
  if (event.target.closest("button[data-variable], #variableToggle")) event.preventDefault();
});
variableToggle.addEventListener("click", () => {
  const open = variableToggle.getAttribute("aria-expanded") !== "true";
  variableToggle.setAttribute("aria-expanded", String(open));
  variableList.hidden = !open;
});
variableBar.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-variable]");
  if (!button) return;
  const field = lastTextField?.isConnected && !lastTextField.closest("[hidden]")
    ? lastTextField
    : document.querySelector("#details");
  const value = button.dataset.variable;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  if (field.value.length - (end - start) + value.length > field.maxLength) {
    showToast("Não cabe mais texto nesse campo.");
    return;
  }
  field.focus();
  field.setRangeText(value, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
});

const editorTabs = [...document.querySelectorAll("#editorTabs button")];
editorTabs.forEach((button) => {
  button.addEventListener("click", () => {
    editorTabs.forEach((tab) => tab.classList.toggle("active", tab === button));
    document.querySelector("#tabPresence").hidden = button.dataset.tab !== "presence";
    mediaTab.hidden = button.dataset.tab !== "media";
  });
});

profileName.addEventListener("input", () => {
  updateCurrentProfile();
  renderProfiles();
  scheduleSave();
});

startWithWindows.addEventListener("change", async () => {
  const status = await saveGlobalSettings();
  if (!status?.ok) {
    showToast(status?.error || "Não foi possível configurar a inicialização.", 4500);
    return;
  }
  showToast(status.development
    ? "Preferência salva para a versão compilada."
    : startWithWindows.checked
      ? "Inicialização protegida configurada."
      : "Inicialização com o Windows desativada.");
});

autoStartPresence.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(autoStartPresence.checked
    ? "Autoativação preparada para a próxima abertura."
    : "Autoativação desativada.");
});

autoReconnect.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(autoReconnect.checked
    ? "Reconexão automática ativada."
    : "Reconexão automática desativada.");
});

awayAction.addEventListener("change", async () => {
  awayMinutes.disabled = awayAction.value === "off";
  await saveGlobalSettings();
  showToast(awayAction.value === "off"
    ? "Nada muda quando você estiver ausente."
    : `Após ${awayMinutes.selectedOptions[0].textContent} sem uso: ${awayAction.selectedOptions[0].textContent.toLowerCase()}.`);
});

awayMinutes.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(`Ausente após ${awayMinutes.selectedOptions[0].textContent} sem uso.`);
});

musicCoverLookup.addEventListener("change", async () => {
  await saveGlobalSettings();
  showToast(musicCoverLookup.checked
    ? "A capa e o álbum serão buscados no iTunes e no Deezer."
    : "Busca de capa desativada. Nada é enviado ao iTunes nem ao Deezer.");
});

profileTabs.forEach((button) => {
  button.addEventListener("click", () => {
    const nextProfile = Number(button.dataset.profile);
    if (nextProfile === activeProfile) return;
    loadProfile(nextProfile);
    showToast(`${currentProfile().name} carregado.`);
  });
});

importProfilesButton.addEventListener("click", importProfile);
exportProfilesButton.addEventListener("click", exportProfile);
connectButton.addEventListener("click", submitPresence);

document.querySelector("#previewButtons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-url]");
  if (!button?.dataset.url) return;
  window.presenceAPI.openLink(button.dataset.url).catch(() => showToast("Link não permitido."));
});

disconnectButton.addEventListener("click", async () => {
  await window.presenceAPI.disconnect();
  showToast("Presence desconectada.");
});

document.querySelector("#resetButton").addEventListener("click", () => {
  fields.forEach((field) => {
    if (field.type === "checkbox") field.checked = field.name === "showTimer" || field.name === "musicPlayerIcon";
    else if (field instanceof HTMLSelectElement) {
      field.value = [...field.options].find((option) => option.defaultSelected)?.value ?? field.options[0].value;
    } else if (field.name !== "clientId") field.value = "";
  });
  previewVariant = 0;
  previewImageVariant = 0;
  syncMediaWatch();
  renderPreview();
  flushProfiles();
  showToast("Campos limpos.");
});

document.querySelector("#portalLink").addEventListener("click", (event) => {
  event.preventDefault();
  window.presenceAPI.openLink("https://discord.com/developers/applications");
});

document.querySelector("#updateCloseButton").addEventListener("click", closeUpdate);
updateLaterButton.addEventListener("click", closeUpdate);
checkUpdateButton.addEventListener("click", checkUpdate);
updateOpenButton.addEventListener("click", () => {
  if (updateUrl) window.presenceAPI.openLink(updateUrl);
  if (!installingUpdate) closeUpdate();
});
updateInstallButton.addEventListener("click", installUpdate);

addRuleButton.addEventListener("click", () => {
  const rules = automationRules();
  if (rules.length >= MAX_RULES) return;
  rules.push({ enabled: true, type: "process", process: "", days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", profile: activeProfile });
  saveAutomation({ rerender: true });
  automationList.querySelector(".rule-row:last-child input[data-field='process']")?.focus();
  loadProcessList();
});

automationList.addEventListener("input", (event) => {
  const target = ruleFromEvent(event);
  if (!target?.rule || event.target.dataset.field !== "process") return;
  target.rule.process = event.target.value;
  saveAutomation({ delay: 500 });
});

automationList.addEventListener("change", (event) => {
  const target = ruleFromEvent(event);
  const field = event.target.dataset.field;
  if (!target?.rule || !field || field === "process") return;
  if (field === "enabled") target.rule.enabled = event.target.checked;
  else if (field === "profile") target.rule.profile = Number(event.target.value);
  else if (field === "type") target.rule.type = event.target.value;
  else if ((field === "start" || field === "end") && event.target.value) target.rule[field] = event.target.value;
  saveAutomation({ rerender: field === "type" || field === "enabled" });
});

automationList.addEventListener("click", (event) => {
  const target = ruleFromEvent(event);
  if (!target?.rule) return;
  const rules = automationRules();
  const day = event.target.closest("button[data-day]");
  const action = event.target.closest("button[data-action]")?.dataset.action;

  if (day) {
    const value = Number(day.dataset.day);
    const days = new Set(target.rule.days);
    if (days.has(value)) days.delete(value);
    else days.add(value);
    target.rule.days = [...days].sort((left, right) => left - right);
    saveAutomation({ rerender: true });
  } else if (action === "up" && target.index > 0) {
    [rules[target.index - 1], rules[target.index]] = [rules[target.index], rules[target.index - 1]];
    saveAutomation({ rerender: true });
  } else if (action === "remove") {
    rules.splice(target.index, 1);
    saveAutomation({ rerender: true });
    showToast("Regra removida.");
  }
});

automationList.addEventListener("focusin", (event) => {
  if (event.target.dataset.field === "process") loadProcessList();
});

updateModal.addEventListener("click", (event) => {
  if (event.target === updateModal) closeUpdate();
});

settingsButton.addEventListener("click", openSettings);
document.querySelector("#settingsCloseButton").addEventListener("click", closeSettings);
settingsModal.addEventListener("click", (event) => {
  if (event.target === settingsModal) closeSettings();
});

function setInfo(element, text) {
  if (element.dataset.tip === text) return;
  element.dataset.tip = text;
  element.setAttribute("aria-label", text);
  if (tooltipTarget === element) showTooltip(element);
}

function showTooltip(target) {
  tooltipTarget = target;
  tooltip.textContent = target.dataset.tip;
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";
  const anchor = target.getBoundingClientRect();
  const box = tooltip.getBoundingClientRect();
  const margin = 10;
  const left = Math.min(Math.max(margin, anchor.left + anchor.width / 2 - box.width / 2), window.innerWidth - box.width - margin);
  const below = anchor.bottom + 8;
  const top = below + box.height > window.innerHeight - margin ? anchor.top - box.height - 8 : below;
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(Math.max(margin, top))}px`;
  tooltip.classList.add("visible");
}

function hideTooltip() {
  tooltipTarget = undefined;
  tooltip.classList.remove("visible");
}

for (const info of document.querySelectorAll(".info")) {
  info.setAttribute("role", "img");
  info.setAttribute("aria-label", info.dataset.tip);
}

document.addEventListener("mouseover", (event) => {
  const target = event.target.closest("[data-tip]");
  if (target?.dataset.tip && target !== tooltipTarget) showTooltip(target);
});

document.addEventListener("mouseout", (event) => {
  const target = event.target.closest("[data-tip]");
  if (target && target === tooltipTarget && !target.contains(event.relatedTarget) && document.activeElement !== target) hideTooltip();
});

document.addEventListener("focusin", (event) => {
  if (event.target.matches("[data-tip]") && event.target.dataset.tip) showTooltip(event.target);
});

document.addEventListener("focusout", (event) => {
  if (event.target === tooltipTarget) hideTooltip();
});

document.addEventListener("click", (event) => {
  const info = event.target.closest(".info");
  if (!info) return;
  event.preventDefault();
  info.focus();
}, true);

window.addEventListener("scroll", hideTooltip, true);
window.addEventListener("resize", hideTooltip);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (tooltipTarget) hideTooltip();
  else if (updateModal.classList.contains("visible")) closeUpdate();
  else if (settingsModal.classList.contains("visible")) closeSettings();
});

window.presenceAPI.onStatus(setStatus);
window.presenceAPI.onProfileSelected(({ index, source, name } = {}) => {
  if (source === "automation") {
    showToast(`Automação: perfil ${name} ativado.`);
    return;
  }
  if (!profileStore?.profiles[index] || index === activeProfile) return;
  loadProfile(index);
  showToast(`${currentProfile().name} ativado pela bandeja.`);
});
window.presenceAPI.onUpdateProgress(renderUpdateProgress);
window.presenceAPI.onMusicState((data) => {
  musicState = data;
  musicStateAt = Date.now();
  renderPreview();
  renderMusicSources();
});

document.querySelector("#musicSources").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-app]");
  if (!button) return;
  if (button.dataset.video) toggleVideoSource(button.dataset.app, button.dataset.video === "1");
  else if (button.dataset.discreet) toggleDiscreetSource(button.dataset.app, button.dataset.discreet === "1");
  else toggleIgnoredSource(button.dataset.app, button.dataset.ignore === "1");
});
window.presenceAPI.onUpdateAvailable(showUpdate);

setInterval(() => {
  const config = getConfig();
  if (PresenceFormat.usesClockVariables(config)) renderPreview();
  else renderTimer(config);
  renderMusicProgress();
  advancePreviewVariant();
}, 1000);

window.presenceAPI.loadConfig().then((store) => {
  applyStore(store);
  if (store.appVersion) {
    appVersion.textContent = `v${store.appVersion}`;
    appVersion.hidden = false;
    document.querySelector("#settingsVersion").textContent = `Versão ${store.appVersion}`;
  }
  if (store.presenceStatus) setStatus(store.presenceStatus);
  if (store.updated) showToast(`Atualizado para a versão ${store.appVersion}.`, 5000);
  if (store.corruptedBackup) {
    showToast("O arquivo de configuração estava corrompido e foi guardado como cópia. Os perfis voltaram ao padrão.", 8000);
  }
}).finally(() => window.presenceAPI.ready());
