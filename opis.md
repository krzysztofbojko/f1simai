# 🏎️ Dokumentacja Techniczna Systemu F1 AI Simulator

Kompleksowy opis architektury, modelu fizyki, algorytmów sztucznej inteligencji oraz rozwiązań inżynieryjnych zaimplementowanych w projekcie symulatora bolidów Formuły 1.

---

## 📑 Spis Treści
1. [Wprowadzenie i Cel Projektu](#1-wprowadzenie-i-cel-projektu)
2. [Architektura Systemu i Wielowątkowość](#2-architektura-systemu-i-wielowątkowość)
3. [Model Fizyki Pojazdu (Vehicle Dynamics 2D)](#3-model-fizyki-pojazdu-vehicle-dynamics-2d)
4. [Sztuczna Inteligencja (AI) i Algorytmy Uczenia](#4-sztuczna-inteligencja-ai-i-algorytmy-uczenia)
5. [Kluczowe Rozwiązania Inżynieryjne i Diagnoza Problemów](#5-kluczowe-rozwiązania-inżynieryjne-i-diagnoza-problemów)
   - [Eliminacja blokady prędkości 280 km/h na prostych](#a-eliminacja-blokady-prędkości-280-kmh-na-prostych)
   - [Rozwiązanie problemu degradacji osiągów po setkach okrążeń (L800+)](#b-rozwiązanie-problemu-degradacji-osiągów-po-setkach-okrążeń-l800)
   - [Trwałość mózgów AI i ochrona przed niepożądanym resetem](#c-trwałość-mózgów-ai-i-ochrona-przed-niepożądanym-resetem)
6. [Tryby Symulacji](#6-tryby-symulacji)
   - [Tryb Treningu i Ciągłej Ewolucji](#a-tryb-treningu-i-ciągłej-ewolucji)
   - [Tryb Wyścigu Grand Prix (50–100 Okrążeń)](#b-tryb-wyścigu-grand-prix-50100-okrążeń)
   - [Strategia Pit-Stopów i Zużycie Paliwa](#c-strategia-pit-stopów-i-zużycie-paliwa)
7. [System Pomiaru Czasów i Telemetria F1](#7-system-pomiaru-czasów-i-telemetria-f1)
8. [Edytor Torów i Interpolacja Spline'ami](#8-edytor-torów-i-interpolacja-splineami)
9. [Struktura Kodu Źródłowego](#9-struktura-kodu-źródłowego)
10. [Instrukcja Uruchomienia i Budowania](#10-instrukcja-uruchomienia-i-budowania)

---

## 1. Wprowadzenie i Cel Projektu

Projekt **F1 AI Simulator** to symulator wyścigowy działający w przeglądarce w czasie rzeczywistym, w którym 10 zespołów Formuły 1 (oraz opcjonalnie kierowca-gracz) rywalizuje na torze za pomocą autonomicznych sieci neuronowych.

Główne cele techniczne projektu:
- **Autonomiczne sterowanie bolidem F1**: Każdy bolid jest kontrolowany przez własną sieć neuronową, która na podstawie odczytów wirtualnych sensorów (LiDAR/promienie) decyduje o skręcie, gazie i hamulcu.
- **Prawdziwe prędkości F1 (do 420+ km/h)**: Odwzorowanie aerodynamiki docisku ($F_{downforce} \sim v^2$), pozwalające na agresywne pokonywanie szybkich łuków i gwałtowne dohamowania z przeciążeniami rzędu 5G.
- **Realistyczna strategia wyścigowa**: Zmienna masa bolidu wynikająca ze zużycia paliwa, procedury startowe ze światłami, zjazdy do boksów na dotankowanie oraz zasada DNF (odpadnięcie po kolizji).
- **Stabilność numeryczna i płynność**: Całkowity rozdział obliczeń fizyczno-matematycznych od wątku interfejsu i renderowania.

---

## 2. Architektura Systemu i Wielowątkowość

Aplikacja wykorzystuje model **wielowątkowy z Web Workerem**, co zapobiega zacinaniu interfejsu użytkownika podczas intensywnych obliczeń:

```
┌─────────────────────────────────────────────────────────────┐
│                    Główny Wątek (UI & Canvas)               │
│  - Renderowanie grafiki Canvas 2D przy 60 FPS (Renderer.ts) │
│  - Panel boczny z telemetrią na żywo (BEST, LAST, TERAZ)    │
│  - Obsługa wejścia gracza (WASD, [P])                       │
│  - Narzędzia edycji toru myszką (Spline Editor)             │
└──────────────────────────────┬──────────────────────────────┘
                               │
            PostMessage:       │    PostMessage:
            - Akcje UI         │    - SimSnapshot (stany bolidów,
            - Sterowanie       │      czasy, delty, telemetria)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Wątek Symulacji (sim.worker.ts)               │
│  - Pętla fizyki 60 Hz z całkowaniem numerycznym (Car.ts)    │
│  - Inferencja 10 sieci neuronowych (NeuralNetwork.ts)       │
│  - Obliczanie kolizji z krawędziami toru (Grid Akceleracji) │
│  - Logika wyścigu, zużycia paliwa i pit-stopów              │
│  - Most komunikacyjny (SimBridge.ts)                        │
└─────────────────────────────────────────────────────────────┘
```

### Przepływ Migawki (`SimSnapshot`)
Wątek roboczy generuje skompresowany obiekt stanu `SimSnapshot`, który zawiera:
- Pozycje $(x, y)$, kąty, prędkości liniowe i kątowe bolidów,
- Wartości sensorów LiDAR, przeciążenia G, uślizgi kół i ślady opon,
- Czasy okrążeń, międzyczasy bramek pomiarowych,
- Stan wyścigu (IDLE, GRID_START, RACING, FINISHED), zużycie paliwa oraz status zjazdów do boksu.

Dzięki temu główny wątek jedynie odrysowuje gotowy stan, zachowując idealną płynność animacji.

---

## 3. Model Fizyki Pojazdu (Vehicle Dynamics 2D)

Fizyka bolidu (`Car.ts`) została oparta na rzeczywistych zasadach dynamiki pojazdów wyścigowych:

### A. Masa i Bezwładność
- **Masa sucha bolidu**: $798\text{ kg}$ (zgodnie z przepisami FIA).
- **Masa paliwa**: do $105\text{ kg}$ w zbiorniku.
- **Masa całkowita**: $M = 798\text{ kg} + M_{fuel}$.
- Wraz ze zużywaniem się paliwa bolid staje się lżejszy, co skraca drogę hamowania i poprawia przyspieszenie.

### B. Siły Aerodynamiczne
1. **Docisk aerodynamiczny (Downforce)**:
   $$F_{downforce} = \frac{1}{2} \cdot \rho \cdot C_L \cdot A \cdot v^2$$
   Przy prędkości $400\text{ km/h}$ docisk generuje ponad $2000\text{ kg}$ dodatkowego nacisku na koła, co podwaja przyczepność opon.
2. **Opór aerodynamiczny (Drag)**:
   $$F_{drag} = \frac{1}{2} \cdot \rho \cdot C_D \cdot A \cdot v^2$$
   Przy mocy silnika $1000\text{ KM}$ ($750\text{ kW}$) opór równoważy napęd przy prędkości ok. $425\text{ km/h}$.

### C. Dynamiczny Transfer Masy (Weight Transfer)
- **Wzdłużny (Pitch)**: Przyspieszanie dociąża oś tylną ($54\% \rightarrow 70\%$), hamowanie przerzuca masę na przód ($46\% \rightarrow 65\%$).
- **Poprzeczny (Roll)**: Siła odśrodkowa w zakrętach dociąża koła zewnętrzne kosztem wewnętrznych.

### D. Hamowanie Carbon-Ceramic z dociskiem (4.5–5.5 G)
Maksymalna siła hamowania uwzględnia potężny docisk aero przy wysokich prędkościach:
$$a_{brake} = (42.0 + a_{aero} \cdot 0.40) \cdot \text{brakingAggression}$$
Dzięki temu bolid wyhamowuje z $400\text{ km/h}$ do $120\text{ km/h}$ na odcinku ok. $110\text{–}125$ metrów.

### E. Model Przyczepności Opon i Poślizgów
- Koło tarcia Kamma (*Kamm's friction circle*): jednoczesne silne hamowanie zmniejsza dostępną przyczepność boczną.
- Modelowanie podsterowności (*understeer*) i nadsterowności (*oversteer*).
- Wizualizacja dymu i czarnych śladów opon (*skid marks*) na asfalcie przy przekroczeniu limitu trakcji.

---

## 4. Sztuczna Inteligencja (AI) i Algorytmy Uczenia

### A. Architektura Sieci Neuronowej (`NeuralNetwork.ts`)
Sieć neuronowa każdego kierowcy to wielowarstwowy perceptron (MLP) o architekturze:
- **Warstwa Wejściowa ($N_{rays} + 5$ neuronów)**:
  - 15–35 znormalizowanych promieni raycastingu badających odległość do krawędzi toru,
  - Znormalizowana prędkość bolidu,
  - Prędkość kątowa,
  - Kąt odchylenia od trajektorii toru (*heading error*),
  - Informacja o zbliżającej się krzywiźnie toru,
  - Wskaźnik bezpiecznej prędkości / dohamowania (*overspeedDelta*).
- **Warstwy Ukryte**: Warstwy gęste (18 i 14 neuronów) z funkcjami aktywacji $\tanh$.
- **Warstwa Wyjściowa (3 neurony)**:
  - `Steering` $[-1.0 \dots 1.0]$: Kąt skrętu kół,
  - `Throttle` $[0.0 \dots 1.0]$: Otwarcie przepustnicy,
  - `Brake` $[0.0 \dots 1.0]$: Siła nacisku na hamulec.

### B. Bufor Powtórek (Experience Replay Buffer)
Bolidy w trakcie jazdy gromadzą próbki kluczowych sytuacji na torze:
- Zapisywane są strefy dohamowań, wejścia w apexy zakrętów oraz **pełne otwarcie gazu na prostych**.
- Uczenie online odbywa się za pomocą wstecznej propagacji błędu (*Backpropagation*) ze stabilnym krokiem uczącym ($\eta = 0.001$).
- Nagroda w buforze bazuje na osiąganej prędkości liniowej (`reward: this.speedKmh`), co premiuje szybką, płynną jazdę bez zwalniania.

### C. Kooperacyjny Coaching Telemetryczny
Gdy którykolwiek z bolidów ustanowi absolutny rekord sesji (*Global Best Lap*), jego profil prędkości na każdym punkcie toru jest rejestrowany jako wzorzec telemetryczny. Pozostałe bolidy wykorzystują te dane, by podnosić swoje tempo w sekcjach, w których tracą czas do lidera.

---

## 5. Kluczowe Rozwiązania Inżynieryjne i Diagnoza Problemów

W toku rozwoju projektu zdiagnozowano i wyeliminowano dwa krytyczne problemy algorytmiczne:

### A. Eliminacja blokady prędkości 280 km/h na prostych
* **Problem**: Bolidy na długich prostych nie osiągały 400 km/h, lecz zatrzymywały się przy prędkości ok. 280 km/h.
* **Diagnoza**:
  1. Algorytm weryfikował zakręty 16 punktów do przodu (ok. 224 metry).
  2. Gdy bolid znajdował się nawet 200 m przed zakrętem 1 na długiej prostej, algorytm widział zakręt na horyzoncie i przedwcześnie wyłączał status otwartej prostej (`isOpenStraight`).
  3. Po wyłączeniu tego statusu przepustnica wracała do wyjścia sieci neuronowej, która podawała zaledwie ok. 28% otwarcia gazu.
  4. Z praw aerodynamiki bolidu F1, przy mocy 1000 KM i 28% gazu opór powietrza równoważy napęd przy **dokładnie 280 km/h**.
* **Rozwiązanie**:
  - Wprowadzono bezwzględną zasadę: jeśli bolid nie znajduje się w strefie dohamowania (`overspeedDelta <= 0`) i koła są wyprostowane (`|steer| < 0.35`), **przepustnica wynosi zawsze 100% (1.0), a hamulec 0.0**.
  - W rezultacie na prostych bolidy bez przeszkód osiągają prędkości rzędu **387–422 km/h**.

### B. Rozwiązanie problemu degradacji osiągów po setkach okrążeń (L800+)
* **Problem**: Po kilkuset okrążeniach (np. 800+ okrążeń) bolidy jeździły o 15 sekund wolniej (czasy z 01:17 spadały do 01:32).
* **Diagnoza**:
  1. Po ukończeniu każdego okrążenia kod wykonywał `car.brain.mutate(0.012, 0.035)`, dodając losowy szum do wag sieci. Po 800 okrążeniach sieć przeszła **800 losowych mutacji w ciemno**, co całkowicie zdegenerowało jej umiejętności (*catastrophic drift*).
  2. Zmienna `fitness` rosła nieustannie wraz z przejechanym dystansem, więc warunek `car.fitness > record.bestFitness` był spełniony w każdej klatce. W ten sposób `record.bestBrain` był stale nadpisywany zdegenerowaną siecią zamiast zachować mózg z rekordowego okrążenia 01:17.
* **Rozwiązanie**:
  1. **Usunięto ślepe mutacje** po ukończeniu okrążenia.
  2. Zapis mistrzowskiego mózgu (`record.bestBrain`) odbywa się **wyłącznie wtedy, gdy kierowca rzeczywiście pobije swój rekord życiowy**.
  3. **Mechanizm samonaprawczy (*Performance Guard*)**: Jeśli bolid pojedzie okrążenie wolniejsze o ponad 2.5s od swojego rekordu życiowego, jego mózg jest natychmiast przywracany z kopii zapasowej `bestBrain.clone()`.
  4. Dzięki temu czasy pozostają stabilne przez tysiące okrążeń.

### C. Trwałość mózgów AI i ochrona przed niepożądanym resetem
Zgodnie z założeniami projektowymi, raz wyuczona wiedza sieci neuronowej nie może zostać utracona przez przypadkowe kliknięcie:
- Zatrzymanie wyścigu (`STOP_RACE`), pauza oraz przycisk `Stop` **nie kasują sieci neuronowych**.
- Wyłącznymi akcjami, które resetują mózgi, są: narysowanie nowego toru, wczytanie nowego toru z pliku/presetu lub kliknięcie przycisku `Nowa Gen` / `Zresetuj AI`.

---

## 6. Tryby Symulacji

### A. Tryb Treningu i Ciągłej Ewolucji
- Ciągła jazda testowa 10 zespołów.
- W przypadku wypadnięcia z toru bolid odradza się w boksie po krótkiej karze czasowej.
- Pomiary sektorów, linii wyścigowej i prędkości maksymalnych.

### B. Tryb Wyścigu Grand Prix (50–100 Okrążeń)
- **Procedura Startowa**: Ustawienie na polach startowych (Grid) według kwalifikacji, sekwencja 5 czerwonych świateł zapalanych co 1 sekundę i start po ich zgaśnięciu (*Lights Out*).
- **Reguła DNF (Did Not Finish)**: W wyścigu uderzenie w barierę trwale eliminuje bolid z rywalizacji.
- **Klasyfikacja na żywo**: Liczenie strat do lidera w sekundach lub zdublowanych okrążeniach (`+1 OKR`).

### C. Strategia Pit-Stopów i Zużycie Paliwa
- Zbiornik mieści $105\text{ kg}$ paliwa.
- Spalanie zależy od otwarcia przepustnicy i prędkości obrotowej.
- Gdy poziom paliwa spadnie poniżej $12\text{ kg}$, bolid autonomicznie planuje zjazd do boksu (`BOX THIS LAP`). Gracz może wywołać zjazd klawiszem `[P]`.
- Zjazd w aleję serwisową zatrzymuje bolid na $3.2\text{ s}$ w dedykowanym stanowisku serwisowym (*Pit Box*), dotankowując paliwo.

---

## 7. System Pomiaru Czasów i Telemetria F1

Panel boczny udostępnia zestaw wskaźników telewizyjnych Formuły 1:

- **BEST**: Nienaruszalny rekord życiowy danego kierowcy w bieżącej sesji.
- **LAST**: Czas ostatnio ukończonego okrążenia, umożliwiający bieżącą ocenę tempa wyścigowego.
- **TERAZ**: Czas bieżącego kółka lub statusy bolidu (`PIT (3.2s)`, `[BOX]`, `💥 DNF`).
- **4 Bramki Pomiarowe (Sektory TimingGates)**:
  - 🟣 **Fioletowy (*Purple Sector*)**: Absolutny rekord sesji w danym sektorze,
  - 🟢 **Zielony (*Personal Best*)**: Poprawa własnego najlepszego międzyczasu,
  - 🔴 **Czerwony**: Czas gorszy od rekordu.
- **Wskaźniki Telemetrii**:
  - Cyfrowy prędkościomierz (km/h),
  - Wskaźnik przeciążeń bocznych i wzdłużnych G-Force,
  - Procentowy nacisk na oś przednią i tylną (Pitch),
  - Wizualizacja wag i połączeń sieci neuronowej w czasie rzeczywistym.

---

## 8. Edytor Torów i Interpolacja Spline'ami

- **Krzywe Catmull-Rom**: Punkty wprowadzane przez użytkownika myszką są automatycznie interpolowane gładką krzywą składaną (*closed spline*).
- **Generowanie Geometrii**:
  - Wyliczanie wektorów normalnych i stycznych w każdym punkcie,
  - Tworzenie krawędzi lewej, prawej, tarek wyścigowych (*kerbs*) oraz linii środkowej,
  - Siatka przestrzenna (*Uniform Grid*) dzieląca tor na komórki do błyskawicznej detekcji kolizji promieni LiDAR ($O(1)$ zamiast $O(N)$).
- **Automatyczna alokacja sektorów**: Rozmieszczenie 4 bramek pomiarowych co $25\%$, $50\%$, $75\%$ i $100\%$ długości toru.

---

## 9. Struktura Kodu Źródłowego

```text
f1/
├── index.html              # Interfejs użytkownika, panele HUD i Canvas
├── style.css               # Ciemny motyw wyścigowy F1, telemetria, responsywność
├── package.json            # Zależności i konfiguracja Vite / TypeScript
├── tsconfig.json           # Ścisłe reguły kompilatora TypeScript
├── README.md               # Podstawowy opis repozytorium GitHub
├── opis.md                 # Pełna dokumentacja techniczna systemu
└── src/
    ├── main.ts             # Główny kontroler aplikacji, pętla renderowania, obsługa UI
    ├── ai/
    │   ├── NeuralNetwork.ts # Perceptron wielowarstwowy, wagi, backprop, mutacja
    │   └── Population.ts   # 10 zespołów, algorytm genetyczny, selekcja, coaching
    ├── physics/
    │   └── Car.ts          # Silnik dynamiki bolidu, docisk aero, sensory, opony
    ├── rendering/
    │   └── Renderer.ts     # Rysowanie toru, bramek czasowych, bolidów i efektów
    ├── track/
    │   ├── Track.ts        # Geometria toru, grid przestrzenny, bramki czasowe
    │   └── Presets.ts      # Predefiniowane tory wyścigowe (Grand Prix, Owal)
    ├── math/
    │   ├── Vector2.ts      # Wektorowa biblioteka matematyczna 2D
    │   └── Spline.ts       # Interpolacja krzywych Catmull-Rom
    └── workers/
        ├── sim.worker.ts   # Wątek roboczy symulacji fizyki i wyścigu
        └── SimBridge.ts    # Komunikacja asynchroniczna z Web Workerem
```

---

## 10. Instrukcja Uruchomienia i Budowania

### Wymagania
- Środowisko **Node.js** (wersja $\ge 18$)
- Menedżer pakietów **npm**

### Uruchomienie lokalne
```bash
# 1. Instalacja zależności
npm install

# 2. Uruchomienie serwera deweloperskiego
npm run dev

# Dostęp w przeglądarce pod adresem: http://localhost:5173
```

### Budowanie wersji produkcyjnej
```bash
npm run build
```
Zoptymalizowany pakiet produkcyjny zostanie wygenerowany w katalogu `dist/`.
