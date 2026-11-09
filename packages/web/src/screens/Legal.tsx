// 利用規約・プライバシーポリシーの画面（Requirement 9.11, 9.12, 9.15）

import { Header } from "../components/ui";
import type { LegalDocument } from "../legal/content";

export function LegalPage({ doc }: { doc: LegalDocument }) {
  return (
    <div className="screen white">
      <Header back title={doc.title} />
      <main className="main legal">
        <p className="small sub">
          版 {doc.version} ・ 施行日 {doc.effectiveDate}
        </p>
        {doc.sections.map((s) => (
          <section key={s.heading} className="section">
            <h2>{s.heading}</h2>
            {s.paragraphs.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {s.items && (
              <ul>
                {s.items.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </main>
    </div>
  );
}
