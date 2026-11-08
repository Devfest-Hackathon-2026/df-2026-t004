import { describe, expect, it } from "vitest";
import { TYPES, validatePrTitle } from "./check-pr-title.mjs";

describe("validatePrTitle: 合格", () => {
  it.each([
    "feat(web): add bottom tab bar",
    "fix(api): return 403 for other users' data",
    "docs: add Google Cloud setup guide",
    "feat(shared)!: rename ageBands to ageBandTags",
    "build(deps): bump hono from 4.13.13 to 4.13.14",
    "build(deps): bump the npm-dev group across 1 directory with 5 updates",
    'revert: revert "feat(web): add tab bar"',
    "security: add ownership, rules and log redaction tests",
    "ci: add security and test workflows",
  ])("%s", (title) => {
    expect(validatePrTitle(title)).toEqual([]);
  });

  it("規約の type はすべて使える", () => {
    for (const type of TYPES) {
      expect(validatePrTitle(`${type}: do something`)).toEqual([]);
    }
  });
});

describe("validatePrTitle: 不合格", () => {
  it.each([
    ["type なし", "add bottom tab bar"],
    ["一覧にない type", "feature(web): add tab bar"],
    ["大文字の type", "Feat(web): add tab bar"],
    ["コロンの後の空白なし", "feat(web):add tab bar"],
    ["大文字の scope", "feat(Web): add tab bar"],
    ["summary が大文字始まり", "feat(web): Add tab bar"],
    ["末尾のピリオド", "feat(web): add tab bar."],
    ["空の summary", "feat(web): "],
    ["日本語のみ", "タブバーを追加"],
    ["空", ""],
  ])("%s", (_name, title) => {
    expect(validatePrTitle(title).length).toBeGreaterThan(0);
  });

  it("73文字以上は不合格", () => {
    const title = `feat: ${"a".repeat(67)}`;
    expect(title.length).toBe(73);
    expect(validatePrTitle(title)).toEqual([expect.stringContaining("72文字以内")]);
    expect(validatePrTitle(title.slice(0, 72))).toEqual([]);
  });
});
