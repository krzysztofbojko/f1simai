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

### Poszukiwanie linii przejazdu

Kierowcy rozpoczynają trening z różnymi profilami trajektorii. Profil określa przesunięcie na prostej, wyprzedzenie wejścia w zakręt, głębokość dojścia do wierzchołka i wyjście. Docelowe przesunięcie zależy od lokalnej i przewidywanej krzywizny; nie jest stałą jazdą środkiem ani jednym pasem wokół całego toru. Kontroler płynnie realizuje trajektorię, zachowując ograniczenia asfaltu, przyczepności i ruchu innych aut.

Po czystym okrążeniu kierowca porównuje mediany ostatnich maksymalnie pięciu czasów dla profilu. Najpierw sprawdza profile początkowe, następnie regularnie generuje nowe próby wokół najlepszego. Okrążenie przejściowe po zmianie profilu i okrążenia zakłócone incydentami lub wyprzedzaniem nie oceniają profilu. Najlepszy profil pozostaje chroniony podczas mutacji. W wyścigu kierowca korzysta z najlepszego sprawdzonego wariantu. Wyniki poszukiwania pozostają przy bolidzie podczas indywidualnego respawnu i automatycznych zmian generacji.

Jest to ograniczone poszukiwanie ewolucyjne parametrów trajektorii, współpracujące z istniejącym uczeniem sterowania; nie gwarantuje globalnego optimum. Zmiany paliwa i warunków ruchu mogą nadal wpływać na porównanie czasów. `node scripts/test-lines.mjs` sprawdza dobór profilu, ochronę najlepszego wariantu, nowe mutacje oraz przebieg zewnętrzna–wierzchołek–zewnętrzna.

### Presja kierowców

Suwak „Presja kierowców” działa w treningu i wyścigu, od −10 (większy zapas) przez 0 (dotychczasowe tempo) do +10 (jazda blisko granicy). Ustawienie zapamiętuje się lokalnie. Podczas jazdy decyzje zmieniają się płynnie przez dwie sekundy czasu symulacji; bolidy i modele nie są restartowane. Telemetria pokazuje aktualną presję i kierunek zmiany. Żółte flagi, omijanie ruchu i odzyskiwanie kontroli mają pierwszeństwo. Ręczne sterowanie nie zależy od suwaka.

Presja zmienia planowaną przyczepność zakrętów (32% / 45% / 75%), przewidywane hamowanie (0,85 / 1 / 1,45), częstość ataków (0,5 / 1 / 2) i częstość pomyłek (0,25 / 1 / 4) odpowiednio przy −10 / 0 / +10. Po kalibracji zmniejszono skrajne wartości planowania względem pierwotnej propozycji, aby większość stawki kończyła wyścig. Wartości pośrednie są interpolowane. Rzeczywiste siły hamulców i przyczepność opon pozostają niezmienione. Ryzyko pomyłki zależy od wykorzystania przyczepności i czasu symulacji; nie jest zwiększane pod żółtą flagą, przy postoju, zjeździe do boksu ani podczas odzyskiwania kontroli.

Poszukiwanie linii przejazdu przechowuje niezależne wyniki dla każdego z 21 ustawień w bieżącej sesji. Powrót do presji przywraca jej profile. Okrążenie obejmujące zmianę presji liczy się czasowo, ale nie ocenia profilu, nie nadpisuje modelu i nie zapisuje próbek uczenia; uczenie wraca od początku kolejnego pełnego okrążenia po zakończeniu przejścia. Rekordy i eksportowane modele zawierają presję pomiaru (stare pliki przyjmują 0). W tabeli `P +5` oznacza presję podczas rekordu. Wolniejszy wynik przy innym ustawieniu nie uruchamia cofania sieci do rekordowego modelu.

`npm run test:pressure` porównuje −10, 0 i +10 na tych samych modelach, torze oraz trzech zestawach losowania. `node scripts/test-pressure.mjs --full --high-only` sprawdza +10 w pełnej stawce dziesięciu bolidów przez dziesięć okrążeń. Testy mierzą ukończenia, DNF, czasy, wykorzystanie przyczepności, poślizgi, pobocza i pomyłki. Są to wyniki powtarzalnych scenariuszy testowych, a nie gwarancja ukończenia każdej losowej sesji.
