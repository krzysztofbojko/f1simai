# 🏎️ F1 AI Simulator

Zaawansowany symulator bolidów Formuły 1 działający w przeglądarce w czasie rzeczywistym, napędzany **autonomicznymi sieciami neuronowymi**, **algorytmami genetycznymi** oraz **zaawansowanym modelem fizyki pojazdu 2D**.

Projekt łączy symulację wyścigową z uczeniem maszynowym: 10 zespołów i kierowców rywalizuje na torze, stopniowo optymalizując tor jazdy, punkty dohamowań i prędkości w zakrętach, a także mierzy się w pełnym trybie wyścigowym Grand Prix ze strategią pit-stopów i zużyciem paliwa.

---

## 📑 Spis Treści
1. [Główne Cechy Systemu](#-główne-cechy-systemu)
2. [Architektura i Wielowątkowość](#-architektura-i-wielowątkowość)
3. [Sztuczna Inteligencja (AI) i Uczenie Maszynowe](#-sztuczna-inteligencja-ai-i-uczenie-maszynowe)
4. [Model Fizyki Pojazdu (Vehicle Dynamics)](#-model-fizyki-pojazdu-vehicle-dynamics)
5. [Tryby Symulacji](#-tryby-symulacji)
6. [System Pomiaru Czasu i Telemetria F1](#-system-pomiaru-czasu-i-telemetria-f1)
7. [Edytor i Presety Torów](#-edytor-i-presety-torów)
8. [Sterowanie Graczem](#-sterowanie-graczem)
9. [Struktura Projektu](#-struktura-projektu)
10. [Instalacja i Uruchomienie](#-instalacja-i-uruchomienie)

---

## 🌟 Główne Cechy Systemu

- **10 zróżnicowanych zespołów F1**: Każdy bolid posiada unikalne malowanie, nazwisko kierowcy, indywidualne cechy stylu jazdy (agresja hamowania, skłonność do ryzyka) oraz własną ewoluującą sieć neuronową.
- **Hybrydowy model uczenia AI**: Połączenie ewolucji genetycznej, uczenia ze wzmocnieniem online (Replay Buffer) oraz kooperacyjnego coachingu telemetrycznego.
- **Prędkości rzędu 400+ km/h**: Realistyczne odwzorowanie aerodynamiki bolidu F1 z dociskiem skalującym się z kwadratem prędkości ($F_{downforce} \sim v^2$), umożliwiającym potężne opóźnienia hamowania (4.5–5G+).
- **Tryb Wyścigu Grand Prix (50–100 okrążeń)**:
  - Pełna procedura startowa z 5 czerwonymi światłami.
  - Zużycie paliwa wpływające na masę i osiągi bolidu.
  - Zjazdy do boksu (pit-stop) na dotankowanie bolidu.
  - Trwałe wykluczenie z wyścigu (DNF) w przypadku rozbicia bolidu.
- **Trwałość pamięci AI**: Mózgi kierowców nie ulegają skasowaniu przy zatrzymaniu lub przerwaniu wyścigu – AI uczy się nieustannie, a reset następuje wyłącznie na wyraźne żądanie użytkownika (Nowa Gen, wczytanie toru).
- **Wielowątkowa architektura (Web Worker)**: Silnik symulacji fizyki i inferencji AI działa w osobnym wątku roboczym, gwarantując stałe 60 FPS w interfejsie graficznym.

---

## 🏛️ Architektura i Wielowątkowość

System został zaprojektowany z myślą o maksymalnej wydajności i płynności:

```
┌────────────────────────────────────────────────────────┐
│                   Główny Wątek (UI)                    │
│  - Renderer Canvas 2D (bolidy, ślady opon, tor)        │
│  - Live HUD & Telemetria (BEST / LAST / TERAZ / delty) │
│  - Obsługa wejścia gracza (Klawiatura WASD / [P])      │
│  - Interaktywny edytor toru (Spline Editor)            │
└──────────────────────────┬─────────────────────────────┘
                           │ postMessage (SimSnapshot / Controls)
┌──────────────────────────▼─────────────────────────────┐
│             Wątek Roboczy (sim.worker.ts)              │
│  - Pętla fizyki Car.ts (transfer mas, opory, docisk)   │
│  - Inferencja Sieci Neuronowych (NeuralNetwork.ts)     │
│  - Bufor powtórek & optymalizacja wag online           │
│  - Zarządzanie populacją & ewolucja (Population.ts)    │
│  - Logika wyścigu, bramki czasowe i pit-stopy          │
└────────────────────────────────────────────────────────┘
```

- **`SimBridge.ts`**: Warstwa komunikacji pośrednicząca między wątkiem renderującym a workerem. Przesyła komendy sterujące oraz odbiera migawki stanu (`SimSnapshot`).
- **Niezależna częstotliwość próbkowania**: Symulacja fizyki zachowuje stabilność numeryczną nawet przy zmianie prędkości symulacji (1x, 2x, 5x, MAX).

---

## 🧠 Sztuczna Inteligencja (AI) i Uczenie Maszynowe

### 1. Architektura Sieci Neuronowej (`NeuralNetwork.ts`)
Każdy bolid sterowany jest przez wielowarstwowy perceptron (MLP):
- **Warstwa wejściowa**:
  - Od 15 do 35 sensorów odległościowych (promienie raycastingowe skanujące lewą, prawą i przednią krawędź toru).
  - Aktualna prędkość wzdłużna i poprzeczna bolidu.
  - Kąt odchylenia względem wektora stycznego toru (heading error).
  - Skręcenie kół i przyspieszenie kątowe.
  - Informacja o zbliżającej się krzywiźnie toru.
- **Warstwy ukryte**: W pełni połączone warstwy z nieliniowymi funkcjami aktywacji (Tanh / LeakyReLU).
- **Warstwa wyjściowa (3 neurony)**:
  - `Steering`: skręt kierownicą [-1.0 ... 1.0],
  - `Throttle`: otwarcie przepustnicy [0.0 ... 1.0],
  - `Brake`: siła hamowania [0.0 ... 1.0].

### 2. Algorytm Genetyczny (`Population.ts`)
- **Selekcja i Krzyżowanie**: Kierowcy, którzy uzyskują najwyższy wskaźnik przystosowania (*fitness*) oraz najszybsze czasy okrążeń, przekazują swoje wagi następnym pokoleniom.
- **Mutacja z chłodzeniem (Simulated Annealing)**: Współczynnik mutacji adaptuje się dynamicznie. Gdy kierowca bije swój rekord życiowy, siła mutacji zostaje schłodzona, by utrwalić zwycięski styl jazdy; w przypadku stagnacji współczynnik rośnie, szukając nowych rozwiązań.
- **Zachowanie nabytej wiedzy**: Przerwanie wyścigu lub pauza zachowuje `bestBrain` każdego zespołu.

### 3. Uczenie Online (Online Experience Replay)
- Bolidy zapisują w locie kluczowe punkty decyzyjne do bufora powtórek (`replayBuffer`).
- **Balans zakrętów i prostych**: System rejestruje zarówno punkty szczytowe zakrętów (apex) i dohamowania, jak i pełne otwarcie przepustnicy na prostych (`targetThrottle = 1.0, targetBrake = 0.0`), co zapobiega wypaczeniu sieci i gwarantuje jazdę z maksymalną prędkością do samego punktu hamowania.

### 4. Telemetry Coaching
- Najszybszy bolid sesji rejestruje swój profil prędkości wzdłuż trajektorii toru.
- Pozostałe bolidy AI odczytują profil lidera jako wskazówkę telemetryczną, co przyspiesza naukę całej stawki.

---

## 🏎️ Model Fizyki Pojazdu (Vehicle Dynamics)

Silnik fizyczny (`Car.ts`) implementuje realistyczne prawa dynamiki pojazdu:

- **Transfer Masy (Weight Transfer)**:
  - *Wzdłużny*: Przyspieszanie dociąża tylną oś (lepsza trakcja), a gwałtowne hamowanie przenosi masę na przód (ryzyko utraty stabilności tyłu).
  - *Poprzeczny*: W zakrętach siła odśrodkowa dociąża koła zewnętrzne i odciąża wewnętrzne.
- **Aerodynamika i Docisk (Downforce)**:
  - Skrzydła i dyfuzor generują docisk proporcjonalny do kwadratu prędkości.
  - Przy 400 km/h docisk aerodynamiczny podwaja efektywną przyczepność bolidu, umożliwiając pokonywanie łuków z gigantyczną prędkością i skracając drogę hamowania do zaledwie ~100–120 metrów.
- **Model Przyczepności Opon i Poślizgu**:
  - Obliczanie kątów poślizgu kół przednich i tylnych.
  - Realistyczna symulacja **podsterowności** (uciekanie przodu przy zbyt dużej prędkości na wejściu w zakręt) oraz **nadsterowności** (uciekanie tyłu przy zbyt gwałtownym dodaniu gazu).
  - Dynamiczne rysowanie śladów spalonej gumy (*skid marks*) na asfalcie.
- **Dynamika Masy Paliwa**:
  - Bolid startuje ze zdefiniowaną masą paliwa (np. 105 kg).
  - Spalanie paliwa zależy od wciśnięcia gazu i obrotów silnika.
  - Wraz ze spadkiem poziomu paliwa bolid staje się lżejszy, co poprawia przyspieszenie i skraca drogę hamowania.

---

## 🏁 Tryby Symulacji

### 1. Tryb Treningu i Ewolucji (Trening AI)
- Bolidy jeżdżą w nieskończonej sesji treningowej.
- W przypadku rozbicia bolid automatycznie odradza się w boksie po krótkiej karze czasowej.
- Na bieżąco rejestrowane są rekordy życiowe, optymalne linie wyścigowe oraz historia ewolucji.

### 2. Tryb Wyścigu Grand Prix
- **Konfiguracja dystansu**: Od 5 do 100 okrążeń.
- **Procedura startowa**: Ustawienie na polach startowych (Grid) według kwalifikacji, sekwencja 5 czerwonych świateł i start po ich zgaśnięciu.
- **Zasada DNF (Did Not Finish)**: Kolizja z bandą w trakcie wyścigu trwale eliminuje bolid z rywalizacji.
- **Strategia Pit-Stopów**:
  - Konieczność zjazdu do alei serwisowej przed wyczerpaniem paliwa.
  - Zjazd odbywa się po naciśnięciu przycisku zjazdu lub automatycznie przez AI w dedykowanym oknie zjazdowym.
  - Postój w boksie trwa wyliczony czas tankowania, po czym bolid powraca do rywalizacji.
- **Podium i Klasyfikacja Końcowa**: Po przekroczeniu linii mety przez zwycięzcę pojawia się podsumowanie wyścigu z czasami i stratami.

---

## ⏱️ System Pomiaru Czasu i Telemetria F1

Panel boczny oferuje profesjonalną oprawę telemetryczną w standardzie transmisji telewizyjnych F1:

- **BEST**: Niezmienny rekord życiowy danego kierowcy w bieżącej sesji.
- **LAST**: Czas ostatnio ukończonego okrążenia, pozwalający natychmiast zauważyć tempo wyścigowe danego kierowcy.
- **TERAZ**: Czas aktualnie pokonywanego okrążenia lub status bolidu (`PIT`, `[BOX]`, `DNF`).
- **Delty Checkpointów (Sektory Pomiarowe)**:
  - Tor podzielony jest na 4 bramki pomiarowe.
  - Porównanie międzyczasów w locie:
    - 🟣 **Fioletowy**: Rekord absolutny sesji w danym sektorze (*Purple Sector*),
    - 🟢 **Zielony**: Poprawa własnego najlepszego czasu w sektorze (*Personal Best*),
    - 🔴 **Czerwony**: Czas gorszy od własnego rekordu.
- **Panel Telemetrii Bolidu**: Wskaźnik prędkości (km/h), wskaźnik przeciążeń G-Force (G wzdłużne i poprzeczne), rozkład nacisku na osie, agresja hamowania oraz podgląd sieci neuronowej na żywo.

---

## 🛠️ Edytor i Presety Torów

- **Wbudowane tory**:
  - *Grand Prix*: Klasyczny, zrównoważony tor z długimi prostymi do 400 km/h, szykanami i technicznymi nawrotami.
  - *Owal*: Bardzo szybki tor testowy o wysokich prędkościach średnich.
- **Interaktywny Edytor (Rysowanie Toru)**:
  - Możliwość narysowania własnego toru myszką lub rysikiem na Canvasie.
  - Automatyczna interpolacja krzywymi składanymi (**Catmull-Rom Spline**).
  - Automatyczne wyznaczanie punktów kontrolnych, sektorów pomiarowych, linii startu/mety oraz pól startowych.
  - Zapis i odczyt konfiguracji torów do formatu JSON.

---

## 🎮 Sterowanie Graczem

W dowolnym momencie możesz przejąć kontrolę nad bolidem gracza lub dowolnym bolidem AI:
- **`W` / `Strzałka w górę`**: Przepustnica (Gaz)
- **`S` / `Strzałka w dół`**: Hamulec
- **`A` / `Strzałka w lewo`**: Skręt w lewo
- **`D` / `Strzałka w prawo`**: Skręt w prawo
- **`P`**: Zjazd do alei serwisowej (Box / Pit-stop)
- **Kliknięcie na bolid na liście**: Śledzenie wybranego kierowcy kamerą i podgląd jego telemetrii.

---

## 📁 Struktura Projektu

```text
f1/
├── index.html              # Główny widok HTML i układ paneli HUD
├── style.css               # Stylowanie F1 Dark Theme, telemetria, responsywność
├── package.json            # Zależności i skrypty Vite / TypeScript
├── tsconfig.json           # Konfiguracja kompilatora TypeScript
├── .gitignore              # Ignorowanie node_modules, dist, etc.
└── src/
    ├── main.ts             # Inicjalizacja aplikacji, pętla renderowania, obsługa UI
    ├── ai/
    │   ├── NeuralNetwork.ts # Architektura sieci MLP, wagi, propagacja, mutacja
    │   └── Population.ts   # Zarządzanie 10 zespołami, algorytm genetyczny, statystyki
    ├── physics/
    │   └── Car.ts          # Model dynamiki bolidu, docisk aero, sensory, opony
    ├── rendering/
    │   └── Renderer.ts     # Rysowanie toru, bolidów, śladów opon, efektów cząsteczkowych
    ├── track/
    │   ├── Track.ts        # Geometria toru, bramki czasowe, punkty kontrolne
    │   └── Presets.ts      # Predefiniowane tory wyścigowe (Grand Prix, Owal)
    ├── math/
    │   ├── Vector2.ts      # Operacje na wektorach 2D
    │   └── Spline.ts       # Matematyka krzywych Catmull-Rom do generowania toru
    └── workers/
        ├── sim.worker.ts   # Wątek roboczy symulacji fizyki i wyścigu
        └── SimBridge.ts    # Komunikacja asynchroniczna z Web Workerem
```

---

## 🚀 Instalacja i Uruchomienie

### Wymagania
- [Node.js](https://nodejs.org/) (wersja 18 lub nowsza)
- Menedżer pakietów `npm`

### Krok po kroku

1. **Sklonuj repozytorium**:
   ```bash
   git clone https://github.com/krzysztofbojko/f1simai.git
   cd f1simai
   ```

2. **Zainstaluj zależności**:
   ```bash
   npm install
   ```

3. **Uruchom serwer deweloperski**:
   ```bash
   npm run dev
   ```
   Aplikacja otworzy się pod adresem: `http://localhost:5173`.

4. **Budowanie wersji produkcyjnej**:
   ```bash
   npm run build
   ```
   Zoptymalizowane pliki produkcyjne trafią do folderu `dist/`.

---

## 📜 Licencja
Projekt udostępniany na licencji open-source.
