import type { ReactNode } from "react";

/**
 * The equipment comparison: a setup drawn as its signal path, mics into the interface, the interface through its
 * cable (and adapter) into the buyer's computer, with headphone feeds and the remote guest's route alongside.
 * Missing parts and the connections they break are marked; parts a rebuild adds are marked as new.
 */
export type PartStatus = "kept" | "added" | "missing" | "removed";
export interface DiagramPart { id: string; name: string; role: string; qty: number; status?: PartStatus; attrs?: Record<string, any> }
export interface DiagramGoal { localPeople: number | null; remoteGuests: number | null; hostPort: string | null; os: string | null; callApp: string | null }

const PORT: Record<string, string> = { "usb-c": "USB-C", "usb-a": "USB-A", "usb-b": "USB-B", xlr: "XLR" };
const APP: Record<string, string> = { zoom: "Zoom", "google-meet": "Google Meet", riverside: "Riverside", other: "a call app" };
const OS: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };
const ROLE: Record<string, string> = { micCable: "mic_cable", hostCable: "host_cable" };
const LABEL: Record<string, string> = { mic: "Microphone", interface: "Audio interface", host_cable: "Computer cable", adapter: "Adapter", computer: "Computer", headphones: "Headphones", stand: "Stand", mic_cable: "Mic cable", splitter: "Splitter" };
export const normRole = (r: string) => ROLE[r] ?? r;

/** Read a fact by either the public (snake_case) or internal (camelCase) attribute name. */
function fact(p: DiagramPart | undefined, ...keys: string[]): any {
  if (!p?.attrs) return undefined;
  for (const k of keys) { const v = p.attrs[k]; if (v !== undefined) return v && typeof v === "object" && "value" in v ? v.value : v; }
  return undefined;
}
const port = (v: unknown) => (typeof v === "string" ? PORT[v] ?? v : "?");

function specOf(p: DiagramPart): string {
  switch (normRole(p.role)) {
    case "mic": return fact(p, "output") === "xlr" ? "XLR output" : `${port(fact(p, "output"))}${fact(p, "monitor_jack", "monitorJack") ? ", headphone jack" : ""}`;
    case "interface": {
      const lb = fact(p, "loopback");
      return `${fact(p, "preamps") ?? "?"} inputs · ${port(fact(p, "host_port", "hostPort"))} · ${lb === true ? "loopback" : lb === false ? "no loopback" : "loopback unknown"}`;
    }
    case "host_cable": return `${port(fact(p, "device_end", "deviceEnd"))} to ${port(fact(p, "host_end", "hostEnd"))}`;
    case "adapter": return `${port(fact(p, "from"))} to ${port(fact(p, "to"))}`;
    case "headphones": return fact(p, "type") === "open" ? "Open-back" : "Closed-back";
    default: return "";
  }
}

export function RoleIcon({ role }: { role: string }) {
  const r = normRole(role);
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (r) {
    case "mic": return <svg {...common}><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" /><path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5M5.5 14.5h5" /></svg>;
    case "interface": return <svg {...common}><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><circle cx="5" cy="8" r="1.4" /><circle cx="9" cy="8" r="1.4" /><path d="M12 7v2" /></svg>;
    case "host_cable": case "mic_cable": return <svg {...common}><path d="M2 12c3 0 3-8 6-8s3 8 6 8" /><path d="M1.5 12h1.5M13 12h1.5" /></svg>;
    case "adapter": return <svg {...common}><rect x="4" y="5" width="8" height="6" rx="1" /><path d="M1.5 8H4M12 8h2.5M6.5 7v2M9.5 7v2" /></svg>;
    case "computer": return <svg {...common}><rect x="2.5" y="3" width="11" height="7.5" rx="1" /><path d="M1 13h14" /></svg>;
    case "headphones": return <svg {...common}><path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2" /><rect x="1.8" y="9.5" width="2.8" height="4.5" rx="1" /><rect x="11.4" y="9.5" width="2.8" height="4.5" rx="1" /></svg>;
    case "guest": return <svg {...common}><circle cx="6" cy="5" r="2.5" /><path d="M1.5 14c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11.5 4.5a3 3 0 0 1 0 4M13.2 3a5 5 0 0 1 0 7" /></svg>;
    default: return <svg {...common}><circle cx="8" cy="8" r="5" /></svg>;
  }
}

const TAG: Record<PartStatus, string | null> = { kept: null, added: "New", missing: "Missing", removed: "Leaves" };

function PartTile({ part, role, spec, host }: { part?: DiagramPart; role: string; spec?: string; host?: boolean }) {
  const status = part?.status ?? "kept";
  const tag = part ? TAG[status] : null;
  return (
    <div className={`part ${status} ${host ? "host" : ""}`} aria-label={`${LABEL[role] ?? role}: ${part?.name ?? spec}${tag ? `, ${tag.toLowerCase()}` : ""}`}>
      {part && part.qty > 1 && <span className="qty">×{part.qty}</span>}
      <span className="role"><RoleIcon role={role} />{LABEL[role] ?? role}</span>
      <span className="name">{part?.name ?? spec}</span>
      {part && <span className="spec">{spec ?? specOf(part)}</span>}
      {!part && host && null}
      {tag && <span className="tag">{tag}</span>}
    </div>
  );
}

