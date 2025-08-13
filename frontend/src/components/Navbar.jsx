// src/components/Navbar.jsx
import { useState } from "react";
import { Menu, X } from "lucide-react";
import logo from "../assets/logo.png";
import { Link } from "react-router-dom";

export default function Navbar({ onLogoClick }) {
  const [isOpen, setIsOpen] = useState(false);
  const toggleMenu = () => setIsOpen((s) => !s);

  return (
    <nav className="sticky top-0 z-50 shadow" style={{ backgroundColor: "#1800ad" }}>
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo + brand (reduced spacing) */}
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            onLogoClick?.("/"); // triggers splash + navigate
            setIsOpen(false);
          }}
          className="flex items-center"
        >
          <img src={logo} alt="Gradr Logo" className="h-8 w-auto" />
          <span className="text-white font-bold text-lg ml-1">Gradr</span>
        </a>

        {/* Desktop Menu */}
        <div className="hidden md:flex space-x-6">
          <Link to="/" className="text-white hover:text-indigo-200 transition">Home</Link>
          <Link to="/upload" className="text-white hover:text-indigo-200 transition">Upload</Link>
          <Link to="/assessment" className="text-white hover:text-indigo-200 transition">Assessment</Link>
        </div>

        {/* Mobile Hamburger */}
        <div className="md:hidden">
          <button
            onClick={toggleMenu}
            className="text-white focus:outline-none p-2 rounded hover:bg-white/10"
          >
            {isOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>
      </div>

      {/* Mobile Menu Panel */}
      {isOpen && (
        <div className="md:hidden px-4 pb-3 space-y-2" style={{ backgroundColor: "#1800ad" }}>
          <Link to="/" onClick={() => setIsOpen(false)} className="block text-white hover:text-indigo-200">
            Home
          </Link>
          <Link to="/upload" onClick={() => setIsOpen(false)} className="block text-white hover:text-indigo-200">
            Upload
          </Link>
          <Link to="/assessment" onClick={() => setIsOpen(false)} className="block text-white hover:text-indigo-200">
            Assessment
          </Link>
        </div>
      )}
    </nav>
  );
}
