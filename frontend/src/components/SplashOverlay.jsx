import logo from "../assets/logo.png";
import { useEffect, useState } from "react";

export default function SplashOverlay({ show }) {
  const [fade, setFade] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (show) {
      setMounted(true); // mount overlay
      setFade(false); // start fully visible
      setTimeout(() => setFade(true), 20); // fade out after short delay
      // unmount after fade duration
      setTimeout(() => setMounted(false), 1500);
    }
  }, [show]);

  if (!mounted) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center transition-opacity duration-1500 ${
        fade ? "opacity-0" : "opacity-100"
      }`}
      style={{
        backgroundColor: "#1800ad",
        zIndex: 60,
        pointerEvents: fade ? "none" : "auto", // allow clicks after fade
      }}
    >
      <img src={logo} alt="Gradr" className="h-48 w-auto" />
    </div>
  );
}
