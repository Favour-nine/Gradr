// src/App.jsx
import { useState } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import Navbar from "./components/Navbar";
import Upload from "./components/Upload";
import SplashOverlay from "./components/SplashOverlay";
import Assessment from "./components/Assessment";
import Home from "./components/Home"; // <-- new

export default function App() {
  const [showSplash, setShowSplash] = useState(false);
  const navigate = useNavigate();

  const handleLogoClick = (to = "/") => {
    setShowSplash(true);
    setTimeout(() => {
      navigate(to);
      setTimeout(() => setShowSplash(false), 50);
    }, 100);
  };

  return (
    <>
      <SplashOverlay show={showSplash} />
      <Navbar onLogoClick={handleLogoClick} />
      <div className="min-h-screen bg-white text-gray-900">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/assessment" element={<Assessment />} />
        </Routes>
      </div>
    </>
  );
}