/** A connection between two parts. Its label is for assistive technology; a mismatch is marked on the line. */
function Link({ label, state }: { label: string; state: "ok" | "broken" | "new" }) {
  return <li className={`link ${state === "ok" ? "" : state}`} aria-label={`${state === "broken" ? "Broken connection" : "Connection"}: ${label}`}><i aria-hidden />{label.includes("≠") && <b aria-hidden title={label}>×</b>}</li>;
}

export function SetupDiagram({ parts, goal, label, caption }: { parts: DiagramPart[]; goal: DiagramGoal; label: string; caption?: ReactNode }) {
  const live = parts.filter((p) => p.status !== "removed");
  const one = (role: string) => live.find((p) => normRole(p.role) === role);
  const mic = one("mic"), iface = one("interface"), cable = one("host_cable"), adapter = one("adapter");
  const usbMic = !!mic && fact(mic, "output") !== "xlr" && !iface;
  const missingIface = iface?.status === "missing";
  const isNew = (...ps: (DiagramPart | undefined)[]) => ps.some((p) => p?.status === "added");
  const nodes: ReactNode[] = [];
  const pushLink = (key: string, label: string, state: "ok" | "broken" | "new") => nodes.push(<Link key={key} label={label} state={state} />);

  if (mic) nodes.push(<li key="mic"><PartTile part={mic} role="mic" /></li>);
  if (!usbMic) {
    if (mic) pushLink("l1", "XLR", missingIface ? "broken" : isNew(mic, iface) ? "new" : "ok");
    nodes.push(<li key="if">{iface ? <PartTile part={iface} role="interface" /> : <PartTile role="interface" spec="Needed" />}</li>);
    const ifPort = fact(iface, "host_port", "hostPort");
    if (cable) {
      const devEnd = fact(cable, "device_end", "deviceEnd");
      const fits = ifPort === devEnd;
      pushLink("l2", fits ? port(ifPort) : `${port(ifPort)} ≠ ${port(devEnd)}`, missingIface || !fits ? "broken" : isNew(iface, cable) ? "new" : "ok");
      nodes.push(<li key="cable"><PartTile part={cable} role="host_cable" /></li>);
    }
    const hostEnd = fact(cable, "host_end", "hostEnd");
    if (adapter) {
      const fits = fact(adapter, "from") === hostEnd;
      pushLink("l3", fits ? port(hostEnd) : `${port(hostEnd)} ≠ ${port(fact(adapter, "from"))}`, !fits ? "broken" : isNew(cable, adapter) ? "new" : "ok");
      nodes.push(<li key="adapter"><PartTile part={adapter} role="adapter" /></li>);
    }
    const reach = adapter ? fact(adapter, "to") : hostEnd;
    const fitsHost = reach === goal.hostPort;
    pushLink("l4", fitsHost ? port(goal.hostPort) : `${port(reach)} ≠ ${port(goal.hostPort)}`, missingIface || !fitsHost ? "broken" : isNew(cable, adapter) ? "new" : "ok");
  } else pushLink("l1", port(fact(mic, "output")), isNew(mic) ? "new" : "ok");
  nodes.push(<li key="pc"><PartTile role="computer" spec={`${port(goal.hostPort)} port, ${OS[goal.os ?? ""] ?? "?"}`} host /></li>);

  const phones = one("headphones");
  const stand = one("stand");
  const cables = one("mic_cable");
  const splitter = one("splitter");
  const remote = (goal.remoteGuests ?? 0) > 0;
  const loopback = usbMic ? true : fact(iface, "loopback") === true && !missingIface;
  const removed = parts.filter((p) => p.status === "removed");
  return (
    <figure className="diagram" aria-label={label}>
      <ol className="chain">{nodes}</ol>
      <div className="side">
        {phones && <span className={phones.status === "missing" ? "broken" : ""}><RoleIcon role="headphones" />{phones.qty}× {phones.name}{phones.status === "added" ? " (new)" : ""}</span>}
        {cables && <span><RoleIcon role="mic_cable" />{cables.qty}× {cables.name}</span>}
        {stand && <span>{stand.qty}× {stand.name}</span>}
        {splitter && <span>{splitter.name}{splitter.status === "added" ? " (new)" : ""}</span>}
        {remote && <span className={loopback ? "" : "broken"}><RoleIcon role="guest" />Remote guest on {APP[goal.callApp ?? "other"] ?? "a call app"}: {loopback ? "hears the room through loopback" : "cannot hear the room"}</span>}
      </div>
      {(caption || removed.length > 0) && (
        <figcaption>
          {removed.length > 0 && <span>Leaves the order: {removed.map((r) => r.name).join(", ")}. </span>}
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
