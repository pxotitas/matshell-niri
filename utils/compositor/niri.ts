import { Gdk } from "ags/gtk4";
import app from "ags/gtk4/app";
import { exec } from "ags/process";
import { createComputed, createState, Accessor } from "ags";
import Gio from "gi://Gio?version=2.0";
import GLib from "gi://GLib?version=2.0";
import { CompositorAdapter, Monitor, Workspace, Client } from "./types";

type NiriWorkspace = {
  id: number;
  idx: number;
  name: string | null;
  output: string;
  is_urgent: boolean;
  is_active: boolean;
  is_focused: boolean;
  active_window_id: number | null;
};

type NiriWindow = {
  id: number;
  title: string;
  app_id: string;
  workspace_id: number | null;
  is_focused: boolean;
  is_floating: boolean;
  is_urgent: boolean;
};

function readFocusedOutput(): string {
  try {
    const output = JSON.parse(exec("niri msg --json focused-output"));
    return output.name ?? "";
  } catch {
    return "";
  }
}

function readMonitors(): Monitor[] {
  const focused = readFocusedOutput();
  return app.get_monitors().map((monitor: Gdk.Monitor) => {
    const geometry = monitor.get_geometry();
    const name = monitor.get_connector() ?? "";
    return {
      name,
      width: geometry.width,
      height: geometry.height,
      x: geometry.x,
      y: geometry.y,
      focused: name === focused,
      scale: monitor.get_scale_factor(),
    };
  });
}

function toWorkspace(workspace: NiriWorkspace): Workspace {
  return {
    id: workspace.id,
    name: workspace.name ?? String(workspace.idx),
    index: workspace.idx,
    focused: workspace.is_focused,
    occupied: workspace.active_window_id !== null,
    monitor: workspace.output,
    urgent: workspace.is_urgent,
  };
}

export class NiriAdapter implements CompositorAdapter {
  readonly name = "niri";
  readonly focusedMonitor: Accessor<Monitor | null>;
  readonly monitors: Accessor<Monitor[]>;
  readonly focusedWorkspace: Accessor<Workspace | null>;
  readonly workspaces: Accessor<Workspace[]>;
  readonly focusedClient: Accessor<Client | null>;
  readonly clients: Accessor<Client[]>;

  private readonly setWorkspaces: (value: Workspace[]) => void;
  private readonly setClients: (value: Client[]) => void;
  private readonly setMonitors: (value: Monitor[]) => void;
  private rawWorkspaces: NiriWorkspace[] = [];
  private rawWindows: NiriWindow[] = [];
  private stream: Gio.Subprocess | null = null;

  constructor() {
    const [workspaces, setWorkspaces] = createState<Workspace[]>([]);
    const [clients, setClients] = createState<Client[]>([]);
    const [monitors, setMonitors] = createState<Monitor[]>(readMonitors());
    this.workspaces = workspaces;
    this.clients = clients;
    this.setWorkspaces = setWorkspaces;
    this.setClients = setClients;
    this.setMonitors = setMonitors;
    this.monitors = monitors;
    this.focusedWorkspace = createComputed([workspaces], (items) =>
      items.find((workspace) => workspace.focused) ?? null,
    );
    this.focusedMonitor = createComputed([monitors], (items) =>
      items.find((monitor) => monitor.focused) ?? null,
    );
    this.focusedClient = createComputed([clients], (items) =>
      items.find((client) => client.focused) ?? null,
    );

    if (!GLib.getenv("NIRI_SOCKET")) {
      throw new Error("NIRI_SOCKET is not set; Matshell is not running inside Niri.");
    }

    const display = Gdk.Display.get_default();
    display?.connect("monitor-added", () => this.refreshMonitors());
    display?.connect("monitor-removed", () => this.refreshMonitors());
    this.startEventStream();
  }

  private refreshMonitors(): void {
    const focused = readFocusedOutput();
    this.setMonitors(readMonitors().map((monitor) => ({
      ...monitor,
      focused: monitor.name === focused,
    })));
  }

  private publish(): void {
    const workspaceById = new Map(this.rawWorkspaces.map((workspace) => [workspace.id, workspace]));
    this.setWorkspaces(this.rawWorkspaces.map((workspace) => ({
      ...toWorkspace(workspace),
      occupied: this.rawWindows.some((window) => window.workspace_id === workspace.id),
    })));
    this.setClients(this.rawWindows.map((window) => {
      const workspace = window.workspace_id === null ? undefined : workspaceById.get(window.workspace_id);
      return {
        address: String(window.id),
        title: window.title,
        class: window.app_id,
        workspace: window.workspace_id ?? 0,
        monitor: workspace?.output ?? "",
        floating: window.is_floating,
        fullscreen: false,
        focused: window.is_focused,
      };
    }));
  }

