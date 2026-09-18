/**
 * The seam between "how we perceive and act on a surface" and everything else.
 *
 * Discovery, replay, and the operator console only ever see an Observation
 * (a compact tree of named controls with stable refs) and issue SurfaceActions
 * against refs. A web surface builds Observations from the DOM; a desktop
 * surface would build the same shape from the OS accessibility API.
 */
import type { Target } from "../schema/capability.js";

export type NodeInfo = {
  ref: string;
  frame: string[];
  role: string;
  name: string;
  tag: string;
  type?: string;
  attrs: Record<string, string>;
  text: string;
  value?: string;
  anchor?: string;                              // label-ish text left of / above a field
  cell?: { column: string; rowText: string[] };  // for cells inside a table that has a header row
  options?: string[];
  disabled?: boolean;
  dialog?: string;                              // name of the enclosing dialog container, if any
  depth: number;
  css: string;
  bbox: { x: number; y: number; w: number; h: number };
};

export type DialogInfo = { type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string };

export type Observation = {
  at: string;
  url: string;
  title: string;
  frames: { path: string[]; url: string }[];
  nodes: NodeInfo[];
  tree: string;                 // rendered for humans and for the model
  dialog?: DialogInfo;          // a native dialog is open; the page is blocked until it is answered
  screenshot?: Buffer;
};

export type SurfaceAction =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "press"; ref?: string; key: string }
  | { kind: "dialog"; respond: "accept" | "dismiss"; text?: string };

export type Resolution =
  | { ok: true; ref: string; node: NodeInfo; strategyIndex: number; strategy: string }
  | { ok: false; reason: "not_found" | "ambiguous"; detail: string };

export interface Surface {
  readonly driver: string;
  observe(opts?: { screenshot?: boolean }): Promise<Observation>;
  act(action: SurfaceAction): Promise<void>;
  resolve(target: Target, observation: Observation): Resolution;
  screenshot(): Promise<Buffer>;
  url(): string;
  pendingDialog(): DialogInfo | undefined;
  close(): Promise<void>;
}
