import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { installHint, isIos, isStandalone } from "../src/lib/pwa.js";
import { TAB_ITEMS, showsTabBar } from "../src/lib/tabs.js";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36";

describe("インストール案内（Requirement 11.2）", () => {
  it("iPhone と、タッチ対応の iPadOS を iOS と判定する", () => {
    expect(isIos(IPHONE)).toBe(true);
    expect(isIos(IPAD_DESKTOP, 5)).toBe(true);
    expect(isIos(IPAD_DESKTOP, 0)).toBe(false);
    expect(isIos(ANDROID, 5)).toBe(false);
  });

  it("スタンドアロンで起動中、または閉じたあとは案内を出さない", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(IPHONE, ANDROID, IPAD_DESKTOP),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (ua, standalone, hasPrompt, dismissed) => {
          const hint = installHint({
            userAgent: ua,
            maxTouchPoints: 5,
            standalone,
            hasPrompt,
            dismissed,
          });
          if (standalone || dismissed) expect(hint).toBeNull();
          else if (hasPrompt) expect(hint).toBe("prompt");
          else expect(hint).toBe(ua === ANDROID ? null : "ios");
        },
      ),
    );
  });

  it("display-mode と navigator.standalone のどちらかで判定する", () => {
    expect(isStandalone(true)).toBe(true);
    expect(isStandalone(false, true)).toBe(true);
    expect(isStandalone(false)).toBe(false);
  });
});

describe("下部タブバー（Requirement 11.5）", () => {
  it("ホーム、さがす、AI相談、マイホームの順でちょうど4項目", () => {
    expect(TAB_ITEMS.map((t) => t.label)).toEqual(["ホーム", "さがす", "AI相談", "マイホーム"]);
  });

  it("主要画面ではタブバーを出し、登録・オンボーディングでは出さない", () => {
    for (const p of ["/home", "/search", "/chat", "/my", "/my/expenses", "/programs/abc"])
      expect(showsTabBar(p)).toBe(true);
    for (const p of ["/", "/onboarding/postal", "/homework", "/deleted"])
      expect(showsTabBar(p)).toBe(false);
  });
});