  private handleEvent(event: any): void {
    if (event.WorkspacesChanged) {
      this.rawWorkspaces = event.WorkspacesChanged.workspaces;
      this.publish();
    } else if (event.WindowsChanged) {
      this.rawWindows = event.WindowsChanged.windows;
      this.publish();
    } else if (event.WindowOpenedOrChanged) {
      const next = event.WindowOpenedOrChanged.window as NiriWindow;
      this.rawWindows = [
        ...this.rawWindows
          .filter((window) => window.id !== next.id)
          .map((window) => ({ ...window, is_focused: next.is_focused ? false : window.is_focused })),
        next,
      ];
      this.publish();
    } else if (event.WindowClosed) {
      this.rawWindows = this.rawWindows.filter((window) => window.id !== event.WindowClosed.id);
      this.publish();
    } else if (event.WindowFocusChanged) {
      const focusedId = event.WindowFocusChanged.id;
      this.rawWindows = this.rawWindows.map((window) => ({ ...window, is_focused: window.id === focusedId }));
      this.publish();
    } else if (event.WorkspaceActivated) {
      const { id, focused } = event.WorkspaceActivated;
      this.rawWorkspaces = this.rawWorkspaces.map((workspace) => ({
        ...workspace,
        is_active: workspace.output === this.rawWorkspaces.find((item) => item.id === id)?.output
          ? workspace.id === id
          : workspace.is_active,
        is_focused: focused ? workspace.id === id : workspace.is_focused,
      }));
      if (focused) {
        const output = this.rawWorkspaces.find((workspace) => workspace.id === id)?.output;
        this.setMonitors(readMonitors().map((monitor) => ({
          ...monitor,
          focused: monitor.name === output,
        })));
      }
      this.publish();
    } else if (event.WorkspaceActiveWindowChanged) {
      const { workspace_id, active_window_id } = event.WorkspaceActiveWindowChanged;
      this.rawWorkspaces = this.rawWorkspaces.map((workspace) =>
        workspace.id === workspace_id ? { ...workspace, active_window_id } : workspace,
      );
      this.publish();
    } else if (event.WorkspaceUrgencyChanged) {
      const { id, urgent } = event.WorkspaceUrgencyChanged;
      this.rawWorkspaces = this.rawWorkspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, is_urgent: urgent } : workspace,
      );
      this.publish();
    } else if (event.WindowUrgencyChanged) {
      const { id, urgent } = event.WindowUrgencyChanged;
      this.rawWindows = this.rawWindows.map((window) =>
        window.id === id ? { ...window, is_urgent: urgent } : window,
      );
      this.publish();
    }
  }

  private readNextLine(input: Gio.DataInputStream): void {
    input.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, result) => {
      try {
        const [line] = input.read_line_finish(result);
        if (!line) return;
        const event = JSON.parse(new TextDecoder().decode(line));
        this.handleEvent(event);
        this.readNextLine(input);
      } catch (error) {
        console.error("Matshell Niri event stream:", error);
      }
    });
  }

  private startEventStream(): void {
    try {
      this.stream = Gio.Subprocess.new(
        ["niri", "msg", "--json", "event-stream"],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );
      const input = new Gio.DataInputStream({ base_stream: this.stream.get_stdout_pipe() });
      this.readNextLine(input);
    } catch (error) {
      console.error("Failed to connect to Niri IPC event stream:", error);
    }
  }

  isAvailable(): boolean {
    return Boolean(GLib.getenv("NIRI_SOCKET"));
  }

  focusWorkspace(id: string | number): void {
    const workspace = this.rawWorkspaces.find((item) => String(item.id) === String(id));
    if (!workspace) return;
    try {
      exec(`niri msg action focus-monitor ${GLib.shell_quote(workspace.output)}`);
      exec(`niri msg action focus-workspace ${GLib.shell_quote(workspace.name ?? String(workspace.idx))}`);
    } catch (error) {
      console.error("Failed to focus Niri workspace:", error);
    }
  }

  focusClient(id: string): void {
    try {
      exec(`niri msg action focus-window --id ${GLib.shell_quote(id)}`);
    } catch (error) {
      console.error("Failed to focus Niri window:", error);
    }
  }

  matchMonitor(compositorMonitor: Monitor): Gdk.Monitor | null {
    const monitors = app.get_monitors();
    return monitors.find((monitor) => monitor.get_connector() === compositorMonitor.name) ?? null;
  }
}
