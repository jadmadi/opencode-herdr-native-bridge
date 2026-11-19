// Reports opencode-native session and lifecycle state to Herdr TUI.
// Reads HERDR_* from the parent process because opencode-native strips them
// from the JS plugin host environment, and uses a non-"herdr:*" source so
// Herdr 0.9.5 accepts reports when the foreground binary is opencode-native.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";

export const VERSION = "2026.11.0";

const SOURCE = "opencode:native";
const ROUTE_POLL_INTERVAL_MS = 100;
const SELECTION_RETRY_DELAYS_MS = [100, 400, 1_000];
const BRIDGE_KEY = "__herdrNativeBridgeActive";
const WATCHER_KEY = "__herdrNativeBridgeWatcher";

const HERDR_KEYS = new Set([
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_AGENT",
  "HERDR_BIN_PATH",
]);

export interface HerdrEnv {
  HERDR_ENV?: string;
  HERDR_SOCKET_PATH?: string;
  HERDR_PANE_ID?: string;
  HERDR_AGENT?: string;
  HERDR_BIN_PATH?: string;
}

/** Parse NUL-separated proc environ text into known HERDR_* fields. */
export function parseEnviron(raw: string): HerdrEnv {
  const env: Record<string, string> = {};
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const key = entry.slice(0, eq);
    if (HERDR_KEYS.has(key)) {
      env[key] = entry.slice(eq + 1);
    }
  }
  return env;
}

/** Read HERDR_* coordinates from the parent opencode-native process env. */
export function readParentHerdrEnv(ppid = process.ppid): HerdrEnv {
  try {
    return parseEnviron(readFileSync(`/proc/${ppid}/environ`, "utf8"));
  } catch {
    return {};
  }
}

/** Release pane agent ownership when the parent opencode-native process exits. */
function watchParentExit(
  herdrBin: string,
  socketPath: string,
  agent: string,
  paneId: string,
): void {
  const state = globalThis as Record<string, unknown>;
  if (state[WATCHER_KEY]) return;
  state[WATCHER_KEY] = true;
  try {
    const watcher = spawn(
      "sh",
      [
        "-c",
        'tail --pid="$1" -f /dev/null 2>/dev/null; exec "$2" pane release-agent --source "$3" --agent "$4" "$5"',
        "herdr-release",
        String(process.ppid),
        herdrBin,
        SOURCE,
        agent,
        paneId,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, HERDR_SOCKET_PATH: socketPath },
      },
    );
    watcher.unref();
  } catch {
    state[WATCHER_KEY] = false;
  }
}

/** Send one JSON-line request to Herdr's Unix domain socket. */
export function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const endpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  const payload = {
    id: `${SOURCE}:${Date.now()}:${Math.floor(Math.random() * 1_000_000)
      .toString()
      .padStart(6, "0")}`,
    method,
    params,
  };

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      resolve(delivered);
    };
    const client = net.createConnection(endpoint, () => {
      if (!isCurrent()) {
        settle(false);
        return;
      }
      client.write(`${JSON.stringify(payload)}\n`);
    });
    timer = setTimeout(() => settle(false), 500);
    timer.unref?.();
    client.on("data", () => settle(true));
    client.on("error", () => settle(false));
    client.on("end", () => settle(false));
    client.on("close", () => settle(false));
  });
}

export interface SetupOptions {
  readEnv?: () => HerdrEnv;
  watchExit?: boolean;
  pollIntervalMs?: number;
}

