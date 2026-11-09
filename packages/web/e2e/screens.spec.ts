// 画面の E2E とアクセシビリティ（タスク 26.1、Requirement 10.4, 11.1〜11.6, 12.5, 12.6）
// 360px と 430px の2つの幅で、横スクロール・タップ領域・コントラスト・タブバー・
// チャットの常設注意書き・オフラインの表示を確かめる。
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const TABS = ["ホーム", "さがす", "AI相談", "マイホーム"] as const;

/** 仮のログインで登録し、オンボーディングを終えてホームを開く（仮実装のデータはページ内にだけある） */
async function signUpAndOnboard(page: Page): Promise<void> {
  await page.goto("/");
  const registerTab = page.getByRole("button", { name: "新規登録", exact: true });
  if (await registerTab.isVisible().catch(() => false)) await registerTab.click();
  await page.getByLabel("メールアドレス").fill("e2e@example.com");
  await page.getByLabel("パスワード").fill("e2e-password-1234");
  await page.getByRole("checkbox").nth(0).check();
  await page.getByRole("checkbox").nth(1).check();
  await page.getByRole("button", { name: "登録する" }).click();

  await page.getByLabel(/郵便番号/).fill("1920083");
  await expect(page.getByText("八王子市").first()).toBeVisible();
  await page.getByRole("button", { name: "次へ" }).click();

  await page
    .getByLabel(/年齢（0〜18歳）/)
    .first()
    .fill("1");
  await page.getByRole("button", { name: "次へ" }).click();
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function openTab(page: Page, name: (typeof TABS)[number]): Promise<void> {
  await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
}

/** 横スクロールが出ていないこと（Requirement 11.6） */
async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** 画面の切り替えのフェード（opacity）が終わるまで待つ。途中で測るとコントラストを誤って低く測る */
async function waitForSettled(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    [...document.querySelectorAll<HTMLElement>("*")].every(
      (el) => el.style.opacity === "" || Number(el.style.opacity) >= 1 || el.offsetParent === null,
    ),
  );
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity),
  );
}

/** WCAG 2.1 AA の重大・深刻な違反がないこと（コントラストを含む。Requirement 11.4, 11.5） */
async function expectNoSeriousA11yViolations(page: Page): Promise<void> {
  await waitForSettled(page);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const serious = result.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(serious).toEqual([]);
}

/** 主要な操作のタップ領域が44px以上であること（Requirement 11.3） */
async function expectTapTargets(page: Page): Promise<void> {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("nav a, button.btn, .icon-btn, .chip")]
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && Math.min(r.width, r.height) < 44)
      .map(
        ({ el, r }) =>
          `${el.textContent?.trim() || el.getAttribute("aria-label")} ${r.width}x${r.height}`,
      ),
  );
  expect(small).toEqual([]);
}

test.describe("ログイン前", () => {
  test("登録画面は横スクロールせず、アクセシビリティの違反がない", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: /登録する|ログイン/ }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page);
  });

  test("未ログインではダッシュボードを表示しない（Requirement 1.1）", async ({ page }) => {
    await page.goto("/home");
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe("ログイン後", () => {
  test.beforeEach(async ({ page }) => {
    await signUpAndOnboard(page);
  });

  test("タブバーは4つを順に並べ、現在のタブを色以外でも示す（Requirement 11.1, 11.2）", async ({
    page,
  }) => {
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("link")).toHaveText([...TABS]);
    for (const name of TABS) {
      await openTab(page, name);
      await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  });

  for (const name of TABS) {
    test(`「${name}」は横スクロールせず、タップ領域とアクセシビリティを満たす`, async ({
      page,
    }) => {
      await openTab(page, name);
      await page.waitForLoadState("networkidle");
      await expectNoHorizontalScroll(page);
      await expectTapTargets(page);
      await expectNoSeriousA11yViolations(page);
    });
  }

  test("AI相談の注意書きは閉じられず、スクロールせずに見える（Requirement 10.4, 9.14）", async ({
    page,
  }) => {
    await openTab(page, "AI相談");
    const disclaimer = page
      .getByRole("note")
      .filter({ hasText: "診断や治療の判断は医師が行います" });
    const pii = page.getByRole("note").filter({ hasText: "氏名や病歴などの個人情報" });
    await expect(disclaimer).toBeInViewport();
    await expect(pii).toBeInViewport();
    // 質問を送って回答が伸びても、上部の注意書きは見えたまま
    await page.getByLabel("質問", { exact: true }).fill("子どもの医療費は助成される？");
    await page.getByRole("button", { name: "送信" }).click();
    await expect(page.getByText("出典", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(disclaimer).toBeInViewport();
    await expect(pii).toBeInViewport();
    await expectNoHorizontalScroll(page);
  });

  test("オフラインになると、その旨を表示する（Requirement 12.5, 12.6）", async ({
    page,
    context,
  }) => {
    await context.setOffline(true);
    await expect(page.getByText(/オフライン/).first()).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText(/オフライン/)).toHaveCount(0);
  });
});
