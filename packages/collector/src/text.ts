// HTML と PDF から本文を取り出す（Requirement 3.4, 3.9）
// 本文は要約せず原文のまま渡す。HTML は見出しごと、PDF はページごとに区切る。

import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { extractText, getDocumentProxy } from "unpdf";
import type { SourceSection } from "@hachioji-gov/shared";

// cheerio（domhandler）のノードのうち、ここで使う部分
type DomNode = { type: string; name?: string; data?: string; children?: DomNode[] };

// 本文ではない要素（サイト共通のメニューなど）
const SKIP = new Set([
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "iframe",
  "template",
  "svg",
  "button",
  "select",
  "noscript",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const BLOCKS = new Set([
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "dl",
  "dt",
  "dd",
  "table",
  "tr",
  "td",
  "th",
  "section",
  "article",
  "main",
  "br",
  "pre",
  "blockquote",
  "caption",
  "figure",
  "figcaption",
  "address",
]);
// 本文の範囲。最初に見つかったものを使う
const ROOTS = ["main", "[role=main]", "article", "#contents", "body"];

/** 行ごとに連続する空白を1つにし、空行を除く */
export function normalizeText(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

function textOf(node: DomNode): string {
  if (node.type === "text") return node.data ?? "";
  if (node.type !== "tag") return "";
  return (node.children ?? []).map(textOf).join("");
}

/** HTML を見出しごとの区切りにする。見出しの文字列は heading に入れ、本文には含めない */
export function htmlToSections(html: string): SourceSection[] {
  const $ = cheerio.load(html);
  const root = ROOTS.map((s) => $(s).first()).find((r) => r.length > 0);
  const top = root?.get(0) as unknown as DomNode | undefined;
  if (top === undefined) return [];

  const sections: SourceSection[] = [];
  let heading: string | undefined;
  let buffer = "";
  const flush = (): void => {
    const text = normalizeText(buffer);
    if (text !== "") sections.push(heading === undefined ? { text } : { text, heading });
    buffer = "";
  };
  const walk = (node: DomNode): void => {
    if (node.type === "text") {
      buffer += node.data ?? "";
      return;
    }
    // script・style・コメントは type が "tag" ではない
    if (node.type !== "tag") return;
    const name = (node.name ?? "").toLowerCase();
    if (SKIP.has(name)) return;
    if (HEADINGS.has(name)) {
      flush();
      const h = normalizeText(textOf(node)).replace(/\n/g, " ");
      heading = h === "" ? undefined : h;
      return;
    }
    const block = BLOCKS.has(name);
    if (block) buffer += "\n";
    for (const child of node.children ?? []) walk(child);
    if (block) buffer += "\n";
  };
  walk(top);
  flush();
  return sections;
}

/** PDF をページごとの区切りにする。ページ番号は1から */
export async function pdfToSections(bytes: Uint8Array): Promise<SourceSection[]> {
  // pdf.js は渡したバッファを手放すことがあるため、写しを渡す
  const doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  try {
    const { text } = await extractText(doc, { mergePages: false });
    return text.flatMap((page, i) => {
      const normalized = normalizeText(page);
      return normalized === "" ? [] : [{ text: normalized, pdfPage: i + 1 }];
    });
  } finally {
    await doc.loadingTask.destroy();
  }
}

const CHARSET = /charset\s*=\s*["']?([A-Za-z0-9_-]+)/i;

/** Content-Type または meta の charset で HTML を文字列にする。分からなければ UTF-8 */
export function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  const label = CHARSET.exec(contentType)?.[1] ?? CHARSET.exec(head)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** 取り出した本文のハッシュ。HTML の飾りの変化では変わらず、本文が変わると変わる */
export function hashSections(sections: readonly SourceSection[]): string {
  const canonical = JSON.stringify(
    sections.map((s) => [s.heading ?? null, s.pdfPage ?? null, s.text]),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 情報源の形式に合わせて本文を取り出す */
export async function extractSections(
  format: "html" | "pdf",
  body: Uint8Array,
  contentType: string,
): Promise<SourceSection[]> {
  return format === "pdf" ? pdfToSections(body) : htmlToSections(decodeHtml(body, contentType));
}