export function setup(api: any, options: SetupOptions = {}): (() => void) | void {
  // Classic opencode keeps HERDR_* in process.env; let herdr-opencode own it.
  if (
    process.env.HERDR_ENV === "1" &&
    process.env.HERDR_SOCKET_PATH &&
    process.env.HERDR_PANE_ID
  ) {
    return;
  }

  const globals = globalThis as Record<string, unknown>;
  if (globals[BRIDGE_KEY]) {
    return;
  }

  const parent = (options.readEnv ?? readParentHerdrEnv)();
  const socketPath = parent.HERDR_SOCKET_PATH;
  const paneId = parent.HERDR_PANE_ID;
  if (parent.HERDR_ENV !== "1" || !socketPath || !paneId) {
    return;
  }

  globals[BRIDGE_KEY] = true;
  const agent = parent.HERDR_AGENT || "opencode";
  const herdrBin = parent.HERDR_BIN_PATH || "herdr";
  if (options.watchExit !== false) {
    watchParentExit(herdrBin, socketPath, agent, paneId);
  }

  let disposed = false;
  let selected: string | undefined;
  let generation = 0;
  let sequence = Date.now() * 1000;
  let chain = Promise.resolve();
  let retryIndex = 0;
  let nextSelectionAt = 0;
  let state = "idle";
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const sessions = new Map<string, { id: string; parentID?: string }>();
  let blockers = new Map<string, string>();
  const blockerChanges = new Map<
    string,
    { id: string; kind: string; present: boolean }
  >();

  function root(id: string | undefined): string | undefined {
    const seen = new Set<string>();
    while (typeof id === "string" && !seen.has(id)) {
      seen.add(id);
      const session = api.data.session.get(id) ?? sessions.get(id);
      if (!session) return;
      if (!session.parentID) return id;
      id = session.parentID;
    }
  }

  function current(): string | undefined {
    const route = api.ui.router.current();
    return route.type === "session" ? root(route.sessionID) : undefined;
  }

  function enqueue(value: string | undefined): void {
    const sessionID = selected;
    const revision = generation;
    const isCurrent = () =>
      !disposed && revision === generation && !!sessionID && current() === sessionID;
    chain = chain
      .then(async () => {
        if (!isCurrent() || !sessionID) return;
        const method =
          value === undefined ? "pane.report_agent_session" : "pane.report_agent";
        const params = {
          pane_id: paneId,
          source: SOURCE,
          agent,
          agent_session_id: sessionID,
          ...(value === undefined
            ? { session_start_source: "select" }
            : {
                state: value,
                seq: ++sequence,
                resume_argv: ["opencode-native", "-s", sessionID],
              }),
        };
        const delivered = await sendRequest(socketPath!, method, params, isCurrent);
        if (!delivered) scheduleStateRetry();
      })
      .catch(() => {});
  }

  function scheduleStateRetry(): void {
    if (disposed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      publish();
    }, 500);
    retryTimer.unref?.();
  }

  function publish(): void {
    enqueue(blockers.size ? "blocked" : state);
  }

  function changeBlocker(
    id: string,
    kind: string,
    requestID: unknown,
    present: boolean,
  ): void {
    if (typeof requestID !== "string") return;
    const key = `${kind}:${requestID}`;
    blockerChanges.set(key, { id, kind, present });
    if (present) blockers.set(key, id);
    else blockers.delete(key);
  }

  function reconcileBlockers(): boolean {
    if (!selected) return false;
    const next = new Map<string, string>();
    const hydrated = new Set<string>();
    const members = new Set([
      selected,
      ...api.data.session.family(selected),
      ...blockers.values(),
    ]);
    for (const member of members) {
      if (root(member) !== selected) continue;
      for (const kind of ["permission", "form"] as const) {
        const items = api.data.session[kind].list(member);
        if (items === undefined) {
          for (const [key, owner] of blockers) {
            if (owner === member && key.startsWith(`${kind}:`)) next.set(key, owner);
          }
          continue;
        }
        hydrated.add(`${kind}:${member}`);
        for (const item of items) next.set(`${kind}:${item.id}`, member);
      }
    }
    for (const [key, change] of blockerChanges) {
      if (
        hydrated.has(`${change.kind}:${change.id}`) &&
        next.has(key) === change.present
      ) {
        blockerChanges.delete(key);
      } else if (change.present) {
        next.set(key, change.id);
      } else {
        next.delete(key);
      }
    }
    const changed = (blockers.size > 0) !== (next.size > 0);
    blockers = next;
    return changed;
  }

  function syncSelection(): void {
    if (disposed) return;
    const id = current();
    if (id !== selected) {
      selected = id;
      generation += 1;
      retryIndex = 0;
      nextSelectionAt = 0;
      blockers.clear();
      blockerChanges.clear();
      if (id) {
        state = api.data.session.status(id) === "running" ? "working" : "idle";
      }
    }
    if (!id) return;
    const blockersChanged = reconcileBlockers();
    if (Date.now() < nextSelectionAt) {
      if (blockersChanged) publish();
      return;
    }
    enqueue(undefined);
    publish();
    const delay = SELECTION_RETRY_DELAYS_MS[retryIndex++];
    nextSelectionAt =
      delay === undefined ? Number.POSITIVE_INFINITY : Date.now() + delay;
  }

  function receive({ details: event }: { details: any }): void {
    if (disposed) return;
    const data = event?.data;
    if (data == null) return;
    if (event.type === "session.created") {
      sessions.set(data.sessionID, { id: data.sessionID, parentID: data.parentID });
    }
    if (event.type === "session.deleted") {
      const affected =
        data.sessionID === selected || [...blockers.values()].includes(data.sessionID);
      sessions.delete(data.sessionID);
      for (const [key, owner] of blockers) {
        if (owner === data.sessionID) blockers.delete(key);
      }
      for (const [key, change] of blockerChanges) {
        if (change.id === data.sessionID) blockerChanges.delete(key);
      }
      syncSelection();
      if (selected && affected) publish();
      return;
    }
    syncSelection();
    const id = event.type === "form.created" ? data.form.sessionID : data.sessionID;
    if (!selected || root(id) !== selected) return;
    switch (event.type) {
      case "permission.asked":
        changeBlocker(id, "permission", data.id, true);
        break;
      case "permission.replied":
        changeBlocker(id, "permission", data.requestID, false);
        break;
      case "form.created":
        changeBlocker(id, "form", data.form.id, true);
        break;
      case "form.replied":
      case "form.cancelled":
        changeBlocker(id, "form", data.id, false);
        break;
      case "session.execution.started":
        if (id !== selected) return;
        state = "working";
        break;
      case "session.execution.succeeded":
      case "session.execution.interrupted":
        if (id !== selected) return;
        state = "idle";
        break;
      case "session.execution.failed":
        if (id !== selected) return;
        state = "blocked";
        break;
      default:
        return;
    }
    publish();
  }

  const unsubscribe = api.data.listen(receive);
  syncSelection();
  const poll = setInterval(
    syncSelection,
    options.pollIntervalMs ?? ROUTE_POLL_INTERVAL_MS,
  );

  return () => {
    disposed = true;
    globals[BRIDGE_KEY] = false;
    generation += 1;
    clearTimeout(retryTimer);
    clearInterval(poll);
    unsubscribe();
    sessions.clear();
    blockers.clear();
    blockerChanges.clear();
    void sendRequest(socketPath, "pane.release_agent", {
      pane_id: paneId,
      source: SOURCE,
      agent,
      seq: ++sequence,
    });
  };
}

export default {
  id: "herdr.opencode.native-bridge",
  setup,
};
