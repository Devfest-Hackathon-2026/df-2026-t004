import { LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { OfflineBanner, UpdatePrompt } from "./components/pwa";
import { TabBar } from "./components/ui";
import { showsTabBar } from "./lib/tabs";
import { PRIVACY, TERMS } from "./legal/content";
import { LegalPage } from "./screens/Legal";
import { Placeholder } from "./screens/Placeholder";
import { ProgramDetail } from "./screens/ProgramDetail";

export default function App() {
  const loc = useLocation();
  const withTabs = showsTabBar(loc.pathname);
  return (
    <LazyMotion features={domMax} strict>
      {/* OS の「視差効果を減らす」設定では動きを止める */}
      <MotionConfig reducedMotion="user">
        <div className="app">
          <OfflineBanner />
          <m.div
            key={loc.pathname}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.16 }}
          >
            <Routes location={loc}>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route
                path="/home"
                element={<Placeholder title="ホーム" task="T23（#24）" withInstallHint />}
              />
              <Route path="/search" element={<Placeholder title="さがす" task="T23（#24）" />} />
              <Route path="/chat" element={<Placeholder title="AI相談" task="T24（#25）" />} />
              <Route path="/my" element={<Placeholder title="マイホーム" task="T25（#26）" />} />
              <Route path="/programs/:id" element={<ProgramDetail />} />
              <Route path="/terms" element={<LegalPage doc={TERMS} />} />
              <Route path="/privacy" element={<LegalPage doc={PRIVACY} />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </m.div>
          {withTabs && <TabBar />}
          <UpdatePrompt />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
