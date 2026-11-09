import { describe, expect, it } from "vitest";
import { LEGAL_VERSION, PRIVACY, TERMS } from "../src/legal/content.js";

const text = (doc: typeof PRIVACY) =>
  doc.sections.flatMap((s) => [s.heading, ...s.paragraphs, ...(s.items ?? [])]).join("\n");

describe("プライバシーポリシーの必須記載（Requirement 9.12, 9.15）", () => {
  const body = text(PRIVACY);

  it("利用者データを東京リージョンに保存し、認証情報は海外で処理される場合があると明示する", () => {
    expect(body).toContain("東京リージョン");
    expect(body).toMatch(
      /認証情報.*東京リージョン以外（米国などの海外を含む）で処理される場合があります/,
    );
  });

  it("質問文が Vertex AI に送られること、送る範囲（マスク後）、保持条件の項目を明示する", () => {
    expect(body).toContain("Vertex AI");
    expect(body).toMatch(/電話番号・メールアドレス・郵便番号を固定の文字/);
    expect(body).toContain("保持の有無と期間");
  });

  it("要配慮個人情報の利用目的と同意・撤回を明示し、AI に送らないと書く", () => {
    expect(body).toContain("要配慮個人情報");
    expect(body).toMatch(/同意した場合にだけ保存/);
    expect(body).toMatch(/同意を取り消せます/);
    expect(body).toMatch(/AI（外部の AI サービス）には送りません/);
  });
});

describe("利用規約", () => {
  it("対象の可能性であること、申請を代行しないこと、診断をしないことを書く", () => {
    const body = text(TERMS);
    expect(body).toContain("対象の可能性");
    expect(body).toContain("申請を行いません");
    expect(body).toMatch(/診断/);
  });

  it("2つの文書は同じ版を持つ（同意の記録に使う）", () => {
    expect(TERMS.version).toBe(LEGAL_VERSION);
    expect(PRIVACY.version).toBe(LEGAL_VERSION);
  });
});
