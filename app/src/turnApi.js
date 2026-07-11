import * as http from "node:http";
import { default as log } from "electron-log";
import { RPC_TO_MAIN } from "./rpcChannels.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 47821;

let server = null;
let currentPort = DEFAULT_PORT;
let turnState = {
  ready: false,
  count: 0,
  games: [],
};

const startServer = port => {
  if (server) {
    if (currentPort === port) {
      return;
    }
    const oldServer = server;
    server = null;
    oldServer.close(() => log.info("Turn API stopped (port change)"));
  }

  currentPort = port;

  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/turns") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(turnState));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("error", error => {
    log.error(`Turn API error: ${error.message}`);
    server = null;
  });

  server.listen(port, HOST, () => log.info(`Turn API listening on http://${HOST}:${port}/turns`));
};

const stopServer = () => {
  if (!server) {
    return;
  }

  const currentServer = server;
  server = null;

  currentServer.close(() => log.info("Turn API stopped"));
};

export const initTurnApi = (app, ipcMain, enabled, port = DEFAULT_PORT) => {
  ipcMain.on(RPC_TO_MAIN.UPDATE_TURNS_AVAILABLE, (_event, state) => {
    turnState = state;
  });

  ipcMain.on(RPC_TO_MAIN.SET_TURN_API_ENABLED, (_event, { enabled: shouldEnable, port: newPort = DEFAULT_PORT }) => {
    if (shouldEnable) {
      startServer(newPort);
    } else {
      stopServer();
    }
  });

  if (enabled) {
    startServer(port);
  }

  app.once("before-quit", stopServer);
};
