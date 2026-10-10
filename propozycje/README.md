# 🏎️ Propozycje Rozwoju Fizyki — F1 AI Simulator

Folder zawiera kompleksowe propozycje architektoniczne i inżynieryjne przygotowane przez zespół agentów AI w celu wyeliminowania uproszczeń symulacyjnych i podniesienia realizmu fizyki do poziomu zaawansowanych symulatorów (iRacing / rFactor / Assetto Corsa), z zachowaniem wydajności 60+ FPS w środowisku przeglądarkowym.

---

## 📑 Spis Dokumentów i Zakres Tematyczny

### 1. [PROPOZYCJA_OPONY_TERMIKA.md](./PROPOZYCJA_OPONY_TERMIKA.md)
* **Tematyka:** Model Opon Pacejka 'Magic Formula' (MF 5.2) oraz Dwuwarstwowa Termika Gumy.
* **Kluczowe elementy:**
  - Analityczne wyznaczanie kąta poślizgu $\alpha$ i poślizgu wzdłużnego $\kappa$.
  - Nieliniowy spadek przyczepności po przekroczeniu szczytu $\alpha_{peak} \approx 6^\circ\text{–}8^\circ$ (zamiast geometrycznego odcięcia Kamma).
  - Dwuwarstwowy model termiczny: bieżnik ($T_{surface}$) i osnowa ($T_{core}$) z oknem optymalnej pracy $90^\circ\text{C}\text{–}110^\circ\text{C}$.
  - Degradacja przyczepności przy niedogrzaniu oraz przegrzaniu (*graining/blistering*).
  - Kod TypeScript zoptymalizowany pod Web Worker (Zero-Allocation per tick).

### 2. [PROPOZYCJA_SKRZYNIA_NAPED.md](./PROPOZYCJA_SKRZYNIA_NAPED.md)
* **Tematyka:** 8-Stopniowa Sekwencyjna Skrzynia Biegów, Charakterystyka RPM Silnika i Hybryda ERS.
* **Kluczowe elementy:**
  - Zastąpienie modelu ciągłego ($P_{max} / v$) 8 dyskretnymi przełożeniami skrzyni F1 i sprzęgłem startowym.
  - Dynamika obrotowa silnika ICE w zakresie 4000–15000 RPM z odcięciem *rev-limiter*.
  - Zjawiska wyścigowe: *shift-cut* (45 ms odcięcia zapłonu przy wbijaniu biegu) oraz *engine braking* przy redukcjach.
  - Hybrydowy system ERS / MGU-K: doładowanie mocy (*Torque Fill* $+120\text{ kW}$) i rekuperacja kinetyczna.
  - Automatyczna logika zmiany biegów (`AutoShiftAssistant`) dla modeli AI.

### 3. [PROPOZYCJA_ZAWIESZENIE_AERO.md](./PROPOZYCJA_ZAWIESZENIE_AERO.md)
* **Tematyka:** 4-Narożnikowe Zawieszenie 3-DOF, Dynamiczny Prześwit i Zjawisko Morświnowania (*Porpoising*).
* **Kluczowe elementy:**
  - Model masy resorowanej o 3 stopniach swobody pionowej (Heave, Pitch, Roll) z 4 narożnikowymi sprężynami, asymetrycznymi amortyzatorami (*bump/rebound*) i stabilizatorami poprzecznymi (ARB).
  - Dynamiczny prześwit przedniego splittera (FRH) i tylnego dyfuzora (RRH / kąt *Rake*).
  - Zjawisko dobijania deski podłogowej (*Bottoming Out / Planking*) przy prędkościach $>300\text{ km/h}$ z oporem mechanicznym i iskrzeniem.
  - Zjawisko zadławienia przepływu (*Diffuser Stall / Choked Flow*) i morświnowania (*Porpoising*) w częstotliwości 5–7 Hz.
  - Wewnętrzny sub-stepping zawieszenia ($4 \times \Delta t_{sub} \approx 4.16\text{ ms}$) gwarantujący stabilność numeryczną.
