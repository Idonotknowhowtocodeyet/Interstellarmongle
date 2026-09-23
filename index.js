import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { createBareServer } from "@nebula-services/bare-server-node";
import chalk from "chalk";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import bareMuxNode from "@mercuryworkshop/bare-mux/node";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
import mime from "mime";
import fetch from "node-fetch";
// import { setupMasqr } from "./Masqr.js";
import config from "./config.js";

console.log(chalk.yellow("🚀 Starting server..."));

const __dirname = process.cwd();
const server = http.createServer();
const app = express();
const bareServer = createBareServer("/ca/");
const { baremuxPath } = bareMuxNode;
const epoxyDistPath = path.join(__dirname, "node_modules", "@mercuryworkshop", "epoxy-transport", "dist");
const PORT = process.env.PORT || 8080;
const cache = new Map();
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // Cache for 30 Days
const authTokens = new Set();
const hasAuthCookie = request => {
  const cookieHeader = request.headers.cookie || "";
  const token = cookieHeader.match(/(?:^|;\s*)mongle_auth=([^;]+)/)?.[1];
  return authTokens.has(token);
};

const persistUsers = () => {
  const users = Object.entries(config.users)
    .map(([username, password]) => `    ${JSON.stringify(username)}: ${JSON.stringify(password)},`)
    .join("\n");
  fs.writeFileSync(path.join(__dirname, "config.js"), `const config = {\n  challenge: ${config.challenge},\n  users: {\n${users}\n  },\n};\n\nexport default config;\n`);
};

wisp.options.allow_loopback_ips = true;
wisp.options.allow_private_ips = true;

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "static", "login.html"));
});

app.post("/login", (req, res) => {
  const validUser = Object.entries(config.users).some(([username, password]) => username === req.body.username && password === req.body.password);
  if (!validUser) return res.redirect("/login?error=1");

  const token = crypto.randomBytes(32).toString("hex");
  authTokens.add(token);
  res.cookie("mongle_auth", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: 1000 * 60 * 60 * 12,
  });
  res.redirect("/");
});

app.get("/admin/users", (req, res) => {
  if (!authTokens.has(req.cookies.mongle_auth)) return res.status(401).json({ error: "Authentication required" });
  res.json({ users: Object.keys(config.users) });
});

app.post("/admin/users", (req, res) => {
  if (!authTokens.has(req.cookies.mongle_auth)) return res.status(401).json({ error: "Authentication required" });
  const { action, username, password, newUsername, newPassword } = req.body;

  if (action === "add" && username && password) {
    config.users[username] = password;
  } else if (action === "remove" && username) {
    if (Object.keys(config.users).length <= 1) return res.status(400).json({ error: "At least one user must remain" });
    delete config.users[username];
  } else if (action === "change" && username && newUsername && newPassword) {
    if (!config.users[username]) return res.status(404).json({ error: "User not found" });
    delete config.users[username];
    config.users[newUsername] = newPassword;
  } else {
    return res.status(400).json({ error: "Invalid user command" });
  }

  persistUsers();
  res.json({ ok: true, users: Object.keys(config.users) });
});

if (config.challenge !== false) {
  app.use((req, res, next) => {
    if (req.path === "/login" || authTokens.has(req.cookies.mongle_auth)) return next();
    if (req.accepts("html")) return res.redirect(`/login?return=${encodeURIComponent(req.originalUrl)}`);
    res.status(401).json({ error: "Authentication required" });
  });
}

app.get("/e/*", async (req, res, next) => {
  try {
    if (cache.has(req.path)) {
      const { data, contentType, timestamp } = cache.get(req.path);
      if (Date.now() - timestamp > CACHE_TTL) {
        cache.delete(req.path);
      } else {
        res.writeHead(200, { "Content-Type": contentType });
        return res.end(data);
      }
    }

    const baseUrls = {
      "/e/1/": "https://raw.githubusercontent.com/qrs/x/fixy/",
      "/e/2/": "https://raw.githubusercontent.com/3v1/V5-Assets/main/",
      "/e/3/": "https://raw.githubusercontent.com/3v1/V5-Retro/master/",
    };

    let reqTarget;
    for (const [prefix, baseUrl] of Object.entries(baseUrls)) {
      if (req.path.startsWith(prefix)) {
        reqTarget = baseUrl + req.path.slice(prefix.length);
        break;
      }
    }

    if (!reqTarget) {
      return next();
    }

    const asset = await fetch(reqTarget);
    if (!asset.ok) {
      return next();
    }

    const data = Buffer.from(await asset.arrayBuffer());
    const ext = path.extname(reqTarget);
    const no = [".unityweb"];
    const contentType = no.includes(ext) ? "application/octet-stream" : mime.getType(ext);

    cache.set(req.path, { data, contentType, timestamp: Date.now() });
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  } catch (error) {
    console.error("Error fetching asset:", error);
    res.setHeader("Content-Type", "text/html");
    res.status(500).send("Error fetching the asset");
  }
});

/* if (process.env.MASQR === "true") {
  console.log(chalk.green("Masqr is enabled"));
  setupMasqr(app);
} */

const transportStaticOptions = {
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath);
    if (ext === ".mjs" || ext === ".js") {
      res.type("text/javascript");
    } else if (ext === ".wasm") {
      res.type("application/wasm");
    }
  },
};

app.use(express.static(path.join(__dirname, "static")));
app.use("/ca", cors({ origin: true }));
app.use("/bm", express.static(baremuxPath, transportStaticOptions));
app.use("/ep", express.static(epoxyDistPath, transportStaticOptions));

const routes = [
  { path: "/b", file: "apps.html" },
  { path: "/a", file: "games.html" },
  { path: "/play.html", file: "games.html" },
  { path: "/c", file: "settings.html" },
  { path: "/d", file: "tabs.html" },
  { path: "/", file: "index.html" },
];

// biome-ignore lint: idk
routes.forEach(route => {
  app.get(route.path, (_req, res) => {
    res.sendFile(path.join(__dirname, "static", route.file));
  });
});

app.use((req, res, next) => {
  res.status(404).sendFile(path.join(__dirname, "static", "404.html"));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).sendFile(path.join(__dirname, "static", "404.html"));
});

server.on("request", (req, res) => {
  if (config.challenge !== false && bareServer.shouldRoute(req) && !hasAuthCookie(req)) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    return res.end("Authentication required");
  }
  if (bareServer.shouldRoute(req)) {
    bareServer.routeRequest(req, res);
  } else {
    app(req, res);
  }
});

server.on("upgrade", (req, socket, head) => {
  if (config.challenge !== false && !hasAuthCookie(req)) {
    socket.destroy();
    return;
  }
  if (bareServer.shouldRoute(req)) {
    bareServer.routeUpgrade(req, socket, head);
  } else {
    wisp.routeRequest(req, socket, head);
  }
});

server.on("listening", () => {
  console.log(chalk.green(`🌍 Server is running on http://localhost:${PORT}`));
});

server.listen({ port: PORT });
