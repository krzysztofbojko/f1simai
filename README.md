# F1 AI Simulator

Przeglądarkowy symulator wyścigów 2D w TypeScript i Vite. Dziesięć bolidów korzysta z hybrydowego sterowania: geometrii toru, sensorów, sieci neuronowych i treningu online. Fizyka działa w Web Workerze, a interfejs renderuje tor i telemetrię przez Canvas 2D.

## Funkcje

- Ciągły trening AI bez restartowania sprawdzonych bolidów przy automatycznej zmianie generacji; ochrona modeli najlepszych okrążeń, import i eksport.
- Wyścig Grand Prix z procedurą startową, klasyfikacją, paliwem i uproszczonym postojem serwisowym. AI wybiera boczną linię wyprzedzania i omija wraki; lokalne żółte flagi ograniczają tempo i zabraniają wyprzedzania. Wraki znikają po 1–2 okrążeniach lidera.
- Tory Grand Prix i owal, rysowanie własnej trasy oraz zapis i odczyt JSON. Automatyczne pobocza z trawy i żwiru, szersze po zewnętrznej stronie zakrętów, oraz bandy.
- Telemetria prędkości, przyspieszeń, paliwa, obciążeń osi, czasów, nawierzchni i przyczyny DNF.
- Rzadkie błędy hamowania lub skrętu AI w treningu i wyścigu; ochrona rekordowych sieci przed oceną takich okrążeń.
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
npm test               # regresje fizyki, wyścigu, treningu, poboczy i pomyłek
npm run test:learning  # ochrona wiedzy AI i zmiany generacji
npm run test:runoff    # pobocza, bandy, powrót na asfalt i pomyłki AI
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

Widok toru: przyciski +/− lub kółko myszy zmieniają zoom (25–800%). Przeciągnięcie przesuwa widok i wyłącza śledzenie. „Cały tor” dopasowuje trasę do okna. Wybierz zawodnika w tabeli lub kliknij auto, następnie włącz „Śledź zawodnika”; kamera podąża za wybranym autem także po zmianie generacji. Bez wcześniejszego wyboru przycisk wybiera aktualnego lidera.

Wyjazd poza asfalt nie eliminuje bolidu: trawa zmniejsza przyczepność, a żwir dodatkowo wyhamowuje ruch. Lekki kontakt z bandą wygasza ruch w jej kierunku i zmniejsza prędkość wzdłuż bandy. Uderzenie z prędkością prostopadłą co najmniej 12 m/s powoduje DNF w wyścigu lub respawn w treningu. Samochód zatrzymany głęboko w żwirze może ugrzęznąć i zakończyć jazdę z powodu braku postępu.
