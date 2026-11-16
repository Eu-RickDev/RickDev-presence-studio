const { presenceText } = require("./media");
const { resolveText, statusDisplayType, timerTimestamps } = require("./renderer/presence-format");

const MAX_UNIX_TIMESTAMP_MS = 2147483647000;
const ACTIVITY_TYPES = Object.freeze({ playing: 0, listening: 2, watching: 3, competing: 5 });
const ROTATION_INTERVALS = Object.freeze([15, 30, 60, 120, 300]);
const DEFAULT_ROTATION_SECONDS = 30;
const ROTATION_SLOTS = [2, 3, 4];

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

function isImageUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function validateImage(value, name) {
  const image = String(value || "").trim();
  if (!isImageUrl(image)) return;

  let parsed;
  try {
    parsed = new URL(image);
  } catch {
    throw new Error(`${name}: informe um link de imagem válido.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name}: o link da imagem precisa começar com https://.`);
  }
}

function textVariants(config) {
  const variants = [{ details: String(config.details || ""), state: String(config.state || ""), slot: 1 }];
  if (!config.rotateTexts) return variants;

  for (const slot of ROTATION_SLOTS) {
    const details = String(config[`details${slot}`] || "");
    const state = String(config[`state${slot}`] || "");
    if (details.trim() || state.trim()) variants.push({ details, state, slot });
  }
  return variants;
}

function imageVariants(config) {
  const main = {
    large: String(config.largeImageKey || "").trim(),
    small: String(config.smallImageKey || "").trim(),
    slot: 1
  };
  const variants = [main];
  if (!config.rotateImages) return variants;

  for (const slot of ROTATION_SLOTS) {
    const large = String(config[`largeImageKey${slot}`] || "").trim();
    const small = String(config[`smallImageKey${slot}`] || "").trim();
    if (large || small) variants.push({ large: large || main.large, small: small || main.small, slot });
  }
  return variants;
}

function validateImages(config) {
  validateImage(config.largeImageKey, "Imagem grande");
  validateImage(config.smallImageKey, "Imagem pequena");
  if (!config.rotateImages) return;
  for (const slot of ROTATION_SLOTS) {
    validateImage(config[`largeImageKey${slot}`], `Imagem grande ${slot}`);
    validateImage(config[`smallImageKey${slot}`], `Imagem pequena ${slot}`);
  }
}

function rotationIntervalMs(config, field = "rotationInterval") {
  const seconds = Number(config[field]);
  return (ROTATION_INTERVALS.includes(seconds) ? seconds : DEFAULT_ROTATION_SECONDS) * 1000;
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  return Number(value) || 0;
}

function validTimestamps(timestamps) {
  if (!timestamps) return false;
  return Object.values(timestamps).every((value) => value > 0 && value <= MAX_UNIX_TIMESTAMP_MS);
}

function buildActivity(config, options = {}) {
  const {
    startTimestamp,
    variant = 0,
    imageVariant = 0,
    includeType = true,
    includeStatusDisplay = true,
    appIcon = "",
    context = {},
    now = Date.now()
  } = options;
  const textContext = { now, ...context };
  validateButtons(config);
  validateImages(config);

  const activity = { instance: false };
  const type = ACTIVITY_TYPES[config.activityType] || 0;
  if (includeType && type) activity.type = type;

  const variants = textVariants(config);
  const text = variants[Math.abs(Math.trunc(variant)) % variants.length];
  const details = presenceText(resolveText(text.details, textContext));
  if (details) activity.details = details;
  const state = presenceText(resolveText(text.state, textContext));
  if (state) activity.state = state;

  if (includeStatusDisplay) {
    const display = statusDisplayType(config.statusDisplay, activity);
    if (display) activity.status_display_type = display;
  }

  const images = imageVariants(config);
  const image = images[Math.abs(Math.trunc(imageVariant)) % images.length];
  const assets = {};
  const largeImage = image.large || String(appIcon || "").slice(0, 256);
  if (largeImage) assets.large_image = largeImage;
  const largeText = presenceText(resolveText(config.largeImageText, textContext));
  if (largeText) assets.large_text = largeText;
  if (image.small) assets.small_image = image.small;
  const smallText = presenceText(resolveText(config.smallImageText, textContext));
  if (smallText) assets.small_text = smallText;
  if (Object.keys(assets).length) activity.assets = assets;

  const timestamps = timerTimestamps(config, { startMs: timestampMs(startTimestamp), nowMs: now });
  if (validTimestamps(timestamps)) activity.timestamps = timestamps;

  const buttons = buildButtons(config);
  if (buttons.length) activity.buttons = buttons;
  return activity;
}

module.exports = {
  ACTIVITY_TYPES,
  buildActivity,
  buildButtons,
  imageVariants,
  isImageUrl,
  rotationIntervalMs,
  textVariants
};
