const fs = require("fs");
const path = require("path");

const PROFILE_COUNT = 5;
const CONFIG_FILE = "presence-config.json";
const EXPORT_FORMAT = "rickdev-presence-profiles";
const EXPORT_FORMAT_VERSION = 1;
const MAX_IMPORT_BYTES = 1024 * 1024;

const defaultSettings = {
  startWithWindows: false,
  autoStartPresence: false,
  autoReconnect: true,
  musicCoverLookup: true,
  musicIgnoredApps: []
};

const defaults = {
  clientId: "",
  details: "Criando algo incrível",
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

// Upper bounds for stored text, matching what Discord accepts for each field.
const textLimits = {
  clientId: 20,
  details: 128,
  state: 128,
  largeImageKey: 256,
  largeImageText: 128,
  smallImageKey: 256,
  smallImageText: 128,
  button1Label: 32,
  button1Url: 512,
  button2Label: 32,
  button2Url: 512
};

function emptyProfile(index) {
  return {
    name: `Perfil ${index + 1}`,
    config: { ...defaults }
  };
}

// Only known fields survive, each with the type the app expects, so a
// hand-edited or imported file can never feed null or objects to the RPC code.
function normalizeConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const config = {};

  for (const [key, fallback] of Object.entries(defaults)) {
    const value = source[key];
    if (typeof fallback === "boolean") {
      config[key] = typeof value === "boolean" ? value : fallback;
    } else if (value === undefined) {
      config[key] = fallback;
    } else if (typeof value === "string" || typeof value === "number") {
      config[key] = String(value).slice(0, textLimits[key] || 256);
    } else {
      config[key] = "";
    }
  }

  return config;
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  // A test build briefly stored per-type rules as an object; its keys count
  // as blocked apps.
  const rawIgnored = Array.isArray(source.musicIgnoredApps)
    ? source.musicIgnoredApps
    : source.musicSourceRules && typeof source.musicSourceRules === "object"
      ? Object.keys(source.musicSourceRules)
      : [];

  return {
    startWithWindows: source.startWithWindows === true,
    autoStartPresence: source.autoStartPresence === true,
    autoReconnect: typeof source.autoReconnect === "boolean"
      ? source.autoReconnect
      : defaultSettings.autoReconnect,
    musicCoverLookup: typeof source.musicCoverLookup === "boolean"
      ? source.musicCoverLookup
      : defaultSettings.musicCoverLookup,
    musicIgnoredApps: [...new Set(rawIgnored
      .map((app) => String(app).trim().toLowerCase().slice(0, 128))
      .filter(Boolean))].slice(0, 30)
  };
}

function normalizeProfile(profile, index) {
  if (!profile || typeof profile !== "object") return emptyProfile(index);
  const name = typeof profile.name === "string" ? profile.name.trim().slice(0, 24) : "";
  return {
    name: name || `Perfil ${index + 1}`,
    config: normalizeConfig(profile.config)
  };
}

function clampProfileIndex(value) {
  return Math.min(Math.max(Math.trunc(Number(value)) || 0, 0), PROFILE_COUNT - 1);
}

function normalizeProfiles(data) {
  const settings = normalizeSettings(data?.settings);

  if (Array.isArray(data?.profiles)) {
    return {
      activeProfile: clampProfileIndex(data.activeProfile),
      settings,
      profiles: Array.from({ length: PROFILE_COUNT }, (_item, index) =>
        normalizeProfile(data.profiles[index], index))
    };
  }

  // Files from before profiles existed stored a single config at the root.
  return {
    activeProfile: 0,
    settings,
    profiles: [
      { name: "Perfil 1", config: normalizeConfig(data) },
      ...Array.from({ length: PROFILE_COUNT - 1 }, (_item, index) => emptyProfile(index + 1))
    ]
  };
}

// Write to a sibling file first and swap it in, so a crash or power loss in
// the middle of a save can never leave a truncated file behind.
function writeJsonAtomic(target, data, fileSystem = fs) {
  const temporary = `${target}.tmp-${process.pid}`;
  fileSystem.writeFileSync(temporary, JSON.stringify(data, null, 2), "utf8");

  try {
    fileSystem.renameSync(temporary, target);
  } catch (error) {
    if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) {
      try { fileSystem.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }
    // Antivirus or indexers can briefly lock the target on Windows; a plain
    // copy still beats losing the save.
    fileSystem.copyFileSync(temporary, target);
    try { fileSystem.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createConfigStore(getDirectory, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const onCorrupted = options.onCorrupted || (() => {});

  function configPath() {
    return path.join(getDirectory(), CONFIG_FILE);
  }

  function load() {
    let raw;
    try {
      raw = fileSystem.readFileSync(configPath(), "utf8");
    } catch {
      return normalizeProfiles();
    }

    try {
      return normalizeProfiles(JSON.parse(raw.replace(/^﻿/, "")));
    } catch {
      // Keep the unreadable file for manual recovery instead of silently
      // overwriting it on the next save.
      const backup = path.join(getDirectory(), `presence-config.corrompido-${timestampForFile()}.json`);
      try {
        fileSystem.renameSync(configPath(), backup);
        onCorrupted(backup);
      } catch {
        // If the file cannot be moved, the defaults are still used for now.
      }
      return normalizeProfiles();
    }
  }

  function save(data) {
    const normalized = normalizeProfiles(data);
    fileSystem.mkdirSync(getDirectory(), { recursive: true });
    writeJsonAtomic(configPath(), normalized, fileSystem);
    return normalized;
  }

  return { configPath, load, save };
}

function buildProfilesExport(store, appVersion, now = new Date()) {
  const normalized = normalizeProfiles(store);
  return {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    appVersion: String(appVersion || ""),
    exportedAt: now.toISOString(),
    activeProfile: normalized.activeProfile,
    profiles: normalized.profiles
  };
}

// Accepts files exported by the Studio and the app's own presence-config.json.
function parseProfilesImport(text) {
  if (Buffer.byteLength(String(text || ""), "utf8") > MAX_IMPORT_BYTES) {
    throw new Error("O arquivo é grande demais para ser um arquivo de perfis.");
  }

  let data;
  try {
    data = JSON.parse(String(text || "").replace(/^﻿/, ""));
  } catch {
    throw new Error("O arquivo selecionado não é um JSON válido.");
  }

  if (data && typeof data === "object" && data.format !== undefined && data.format !== EXPORT_FORMAT) {
    throw new Error("O arquivo não foi exportado pelo RickDev Presence Studio.");
  }
  if (Number(data?.formatVersion) > EXPORT_FORMAT_VERSION) {
    throw new Error("Este arquivo foi exportado por uma versão mais nova do Studio. Atualize o aplicativo para importá-lo.");
  }

  const profiles = Array.isArray(data?.profiles) ? data.profiles.slice(0, PROFILE_COUNT) : [];
  const count = profiles.filter((profile) => profile && typeof profile === "object").length;
  if (!count) {
    throw new Error("Nenhum perfil foi encontrado no arquivo.");
  }

  const normalized = normalizeProfiles({ activeProfile: data.activeProfile, profiles });
  return {
    activeProfile: normalized.activeProfile,
    profiles: normalized.profiles,
    count
  };
}

module.exports = {
  EXPORT_FORMAT,
  MAX_IMPORT_BYTES,
  PROFILE_COUNT,
  buildProfilesExport,
  createConfigStore,
  defaultSettings,
  defaults,
  normalizeConfig,
  normalizeProfiles,
  normalizeSettings,
  parseProfilesImport,
  writeJsonAtomic
};
