import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildLlmContext, maskPii, PII_PLACEHOLDERS, SOURCE_AGE_BANDS } from "../src/index.js";

// Feature: childcare-medical-welfare-navi, Property 29: LLM に渡す世帯の属性
// Validates: Requirements 9.9
describe("buildLlmContext (Property 29)", () => {
  // 個人情報の値は、自治体コードや区分名と偶然一致しないよう印を付ける
  const secret = fc.string({ minLength: 1, maxLength: 20 }).map((s) => `秘${s}`);
  const household = fc.record({
    municipalityCode: fc.oneof(fc.stringMatching(/^\d{5}$/), secret),
    ageBands: fc.array(fc.oneof(fc.constantFrom(...SOURCE_AGE_BANDS), secret), { maxLength: 8 }),
    name: secret,
    address: secret,
    phone: secret,
    email: secret,
    dueDate: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
    sensitive: fc.record({ disability: secret, chronicIllness: secret }),
  });

  it("出力は自治体と年齢区分だけで、他の値はどれも現れない", () => {
    fc.assert(
      fc.property(household, (h) => {
        const ctx = buildLlmContext(h);
        expect(Object.keys(ctx).sort()).toEqual(["ageBands", "municipalityCode"]);
        const json = JSON.stringify(ctx);
        for (const value of [
          h.name,
          h.address,
          h.phone,
          h.email,
          h.dueDate,
          h.sensitive.disability,
          h.sensitive.chronicIllness,
        ]) {
          expect(json).not.toContain(JSON.stringify(value).slice(1, -1));
        }
        expect(ctx.municipalityCode).toBe(
          /^\d{5}$/.test(h.municipalityCode) ? h.municipalityCode : null,
        );
        for (const b of ctx.ageBands) expect(SOURCE_AGE_BANDS).toContain(b);
        expect(new Set(ctx.ageBands).size).toBe(ctx.ageBands.length);
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 30: 質問文の個人情報マスク
// Validates: Requirements 9.13
describe("maskPii (Property 30)", () => {
  // 個人情報を含まない文。数字は年齢・金額・日付など、電話番号や郵便番号にならない形だけ
  const safe = fc
    .array(
      fc.oneof(
        fc.stringMatching(/^[ぁ-んァ-ン一-龠、。？ a-zA-Z]{0,15}$/),
        fc.constantFrom("3歳", "月額15000円", "令和8年4月", "500-1000円", "1.5倍", "第2子"),
      ),
      { maxLength: 8 },
    )
    .map((parts) => parts.join(""));

  const d = (n: number) =>
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: n, maxLength: n }).map((a) => a.join(""));
  const phone = fc.oneof(
    fc.tuple(d(2), d(4), d(4)).map(([a, b, c]) => `0${a.slice(1)}-${b}-${c}`),
    fc.tuple(d(2), d(4), d(4)).map(([a, b, c]) => `0${a}-${b.slice(1)}-${c}`),
    fc.tuple(d(2), d(4), d(4)).map(([a, b, c]) => `0${a}${b}${c.slice(1)}`),
    fc.tuple(d(4), d(4)).map(([b, c]) => `090-${b}-${c}`),
    fc.tuple(d(4), d(4)).map(([b, c]) => `+81-90-${b}-${c}`),
    fc.constantFrom("042-000-0000", "03(1234)5678", "０９０－１２３４－５６７８"),
  );
  const postal = fc.oneof(
    fc.tuple(d(3), d(4)).map(([a, b]) => `${a}-${b}`),
    fc.tuple(d(3), d(4)).map(([a, b]) => `〒${a}${b}`),
    fc.constantFrom("〒192-8501", "１９２－８５０１"),
  );
  const email = fc.oneof(
    fc.emailAddress(),
    fc.constantFrom("taro.yamada+kids@example.jp", "hanako＠example.jp"),
  );
  const pii = fc.oneof(
    phone.map((value) => ({ value, placeholder: PII_PLACEHOLDERS.phone })),
    postal.map((value) => ({ value, placeholder: PII_PLACEHOLDERS.postalCode })),
    email.map((value) => ({ value, placeholder: PII_PLACEHOLDERS.email })),
  );

  it("電話番号・メールアドレス・郵便番号は残らず、固定の文字列に置き換わる", () => {
    fc.assert(
      fc.property(safe, pii, safe, (before, { value, placeholder }, after) => {
        const out = maskPii(`${before} ${value} ${after}`);
        expect(out).not.toContain(value);
        expect(out).toContain(placeholder);
      }),
    );
  });

  it("個人情報を含まない文は変わらない", () => {
    fc.assert(
      fc.property(safe, (text) => {
        expect(maskPii(text)).toBe(text);
      }),
    );
  });

  it("2回かけても1回と同じ（冪等）", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            safe,
            pii.map((p) => p.value),
          ),
          { maxLength: 6 },
        ),
        (parts) => {
          const once = maskPii(parts.join(" "));
          expect(maskPii(once)).toBe(once);
        },
      ),
    );
  });

  it("具体例", () => {
    expect(maskPii("連絡先は090-0000-0000、〒192-8501、taro@example.jp です")).toBe(
      "連絡先は[電話番号]、[郵便番号]、[メールアドレス] です",
    );
    expect(maskPii("2歳の子で月額15000円、500-1000円の負担")).toBe(
      "2歳の子で月額15000円、500-1000円の負担",
    );
    // 郵便番号と隣の金額を続けて電話番号にしない
    expect(maskPii("060-0001 500-1000円")).toBe("[郵便番号] 500-1000円");
    expect(maskPii("市役所 042-000-0000 まで")).toBe("市役所 [電話番号] まで");
  });
});
