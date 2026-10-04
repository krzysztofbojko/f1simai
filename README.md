# F1 AI Simulator

Przeglądarkowy symulator wyścigów 2D w TypeScript i Vite. Dziesięć bolidów korzysta z hybrydowego sterowania: geometrii toru, sensorów, sieci neuronowych i treningu online. Fizyka działa w Web Workerze, a interfejs renderuje tor i telemetrię przez Canvas 2D.

## Funkcje

- Trening AI, ewolucja populacji, import i eksport modeli.
- Wyścig Grand Prix z procedurą startową, klasyfikacją, paliwem i uproszczonym postojem serwisowym.
- Tory Grand Prix i owal, rysowanie własnej trasy oraz zapis i odczyt JSON.
- Telemetria prędkości, przyspieszeń, paliwa, obciążeń osi i czasów okrążeń.
- Sterowanie gracza: WASD lub strzałki; P zgłasza postój.
- Profile obliczeniowe, pauza i przyspieszenie symulacji.

## Fizyka

Model uwzględnia masę paliwa, moc i trakcję napędu, docisk, wektor oporu powietrza oraz wspólne koło tarcia dla sił opon. Szerokość toru jest wyrażona w metrach. Telemetria pokazuje przyspieszenie wynikające ze zmiany prędkości.

To model hybrydowy do gry. Nie zawiera pełnej dynamiki yaw, kontaktów między bolidami ani fizycznego przejazdu aleją serwisową. Osiągi nie są kalibrowane względem konkretnego bolidu F1. Szczegóły, stałe i ograniczenia opisuje [PHYSICS.md](PHYSICS.md).

Po zmianie fizyki z 04.10.2026 dawne rekordy i modele AI wymagają ponownego treningu. Droga hamowania i czasy okrążeń zmieniły się wraz z poprawą limitów tarcia i skali drogi.

## Uruchomienie

Wymagany Node.js 20.19+ albo 22.12+ (zgodnie z wymaganiami Vite) i npm.

```bash
npm ci
npm run dev
```

Vite wyświetli lokalny adres aplikacji, domyślnie `http://localhost:5173`.

```bash
npm test               # regresje fizyki i integracja treningu
npm run audit:physics  # wyniki prób numerycznych
npm run build          # TypeScript i produkcyjne dist/
npm run preview        # podgląd zbudowanej wersji
```

## Struktura

- `src/main.ts` — interfejs, obsługa wejścia i pętla renderowania.
- `src/workers/` — symulacja, protokół komunikacji i akumulator czasu.
- `src/physics/Car.ts` — dynamika, sterowanie AI, paliwo, obrys i pomiar okrążeń.
- `src/ai/` — sieci neuronowe i populacja kierowców.
- `src/track/`, `src/math/` — geometria, presety, spline i wektory.
- `src/rendering/Renderer.ts` — Canvas, tor, bolidy i telemetria.
- `scripts/audit-physics.mjs` — odtwarzalne próby i testy regresyjne.

## Dokumentacja

- [Aktualny model fizyki](PHYSICS.md).
- [Audyt fizyki przed naprawami](AUDIT_PHYSICS.md).
- [Historyczny audyt aplikacji](AUDIT.md).
- `opis.md` i `opis.txt` — archiwalne opisy wcześniejszej implementacji.

Projekt pierwotnie rozwijano przy użyciu Gemini Antigravity.
