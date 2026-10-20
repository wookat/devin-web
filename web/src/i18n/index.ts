import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import zh from "./locales/zh.json";

// Standard react-i18next wiring: language detected from localStorage →
// navigator, persisted under 'wb2-lang'. Resources are flat semantic keys —
// add a locale by dropping locales/<code>.json next to these two.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { en: { translation: en }, zh: { translation: zh } },
    fallbackLng: "en",
    supportedLngs: ["en", "zh"],
    detection: { order: ["localStorage", "navigator"], caches: ["localStorage"], lookupLocalStorage: "wb2-lang" },
    interpolation: { escapeValue: false },
    returnNull: false,
  });

const TITLES: Record<string, string> = { zh: "Devin 工作台 · 本地", en: "Devin Workbench · Local" };
const applyTitle = (lng: string) => { document.title = TITLES[lng.startsWith("zh") ? "zh" : "en"] ?? TITLES.en; };
applyTitle(i18n.language || "en");
i18n.on("languageChanged", applyTitle);

export default i18n;
