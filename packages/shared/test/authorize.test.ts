import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { authorizeAccess } from "../src/index.js";

// Feature: childcare-medical-welfare-navi, Property 48: 所有者以外のアクセス拒否
// Validates: Requirements 9.6, 9.7, 15.2
describe("authorizeAccess (Property 48)", () => {
  const uid = fc.string({ minLength: 0, maxLength: 40 });
  const tokenUid = fc.option(uid, { nil: undefined });

  it("許可されるのは、認証済みで uid が等しく空でないときに限る", () => {
    fc.assert(
      fc.property(tokenUid, uid, fc.boolean(), (t, p, authed) => {
        const result = authorizeAccess(t, p, authed);
        const expectedAllowed = authed && t !== undefined && t.length > 0 && t === p;
        expect(result.allowed).toBe(expectedAllowed);
      }),
    );
  });

  it("未認証は uid の組に関係なく 401", () => {
    fc.assert(
      fc.property(tokenUid, uid, (t, p) => {
        expect(authorizeAccess(t, p, false)).toEqual({ allowed: false, status: 401 });
      }),
    );
  });

  it("認証済みで uid が異なるときは 403", () => {
    fc.assert(
      fc.property(
        uid.filter((s) => s.length > 0),
        uid,
        (t, p) => {
          fc.pre(t !== p);
          expect(authorizeAccess(t, p, true)).toEqual({ allowed: false, status: 403 });
        },
      ),
    );
  });

  it("本人は許可される", () => {
    fc.assert(
      fc.property(
        uid.filter((s) => s.length > 0),
        (u) => {
          expect(authorizeAccess(u, u, true)).toEqual({ allowed: true });
        },
      ),
    );
  });

  it("認証済みでもトークンの uid が無い・空なら 401", () => {
    expect(authorizeAccess(undefined, "alice", true)).toEqual({ allowed: false, status: 401 });
    expect(authorizeAccess(null, "alice", true)).toEqual({ allowed: false, status: 401 });
    expect(authorizeAccess("", "", true)).toEqual({ allowed: false, status: 401 });
  });
});
