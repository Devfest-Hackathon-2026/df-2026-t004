import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SAMPLE_POSTAL_TABLE,
  buildPostalTable,
  classifyPostalCode,
  dueDateMax,
  validateChildren,
  validateDueDate,
  validateEmail,
  validateFreeText,
  validateHouseholdInput,
  validatePassword,
  validateSignUp,
  type ChildInput,
  type PostalEntry,
} from "../src/index.js";

// YYYY-MM-DD を作る（UTC の暦日）
const isoDate = fc
  .date({
    min: new Date("2000-01-01T00:00:00Z"),
    max: new Date("2099-12-31T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString().slice(0, 10));

const shiftDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// Feature: childcare-medical-welfare-navi, Property 1: メールアドレスとパスワードの検証
// Validates: Requirements 1.3, 1.4
describe("validateEmail / validatePassword (Property 1)", () => {
  it("有効な形式のメールは、254文字以内のときに限り真", () => {
    fc.assert(
      fc.property(fc.emailAddress(), (email) => {
        expect(validateEmail(email)).toBe(email.length <= 254);
      }),
    );
  });

  it("@ が無い・空白を含む・ドメインにドットが無いものは偽", () => {
    fc.assert(
      fc.property(fc.emailAddress(), fc.constantFrom(" ", "\t", "\n"), (email, ws) => {
        expect(validateEmail(email.replaceAll("@", ""))).toBe(false);
        expect(validateEmail(email + ws)).toBe(false);
        expect(validateEmail(ws + email)).toBe(false);
      }),
    );
    fc.assert(
      fc.property(fc.string(), (s) => {
        if (!s.includes("@")) expect(validateEmail(s)).toBe(false);
      }),
    );
    for (const bad of [
      "a@b",
      "@example.com",
      "a@",
      "a@@example.com",
      "a..b@example.com",
      ".a@example.com",
      "a@-x.com",
      "a@example.1",
    ]) {
      expect(validateEmail(bad)).toBe(false);
    }
    expect(validateEmail("name@example.com")).toBe(true);
  });

  it("255文字以上は形式が正しくても偽", () => {
    const local = "a".repeat(64);
    const domain = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(60)}.jp`;
    const email = `${local}@${domain}`;
    expect(email.length).toBeGreaterThan(254);
    expect(validateEmail(email)).toBe(false);
  });

  it("パスワードは8〜128文字（コードポイント数）のときに限り真", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 200 })
          .chain((n) =>
            fc.tuple(fc.constant(n), fc.string({ unit: "binary", minLength: n, maxLength: n })),
          ),
        ([n, pw]) => {
          expect(validatePassword(pw)).toBe(n >= 8 && n <= 128);
        },
      ),
    );
  });

  it("validateSignUp は無効な欄ごとにエラーを返す", () => {
    expect(validateSignUp({ email: "x", password: "short" }).errors.map((e) => e.field)).toEqual([
      "email",
      "password",
    ]);
    expect(validateSignUp({ email: "name@example.com", password: "12345678" }).ok).toBe(true);
  });
});

// Feature: childcare-medical-welfare-navi, Property 3: 郵便番号の分類
// Validates: Requirements 2.1, 2.2, 2.3
describe("classifyPostalCode (Property 3)", () => {
  const digits7 = fc.stringMatching(/^\d{7}$/);
  const entry: fc.Arbitrary<PostalEntry> = fc.record({
    municipalityCode: fc.constantFrom("13201", "13101", "13202", "01100"),
    prefecture: fc.constant("東京都"),
    city: fc.string({ minLength: 1, maxLength: 5 }),
    town: fc.string({ maxLength: 5 }),
  });
  const table = fc
    .array(fc.tuple(digits7, entry), { maxLength: 20 })
    .map((rows) => buildPostalTable(rows.map(([postalCode, e]) => ({ postalCode, ...e }))));

  it("7桁の数字はちょうど1つの分類に入り、表の内容と一致する", () => {
    fc.assert(
      fc.property(table, digits7, (t, code) => {
        const r = classifyPostalCode(code, t);
        const e = t.get(code);
        if (!e) expect(r.kind).toBe("notFound");
        else expect(r.kind).toBe(e.municipalityCode === "13201" ? "hachioji" : "outside");
      }),
    );
  });

  it("表にある番号は、ハイフン付き・全角でも同じ分類になる", () => {
    fc.assert(
      fc.property(table, (t) => {
        for (const code of t.keys()) {
          const hyphen = `${code.slice(0, 3)}-${code.slice(3)}`;
          const wide = code.replace(/\d/g, (d) => String.fromCharCode(d.charCodeAt(0) + 0xfee0));
          expect(classifyPostalCode(hyphen, t).kind).toBe(classifyPostalCode(code, t).kind);
          expect(classifyPostalCode(wide, t).kind).toBe(classifyPostalCode(code, t).kind);
        }
      }),
    );
  });

  it("数字7桁にならない入力は invalidFormat", () => {
    fc.assert(
      fc.property(table, fc.string(), (t, s) => {
        fc.pre(!/^\s*[\d０-９]{3}[-－ー]?[\d０-９]{4}\s*$/.test(s));
        expect(classifyPostalCode(s, t).kind).toBe("invalidFormat");
      }),
    );
    for (const bad of ["", "192008", "19200833", "192-00833", "abc-defg", "192 0083"]) {
      expect(classifyPostalCode(bad, SAMPLE_POSTAL_TABLE).kind).toBe("invalidFormat");
    }
  });

  it("サンプルの表: 八王子市・市外・未登録", () => {
    expect(classifyPostalCode("192-0083", SAMPLE_POSTAL_TABLE).kind).toBe("hachioji");
    expect(classifyPostalCode("1000001", SAMPLE_POSTAL_TABLE).kind).toBe("outside");
    expect(classifyPostalCode("0000000", SAMPLE_POSTAL_TABLE).kind).toBe("notFound");
  });
});

// Feature: childcare-medical-welfare-navi, Property 4: 子ども・自由記述の入力検証
// Validates: Requirements 2.4, 2.8, 2.9
describe("validateChildren / validateFreeText (Property 4)", () => {
  const num = fc.oneof(
    fc.integer({ min: -3, max: 22 }),
    fc.double({ min: -1, max: 20, noNaN: true }),
  );
  const child: fc.Arbitrary<ChildInput> = fc.record(
    {
      ageYears: num,
      ageMonths: fc.oneof(
        fc.integer({ min: -2, max: 14 }),
        fc.double({ min: 0, max: 11, noNaN: true }),
      ),
    },
    { requiredKeys: ["ageYears"] },
  );
  const isInt = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;
  const childOk = (c: ChildInput) =>
    isInt(c.ageYears, 0, 18) &&
    (c.ageMonths === undefined || (c.ageYears === 0 && isInt(c.ageMonths, 0, 11)));

  it("成功するのは、人数0〜20・年齢0〜18の整数・月齢は0歳のみ0〜11のときに限る", () => {
    fc.assert(
      fc.property(fc.array(child, { maxLength: 24 }), (children) => {
        const expected = children.length <= 20 && children.every(childOk);
        expect(validateChildren(children).ok).toBe(expected);
      }),
    );
  });

  it("エラーは問題のある子どもの欄を指す", () => {
    const r = validateChildren([{ ageYears: 4 }, { ageYears: 0, ageMonths: 14 }, { ageYears: 19 }]);
    expect(r.errors.map((e) => e.field)).toEqual(["children.1.ageMonths", "children.2.ageYears"]);
  });

  it("自由記述は200文字以内のときに限り成功する", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 0, max: 260 })
          .chain((n) =>
            fc.tuple(fc.constant(n), fc.string({ unit: "binary", minLength: n, maxLength: n })),
          ),
        ([n, s]) => {
          expect(validateFreeText(s).ok).toBe(n <= 200);
        },
      ),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 7: 出産予定日の範囲
// Validates: Requirements 2.12, 2.13
describe("validateDueDate (Property 7)", () => {
  // 10か月後の同日（存在しない日は月末）を、Date の繰り上がりを使わずに求める
  const tenMonthsLater = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
    const idx = y * 12 + (m - 1) + 10;
    const ny = Math.floor(idx / 12);
    const nm = (idx % 12) + 1;
    const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  };

  it("真となるのは、入力日の当日〜10か月後の同日の範囲にあるときに限る", () => {
    fc.assert(
      fc.property(isoDate, fc.integer({ min: -40, max: 340 }), (today, k) => {
        const date = shiftDays(today, k);
        const expected = date >= today && date <= tenMonthsLater(today);
        expect(validateDueDate(date, today)).toBe(expected);
      }),
    );
  });

  it("境界: 当日と上限日は真、その外側は偽", () => {
    fc.assert(
      fc.property(isoDate, (today) => {
        const max = dueDateMax(today)!;
        expect(validateDueDate(today, today)).toBe(true);
        expect(validateDueDate(max, today)).toBe(true);
        expect(validateDueDate(shiftDays(today, -1), today)).toBe(false);
        expect(validateDueDate(shiftDays(max, 1), today)).toBe(false);
      }),
    );
  });

  it("存在しない日は月末に丸める", () => {
    expect(dueDateMax("2026-01-31")).toBe("2026-11-30");
    expect(dueDateMax("2025-04-30")).toBe("2026-02-28");
    expect(dueDateMax("2027-04-29")).toBe("2028-02-29");
    expect(validateDueDate("2026-02-30", "2026-01-01")).toBe(false);
    expect(validateDueDate("2026/03/01", "2026-01-01")).toBe(false);
  });
});

// Feature: childcare-medical-welfare-navi, Property 5: 世帯入力の必須項目
// Validates: Requirements 2.5, 2.10, 2.11, 11.7, 11.8
describe("validateHouseholdInput (Property 5)", () => {
  const validPostal = fc.constantFrom("1920083", "192-0083", "1000001");
  const validChild: fc.Arbitrary<ChildInput> = fc.oneof(
    fc.integer({ min: 1, max: 18 }).map((ageYears) => ({ ageYears })),
    fc.integer({ min: 0, max: 11 }).map((ageMonths) => ({ ageYears: 0, ageMonths })),
  );

  it("人数1以上で必須項目が有効なら、出産予定日が未入力でも成功する", () => {
    fc.assert(
      fc.property(
        validPostal,
        fc.array(validChild, { minLength: 1, maxLength: 20 }),
        isoDate,
        (postalCode, children, today) => {
          expect(
            validateHouseholdInput({ postalCode, children }, today, SAMPLE_POSTAL_TABLE).ok,
          ).toBe(true);
        },
      ),
    );
  });

  it("人数0のときは、有効な出産予定日があるときに限り成功する", () => {
    fc.assert(
      fc.property(
        validPostal,
        isoDate,
        fc.option(fc.integer({ min: -30, max: 330 }), { nil: undefined }),
        (postalCode, today, k) => {
          const dueDate = k === undefined ? undefined : shiftDays(today, k);
          const r = validateHouseholdInput(
            { postalCode, children: [], dueDate },
            today,
            SAMPLE_POSTAL_TABLE,
          );
          expect(r.ok).toBe(dueDate !== undefined && validateDueDate(dueDate, today));
          if (!r.ok) expect(r.errors.some((e) => e.field === "dueDate")).toBe(true);
        },
      ),
    );
  });

  it("郵便番号が形式違い・未登録なら失敗する（市外は成功）", () => {
    const children = [{ ageYears: 3 }];
    const today = "2026-11-09";
    expect(
      validateHouseholdInput({ postalCode: "abc", children }, today, SAMPLE_POSTAL_TABLE).errors[0]
        ?.field,
    ).toBe("postalCode");
    expect(
      validateHouseholdInput({ postalCode: "0000000", children }, today, SAMPLE_POSTAL_TABLE).ok,
    ).toBe(false);
    expect(
      validateHouseholdInput({ postalCode: "100-0001", children }, today, SAMPLE_POSTAL_TABLE).ok,
    ).toBe(true);
  });

  it("任意項目（自由記述）は、入れたときだけ検証する", () => {
    const base = { postalCode: "1920083", children: [{ ageYears: 2 }] };
    expect(
      validateHouseholdInput(
        { ...base, freeText: "あ".repeat(200) },
        "2026-11-09",
        SAMPLE_POSTAL_TABLE,
      ).ok,
    ).toBe(true);
    expect(
      validateHouseholdInput(
        { ...base, freeText: "あ".repeat(201) },
        "2026-11-09",
        SAMPLE_POSTAL_TABLE,
      ).ok,
    ).toBe(false);
  });
});
