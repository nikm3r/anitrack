/**
 * electron-builder config — replaces forge.config.cjs
 */

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: "com.nikm3r.anitrack",
  productName: "AniTrack",
  copyright: "Copyright © 2025 nikm3r",

  // electron-builder auto-includes production dependencies from package.json.
  // We only need to specify our built output files on top of that.
  files: [
    "dist/**/*",
    "dist-server/**/*",
    "main.js",
    "preload.js",
  ],

  // Extra resources copied to resources/ alongside the asar
  extraResources: [
    { from: "resources/syncplay.lua", to: "syncplay.lua" },
    { from: "icon.png",               to: "icon.png"    },
  ],

  // ASAR — pack app files, unpack native modules so they can be loaded
  asar: true,
  asarUnpack: [
    "node_modules/better-sqlite3/**/*",
    "node_modules/bindings/**/*",
    "node_modules/file-uri-to-path/**/*",
  ],

  // GitHub Releases — electron-updater reads latest.yml from here
  publish: {
    provider: "github",
    owner: "nikm3r",
    repo: "AniTrack",
    releaseType: "release",
  },

  // Linux
  linux: {
    target: [
      { target: "zip",      arch: ["x64"] },
      { target: "deb",      arch: ["x64"] },
      { target: "AppImage", arch: ["x64"] },
    ],
    icon: "icon.png",
    category: "AudioVideo",
    executableName: "anitrack",
    // Keep same zip name as before so PKGBUILD doesn't break
    artifactName: "${name}-linux-x64-${version}.${ext}",
  },
  deb: {
    packageName: "anitrack",
    maintainer: "nikm3r <nmermigkas@gmail.com>",
    homepage: "https://github.com/nikm3r/AniTrack",
  },

  // Windows
  win: {
    target: [
      { target: "nsis", arch: ["x64"] },
      { target: "zip",  arch: ["x64"] },
    ],
    icon: "icon.ico",
    artifactName: "${name}-windows-x64-${version}.${ext}",
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "AniTrack",
  },

  // macOS
  mac: {
    target: [
      { target: "dmg", arch: ["x64", "arm64"] },
      { target: "zip", arch: ["x64", "arm64"] },
    ],
    icon: "icon.icns",
    artifactName: "${name}-mac-${arch}-${version}.${ext}",
  },
  dmg: {
    title: "AniTrack",
    overwrite: true,
  },
};

module.exports = config;
