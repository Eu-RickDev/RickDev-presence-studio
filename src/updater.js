const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DOWNLOAD_PREFIX = "https://github.com/";
const UPDATE_FILE_PREFIX = "RickDev Presence Studio ";

// Runs after this process exits: the running portable file is locked until
// then, so the copy over it is retried for a while before falling back to
// opening the downloaded file where it is.
const APPLY_SCRIPT = [
  "$source = $env:RICKDEV_UPDATE_SOURCE",
  "$target = $env:RICKDEV_UPDATE_TARGET",
  "$parentPid = 0",
  "if ([int]::TryParse([string]$env:RICKDEV_UPDATE_PID, [ref]$parentPid) -and $parentPid -gt 0) {",
  "  try { Wait-Process -Id $parentPid -Timeout 60 -ErrorAction SilentlyContinue } catch { }",
  "}",
  "$launch = $source",
  "if ($target -and $target -ne $source) {",
  "  $temporary = \"$target.update\"",
  "  try {",
  "    Copy-Item -LiteralPath $source -Destination $temporary -Force -ErrorAction Stop",
  "    for ($attempt = 0; $attempt -lt 60; $attempt++) {",
  "      try {",
  "        Move-Item -LiteralPath $temporary -Destination $target -Force -ErrorAction Stop",
  "        $launch = $target",
  "        break",
  "      } catch { Start-Sleep -Milliseconds 500 }",
  "    }",
  "  } catch { }",
  "  Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue",
  "}",
  "$arguments = @('--updated')",
  "if ($env:RICKDEV_UPDATE_RESUME -eq '1') { $arguments += '--resume' }",
  "Start-Process -FilePath $launch -ArgumentList $arguments",
  "if ($launch -ne $source) { Remove-Item -LiteralPath $source -Force -ErrorAction SilentlyContinue }"
].join("\n");

const START_TIMEOUT_MS = 20000;

function powershellArguments(script) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-WindowStyle", "Hidden",
    "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")
  ];
}

const START_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList '${powershellArguments(APPLY_SCRIPT).join(" ")}'`
].join("\n");

function pickReleaseAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  return assets.find((asset) => /\.exe$/i.test(String(asset?.name || ""))
    && (asset.state === undefined || asset.state === "uploaded")
    && Number(asset.size) > 0
    && String(asset.browser_download_url || "").startsWith(DOWNLOAD_PREFIX));
}

function expectedSha256(release, asset) {
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest || ""));
  if (digest) return digest[1].toLowerCase();
  const note = /SHA-?256\W{0,12}([0-9a-f]{64})\b/i.exec(String(release?.body || ""));
  return note ? note[1].toLowerCase() : "";
}

function updateFileName(version) {
  const safe = String(version || "").replace(/[^0-9a-z.+-]/gi, "").slice(0, 32) || "nova";
  return `${UPDATE_FILE_PREFIX}${safe}.exe`;
}

async function downloadUpdate({ url, size = 0, sha256, target, fetch, onProgress = () => {}, fileSystem = fs.promises }) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ""))) {
    throw new Error("A versão publicada não informa o SHA-256 do executável.");
  }

  const response = await fetch(url, { headers: { "User-Agent": "RickDev-Presence-Studio" } });
  if (!response.ok || !response.body) throw new Error("Não foi possível baixar a atualização.");

  const total = Number(size) || Number(response.headers?.get?.("content-length")) || 0;
  const temporary = `${target}.part`;
  const hash = crypto.createHash("sha256");
  let received = 0;

  await fileSystem.mkdir(path.dirname(target), { recursive: true });
  const file = await fileSystem.open(temporary, "w");
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      hash.update(chunk);
      await file.write(chunk);
      received += chunk.length;
      onProgress({ received, total });
    }
  } catch (error) {
    await file.close().catch(() => {});
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  await file.close();

  if ((size && received !== Number(size)) || hash.digest("hex") !== sha256) {
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
    throw new Error("O arquivo baixado não confere com a versão publicada. Tente de novo ou baixe pelo GitHub.");
  }

  await fileSystem.rm(target, { force: true });
  await fileSystem.rename(temporary, target);
  return target;
}

function launchUpdate({
  source,
  target,
  resume = false,
  spawnProcess = spawn,
  environment = process.env,
  pid = process.pid,
  timeoutMs = START_TIMEOUT_MS
}) {
  const env = Object.fromEntries(Object.entries(environment)
    .filter(([key]) => !/^PORTABLE_EXECUTABLE_/i.test(key)));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error("Não foi possível reiniciar na nova versão. Tente de novo ou baixe pelo GitHub."));
    const child = spawnProcess("powershell.exe", powershellArguments(START_SCRIPT), {
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...env,
        RICKDEV_UPDATE_SOURCE: source,
        RICKDEV_UPDATE_TARGET: target || "",
        RICKDEV_UPDATE_PID: String(pid),
        RICKDEV_UPDATE_RESUME: resume ? "1" : "0"
      }
    });
    const timer = setTimeout(() => {
      child.kill?.();
      fail();
    }, timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      fail();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else fail();
    });
  });
}

async function cleanupDownloads(directory, keepPath = "", fileSystem = fs.promises) {
  let entries;
  try {
    entries = await fileSystem.readdir(directory);
  } catch {
    return;
  }
  const keep = path.resolve(keepPath || ".").toLowerCase();
  await Promise.all(entries
    .filter((name) => name.startsWith(UPDATE_FILE_PREFIX))
    .map((name) => path.join(directory, name))
    .filter((file) => path.resolve(file).toLowerCase() !== keep)
    .map((file) => fileSystem.rm(file, { force: true }).catch(() => {})));
}

module.exports = {
  APPLY_SCRIPT,
  cleanupDownloads,
  downloadUpdate,
  expectedSha256,
  launchUpdate,
  pickReleaseAsset,
  START_SCRIPT,
  updateFileName
};
