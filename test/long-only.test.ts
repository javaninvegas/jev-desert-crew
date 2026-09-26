// Fork: spot from the US, so shorts never reach Jev or execution.
import { describe, expect, it } from "vitest";
import { isBlockedShort, longOnlyMenu, type Menu } from "../src/bees/types.js";

describe("long only", () => {
  const menu: Menu = {
    HOLD: { desc: null, intent: { kind: "hold" } },
    LONG_BTC: { desc: null, intent: { kind: "open", instId: "BTC_USD", side: "long", sizeFrac: 1, setup: "strict" } },
    SHORT_BTC: { desc: null, intent: { kind: "open", instId: "BTC_USD", side: "short", sizeFrac: 1, setup: "strict" } },
    FLIP_ETH_SHORT: { desc: null, intent: { kind: "switch", instId: "ETH_USD", side: "short", sizeFrac: 1, setup: "loose" } },
    CLOSE: { desc: null, intent: { kind: "close", reason: "x" } },
  };
  it("removes every short open and switch from the menu Jev sees", () => {
    expect(Object.keys(longOnlyMenu(menu)).sort()).toEqual(["CLOSE", "HOLD", "LONG_BTC"]);
  });
  it("flags short entries for the risk layer to veto, and nothing else", () => {
    expect(isBlockedShort(menu.SHORT_BTC!.intent)).toBe(true);
    expect(isBlockedShort(menu.FLIP_ETH_SHORT!.intent)).toBe(true);
    expect(isBlockedShort(menu.LONG_BTC!.intent)).toBe(false);
    expect(isBlockedShort(menu.CLOSE!.intent)).toBe(false);
  });
});
