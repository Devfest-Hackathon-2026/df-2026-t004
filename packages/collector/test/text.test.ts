import { describe, expect, it } from "vitest";
import {
  decodeHtml,
  extractSections,
  hashSections,
  htmlToSections,
  normalizeText,
  pdfToSections,
} from "../src/index.js";
import { makePdf } from "./support/pdf.js";

describe("htmlToSections", () => {
  it("本文の範囲だけを見出しごとに区切り、メニューやスクリプトを除く", () => {
    const html = `<!doctype html><html><head><title>t</title><style>p{}</style></head><body>
      <header><nav><a href="/">トップ</a></nav></header>
      <main>
        <h1>児童手当</h1>
        <p>中学生までの子を養育する人に支給します。</p>
        <script>var x = "広告";</script>
        <h2>申請方法</h2>
        <ul><li>出生届のあと</li><li>15日以内に申請</li></ul>
        <!-- コメント -->
        <h3></h3>
        <p>窓口:  子育て支援課</p>
      </main>
      <footer>著作権表示</footer>
    </body></html>`;
    expect(htmlToSections(html)).toEqual([
      { heading: "児童手当", text: "中学生までの子を養育する人に支給します。" },
      { heading: "申請方法", text: "出生届のあと\n15日以内に申請" },
      { text: "窓口: 子育て支援課" },
    ]);
  });

  it("main が無ければ article、それも無ければ body を使う", () => {
    expect(htmlToSections("<body><div>外</div><article><p>本文</p></article></body>")).toEqual([
      { text: "本文" },
    ]);
    expect(htmlToSections("<body><p>本文だけ</p></body>")).toEqual([{ text: "本文だけ" }]);
  });

  it("本文が無ければ空", () => {
    expect(htmlToSections("<body><nav>メニュー</nav></body>")).toEqual([]);
  });
});

describe("normalizeText", () => {
  it("行ごとに空白をまとめ、空行を除く", () => {
    expect(normalizeText("  a \t b \n\n　\n c  ")).toBe("a b\nc");
  });
});

describe("decodeHtml", () => {
  it("Content-Type、meta の順に文字コードを決める", () => {
    const sjis = new Uint8Array([0x82, 0xa0]); // 「あ」
    expect(decodeHtml(sjis, "text/html; charset=Shift_JIS")).toBe("あ");
    const withMeta = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="shift_jis">'),
      0x82,
      0xa0,
    ]);
    expect(decodeHtml(withMeta, "text/html")).toBe('<meta charset="shift_jis">あ');
    expect(decodeHtml(new TextEncoder().encode("あ"), "text/html")).toBe("あ");
  });

  it("知らない文字コード名なら UTF-8 で読む", () => {
    expect(decodeHtml(new TextEncoder().encode("あ"), "text/html; charset=unknown-x")).toBe("あ");
  });
});

describe("hashSections", () => {
  it("同じ本文なら HTML の飾りが違っても同じ、本文が違えば異なる", () => {
    const a = hashSections(htmlToSections('<main><h2 class="x">見出し</h2><p>本文</p></main>'));
    const b = hashSections(htmlToSections("<main><h2>見出し</h2><div><p>本文</p></div></main>"));
    const c = hashSections(htmlToSections("<main><h2>見出し</h2><p>本文2</p></main>"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("見出しとページ番号も区別する", () => {
    expect(hashSections([{ text: "a", pdfPage: 1 }])).not.toBe(
      hashSections([{ text: "a", pdfPage: 2 }]),
    );
    expect(hashSections([{ text: "a", heading: "h" }])).not.toBe(hashSections([{ text: "a" }]));
  });
});

describe("pdfToSections", () => {
  it("ページごとに区切り、ページ番号を1から付ける。空のページは除く", async () => {
    const pdf = makePdf(["First page text", "", "Third page text"]);
    expect(await pdfToSections(pdf)).toEqual([
      { text: "First page text", pdfPage: 1 },
      { text: "Third page text", pdfPage: 3 },
    ]);
    // 渡したバッファは壊さない
    expect(pdf.byteLength).toBeGreaterThan(0);
  });

  it("壊れた PDF は例外", async () => {
    await expect(pdfToSections(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });

  it("extractSections は形式で振り分ける", async () => {
    expect(await extractSections("pdf", makePdf(["Hello"]), "application/pdf")).toEqual([
      { text: "Hello", pdfPage: 1 },
    ]);
    expect(
      await extractSections("html", new TextEncoder().encode("<p>本文</p>"), "text/html"),
    ).toEqual([{ text: "本文" }]);
  });
});
