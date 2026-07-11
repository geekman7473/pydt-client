import * as http from "node:http";
import { default as log } from "electron-log";
import { RPC_TO_MAIN } from "./rpcChannels.js";

const HOST = "127.0.0.1";
const PORT = 47821;

let server = null;
let turnState = {
  ready: false,
  count: 0,
  games: [],
};

const startServer = () => {
  if (server) {
    return;
  }

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

  server.listen(PORT, HOST, () => log.info(`Turn API listening on http://${HOST}:${PORT}/turns`));
};

const stopServer = () => {
  if (!server) {
    return;
  }

  const currentServer = server;
  server = null;

  currentServer.close(() => log.info("Turn API stopped"));
};

export const initTurnApi = (app, ipcMain, enabled) => {
  ipcMain.on(RPC_TO_MAIN.UPDATE_TURNS_AVAILABLE, (_event, state) => {
    turnState = state;
  });

  ipcMain.on(RPC_TO_MAIN.SET_TURN_API_ENABLED, (_event, shouldEnable) => {
    if (shouldEnable) {
      startServer();
    } else {
      stopServer();
    }
  });

  if (enabled) {
    startServer();
  }

  app.once("before-quit", stopServer);
};
