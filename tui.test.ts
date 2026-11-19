import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import plugin, { parseEnviron, setup, VERSION } from "./tui.ts";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_PANE_ID;
  delete (globalThis as Record<string, unknown>).__herdrNativeBridgeActive;
});

function createFakeApi(sessionId = "ses_root") {
  let listener: ((event: { details: any }) => void) | undefined;
  const permissions = new Map<string, Array<{ id: string }>>();
  const forms = new Map<string, Array<{ id: string }>>();

  return {
    emit(type: string, data: Record<string, unknown>) {
      listener?.({ details: { type, data } });
    },
    setPermissions(id: string, items: Array<{ id: string }>) {
      permissions.set(id, items);
    },
    api: {
      ui: {
        router: {
          current: () => ({ type: "session", sessionID: sessionId }),
        },
      },
      data: {
        listen(cb: (event: { details: any }) => void) {
          listener = cb;
          return () => {
            listener = undefined;
          };
        },
        session: {
          get: (id: string) =>
            id === sessionId ? { id: sessionId } : { id, parentID: sessionId },
          family: () => [],
          status: () => "idle",
          permission: { list: (id: string) => permissions.get(id) ?? [] },
          form: { list: (id: string) => forms.get(id) ?? [] },
        },
      },
    },
  };
}

async function startSocketServer() {
  const dir = mkdtempSync(path.join(tmpdir(), "herdr-bridge-test-"));
  const socketPath = path.join(dir, "herdr.sock");
  const messages: any[] = [];

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) messages.push(JSON.parse(line));
        conn.write('{"ok":true}\n');
        idx = buf.indexOf("\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  return { socketPath, messages };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for socket message");
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe("opencode-herdr-native-bridge", () => {
  test("VERSION matches package.json version", () => {
    expect(VERSION).toBe(pkg.version);
    expect(plugin.id).toBe("herdr.opencode.native-bridge");
  });

  test("parseEnviron extracts only HERDR_* keys", () => {
    const raw =
      "PATH=/bin\0HERDR_ENV=1\0HERDR_SOCKET_PATH=/tmp/h.sock\0HERDR_PANE_ID=w1:p2\0HERDR_AGENT=oc-ru\0FOO=bar\0";
    expect(parseEnviron(raw)).toEqual({
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/h.sock",
      HERDR_PANE_ID: "w1:p2",
      HERDR_AGENT: "oc-ru",
    });
  });

  test("skips when HERDR_* is already in process.env (classic opencode)", () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_SOCKET_PATH = "/tmp/existing.sock";
    process.env.HERDR_PANE_ID = "w1:p1";
    const { api } = createFakeApi();
    let called = false;
    const stop = setup(api, {
      watchExit: false,
      readEnv: () => {
        called = true;
        return { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/x.sock", HERDR_PANE_ID: "w1:p2" };
      },
    });
    expect(stop).toBeUndefined();
    expect(called).toBe(false);
  });

  test("skips when parent env is not inside Herdr TUI", () => {
    const { api } = createFakeApi();
    const stop = setup(api, {
      watchExit: false,
      readEnv: () => ({}),
    });
    expect(stop).toBeUndefined();
  });

  test("reports session, working/blocked/idle transitions, HERDR_AGENT, and release", async () => {
    const { socketPath, messages } = await startSocketServer();
    const fake = createFakeApi("ses_123");
    const stop = setup(fake.api, {
      watchExit: false,
      pollIntervalMs: 50,
      readEnv: () => ({
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: socketPath,
        HERDR_PANE_ID: "w1:p2",
        HERDR_AGENT: "oc-ru",
      }),
    });
    expect(typeof stop).toBe("function");
    cleanups.push(() => stop?.());

    await waitFor(() =>
      messages.some((m) => m.method === "pane.report_agent" && m.params.state === "idle"),
    );

    const sessionMsg = messages.find((m) => m.method === "pane.report_agent_session");
    expect(sessionMsg?.params).toMatchObject({
      pane_id: "w1:p2",
      source: "opencode:native",
      agent: "oc-ru",
      agent_session_id: "ses_123",
      session_start_source: "select",
    });

    fake.emit("session.execution.started", { sessionID: "ses_123" });
    await waitFor(() =>
      messages.some((m) => m.method === "pane.report_agent" && m.params.state === "working"),
    );

    fake.setPermissions("ses_123", [{ id: "perm_1" }]);
    fake.emit("permission.asked", { id: "perm_1", sessionID: "ses_123" });
    await waitFor(() =>
      messages.some((m) => m.method === "pane.report_agent" && m.params.state === "blocked"),
    );

    fake.setPermissions("ses_123", []);
    fake.emit("permission.replied", { requestID: "perm_1", sessionID: "ses_123" });
    fake.emit("session.execution.succeeded", { sessionID: "ses_123" });
    await waitFor(() => {
      const states = messages
        .filter((m) => m.method === "pane.report_agent")
        .map((m) => m.params.state);
      return states[states.length - 1] === "idle";
    });

    stop?.();
    await waitFor(() => messages.some((m) => m.method === "pane.release_agent"));
    const release = messages.find((m) => m.method === "pane.release_agent");
    expect(release?.params).toMatchObject({
      pane_id: "w1:p2",
      source: "opencode:native",
      agent: "oc-ru",
    });
  });
});
