const path = require("node:path");

const LOCAL_ORIGIN = "http://127.0.0.1:3210";

function serverLaunch({ packaged, resourcesPath, appPath }) {
  if (packaged) {
    const cwd = path.join(resourcesPath, "app");
    return {
      cwd,
      entry: path.join(cwd, "server.js"),
      nodePath: path.join(cwd, ".next", "node_modules"),
    };
  }
  return {
    cwd: appPath,
    entry: path.join(appPath, ".next", "standalone", "server.js"),
  };
}

function serverEnvironment(baseEnv, nodePath) {
  return {
    ...baseEnv,
    ...(nodePath ? { NODE_PATH: nodePath } : {}),
    PORT: "3210",
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    GROK_CANVAS_DESKTOP: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
}

function externalHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.toString();
}

function isAppUrl(value, origin = LOCAL_ORIGIN) {
  try {
    return new URL(value).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

module.exports = {
  LOCAL_ORIGIN,
  serverLaunch,
  serverEnvironment,
  externalHttpUrl,
  isAppUrl,
};
