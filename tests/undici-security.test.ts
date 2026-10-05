import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import { Client, REST, SlashCommandBuilder } from "discord.js";
import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const discordRequire = createRequire(require.resolve("discord.js"));

test("Discord client, REST client and command validation initialize offline", async () => {
  const client = new Client({ intents: [] });
  try {
    expect(client.isReady()).toBe(false);
    expect(new REST({ version: "10" })).toBeInstanceOf(REST);
    expect(
      new SlashCommandBuilder().setName("health").setDescription("Health check").toJSON().name,
    ).toBe("health");
  } finally {
    await client.destroy();
  }
});

// Exercise both dependency paths so a second vulnerable copy cannot hide behind
// the top-level resolution. The server is local and never contacts Discord.
test.each(["discord.js", "@discordjs/rest"])(
  "%s rejects an unrequested WebSocket subprotocol without crashing",
  async (dependency) => {
    const dependencyRequire = createRequire(discordRequire.resolve(dependency));
    const { WebSocket } = dependencyRequire("undici");
    const sockets = new Set<Socket>();
    const server = createServer();

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket) => {
      const accept = createHash("sha1")
        .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          "Sec-WebSocket-Protocol: unrequested\r\n\r\n",
      );
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");

    try {
      const outcome = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("WebSocket handshake timed out")), 3000);
        const websocket = new WebSocket(`ws://127.0.0.1:${address.port}`);
        websocket.addEventListener("open", () => {
          clearTimeout(timer);
          resolve("open");
        });
        websocket.addEventListener("error", () => {
          clearTimeout(timer);
          resolve("error");
        });
      });
      expect(outcome).toBe("error");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
