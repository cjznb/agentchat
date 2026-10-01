import { describe, expect, it, vi } from "vitest";
import {
  STORAGE_KEY,
  defaultMdView,
  notify,
  readMdScope,
  subscribe,
  writeMdScope,
} from "../mdScope";

function memStorage(init?: Record<string, string>) {
  const m = new Map<string, string>(Object.entries(init ?? {}));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

describe("mdScope storage", () => {
  it("write then read roundtrip", () => {
    const s = memStorage();
    writeMdScope(s, "agent");
    expect(s.m.get(STORAGE_KEY)).toBe("agent");
    expect(readMdScope(s)).toBe("agent");
  });

  it("missing key falls back to all", () => {
    expect(readMdScope(memStorage())).toBe("all");
  });

  it("illegal value falls back to all", () => {
    expect(readMdScope(memStorage({ [STORAGE_KEY]: "nope" }))).toBe("all");
    expect(readMdScope(memStorage({ [STORAGE_KEY]: "" }))).toBe("all");
  });
});

describe("defaultMdView full table", () => {
  const cases: Array<[Parameters<typeof defaultMdView>[0], boolean, "md" | "raw"]> = [
    ["all", true, "md"],
    ["all", false, "md"],
    ["agent", true, "md"],
    ["agent", false, "raw"],
    ["off", true, "raw"],
    ["off", false, "raw"],
  ];
  for (const [scope, isAgent, want] of cases) {
    it(`${scope} + ${isAgent ? "agent" : "user"} -> ${want}`, () => {
      expect(defaultMdView(scope, isAgent)).toBe(want);
    });
  }
});

describe("subscribe / notify", () => {
  it("notify delivers scope to subscribers", () => {
    const fn = vi.fn();
    const off = subscribe(fn);
    notify("agent");
    expect(fn).toHaveBeenCalledWith("agent");
    off();
  });

  it("unsubscribed fn no longer called; other fns unaffected", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    subscribe(b);
    offA();
    notify("off");
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith("off");
  });
});
