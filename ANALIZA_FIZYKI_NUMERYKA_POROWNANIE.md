# Kompleksowa Analiza Fizyki, Numeryki i Geometrii: F1 AI Simulator

**Projekt:** F1 AI Simulator (`/Users/krzysztofbojko/f1simai`)  
**Badane moduły źródłowe:**
- `src/physics/Car.ts` — Kinematyka, dynamika wzdłużna i poprzeczna bolidu, koło Kamma, aerodynamika, sensory.
- `src/workers/sim.worker.ts` — Pętla symulacji, profile obliczeniowe, zarządzanie czasem dyskretnym i pętlą zdarzeń.
- `src/track/Track.ts` — Dyskretna siatka przestrzenna (Uniform Spatial Grid $O(1)$), raycasting LiDAR, bramki sektorowe.
- `src/math/Spline.ts` — Parametryzacja krzywymi Catmull-Rom ($C^1$), równomierne próbkowanie wzdłuż łuku, krzywizna analityczna.
- `src/math/Vector2.ts` — Narzędzia wektorowe 2D, ciągła detekcja kolizji (CCD), przecięcia promieni z odcinkami.

---

## Spis treści
1. [Wstęp i Architektura Układu Fizycznego](#1-wstęp-i-architektura-układu-fizycznego)
2. [Metoda Całkowania Numerycznego i Dynamika Układu Dyskretnego](#2-metoda-całkowania-numerycznego-i-dynamika-układu-dyskretnego)
   - 2.1. Czas dyskretny ($dt = 1/60\,\text{s}$) i pętla wykonawcza Web Workera
   - 2.2. Matematyczna postać schematu całkowania: Semi-Implicit Euler
   - 2.3. Budżety obliczeniowe i profile wykonawcze (Eco, Balanced, Performance, Turbo)
   - 2.4. Stabilność numeryczna przy prędkościach rzędu 400 km/h (111.1 m/s)
   - 2.5. Obsługa osobliwości numerycznych, przejścia przez zero i zapobieganie drganiom (Chatter)
3. [Geometria Toru, Reprezentacja Przestrzenna i Detekcja Kolizji](#3-geometria-toru-reprezentacja-przestrzenna-i-detekcja-kolizji)
   - 3.1. Dyskretna siatka przestrzenna (Uniform Spatial Grid $O(1)$)
   - 3.2. Bezalokacyjne filtrowanie zapytań (Query ID Cache Invalidation)
   - 3.3. Interpolacja geometrii krzywymi Catmull-Rom ($C^1$) i reparametryzacja łukowa
   - 3.4. Różniczkowe wyznaczanie krzywizny $\kappa(s)$ i wektorów Freneta
   - 3.5. Bramki sektorowe (TimingGates) i ciągła detekcja kolizji (CCD)
   - 3.6. Model percepcyjny: Raycasting LiDAR (25 promieni, stożek $216^\circ$)
4. [Porównanie z Profesjonalnymi Symulatorami (rFactor 2, Assetto Corsa, iRacing)](#4-porównanie-z-profesjonalnymi-symulatorami-rfactor-2-assetto-corsa-iracing)
   - 4.1. Macierz porównawcza modeli fizycznych i architektur obliczeniowych
   - 4.2. Elementy modelowane realistycznie (Aero, Kamm Circle, Dynamic Weight Transfer, Fuel Mass)
   - 4.3. Kompromisy inżynieryjne na rzecz środowiska przeglądarkowego
   - 4.4. Analiza budżetu pamięci i ograniczeń silnika JavaScript V8
5. [Wnioski i Rekomendacje Rozwojowe](#5-wnioski-i-rekomendacje-rozwojowe)

---

## 1. Wstęp i Architektura Układu Fizycznego

Projekt **F1 AI Simulator** realizuje zaawansowaną symulację wyścigową w czasie rzeczywistym bezpośrednio w środowisku przeglądarkowym. Architektura projektu opiera się na separacji wątków:
- **Wątek główny (Main UI Thread):** Odpowiada wyłącznie za rendering graficzny Canvas 2D / WebGL, obsługę interfejsu użytkownika (DOM) oraz przechwytywanie wejść klawiatury.
- **Wątek dedykowany (Dedicated Web Worker — `sim.worker.ts`):** Całkowicie izolowane środowisko wykonawcze, w którym realizowana jest numeryczna pętla fizyki, inferencja sieci neuronowych bolidów, raycasting sensorów oraz algorytmy ewolucyjne populacji.

Taka konstrukcja zapobiega zjawisku blokowania interfejsu (UI jank) i umożliwia akcelerację symulacji (tryby szybsze niż czas rzeczywisty — np. 5×, 10× lub profil `turbo` do treningu nienadzorowanego).

Poniższy diagram przedstawia przepływ danych w pojedynczym kroku symulacji:

```
+-----------------------------------------------------------------------------------+
|                            Web Worker (simLoop @ 60Hz)                            |
|                                                                                   |
|  +------------------------+      +---------------------+      +----------------+  |
|  | Track (Spatial Grid)   | ---> | Car.updateSensors() | ---> | LiDAR Rays     |  |
|  | - boundaryGrid         |      | (25 rays @ 216 deg) |      | normalized     |  |
|  | - centerGrid           |      +---------------------+      +-------+--------+  |
|  +------------------------+                                           |           |
|                                                                       v           |
|  +------------------------+      +---------------------+      +----------------+  |
|  | Curvature & Overspeed  | ---> | Car.getAIControl()  | <--- | Neural Network |  |
|  | Lookahead (8-24 steps) |      | (Pure Pursuit + NN) |      | Forward Pass   |  |
|  +------------------------+      +----------+----------+      +----------------+  |
|                                             |                                     |
|                                             v                                     |
|                              +------------------------------+                     |
|                              | Car.updatePhysics(ctrl, dt)  |                     |
|                              | - Normal load Fz (Aero+Mass) |                     |
|                              | - Weight transfer (Ax, Ay)   |                     |
|                              | - Kamm Friction Circle       |                     |
|                              | - Semi-Implicit Euler step   |                     |
|                              +--------------+---------------+                     |
|                                             |                                     |
|                                             v                                     |
|  +------------------------+      +---------------------+      +----------------+  |
|  | Track Checkpoints      | <--- | checkTrackProgress()| ---> | Timing Splits  |  |
|  | Continuous Collisions  |      | Out-of-bounds check |      | Lap Completion |  |
|  +------------------------+      +---------------------+      +----------------+  |
+-----------------------------------------------------------------------------------+
                                              |
                               postMessage({ SNAPSHOT })
                                              v
+-----------------------------------------------------------------------------------+
|                         Main Thread (requestAnimationFrame)                       |
|                          Renderer.draw() & Telemetry HUD                          |
+-----------------------------------------------------------------------------------+
```

---

## 2. Metoda Całkowania Numerycznego i Dynamika Układu Dyskretnego

### 2.1. Czas dyskretny ($dt = 1/60\,\text{s}$) i pętla wykonawcza Web Workera

W pliku `src/workers/sim.worker.ts` (linia 511) zdefiniowano stały krok czasowy symulacji:
$$\Delta t = \frac{1}{60}\,\text{s} \approx 0.0166667\,\text{s} \quad (16.67\,\text{ms})$$

Zastosowanie stałego kroku czasowego (**Fixed Delta Time**) zamiast zmiennego czasu rzeczywistego ($\Delta t_{\text{variable}}$) jest fundamentalną zasadą deterministycznych symulatorów fizycznych. Zmienne $\Delta t$ prowadziłoby do:
1. Nierozwiązywalnych różnic w zachowaniu sztucznej inteligencji przy wahaniach obciążenia procesora.
2. Niestabilności całkowania przy nagłych spadkach płynności (np. skok $\Delta t$ do $100\,\text{ms}$ przy intensywnym garbage collection).
3. Utraty powtarzalności wyników okrążeń.

Pętla wykonawcza w workerze opiera się na wywołaniu `setInterval(simLoop, 16)`. W każdym takcie wywoływana jest funkcja `runSimulationSteps()`, która w zależności od wybranego mnożnika prędkości wykonuje zadaną liczbę dyskretnych kroków $\Delta t$.

### 2.2. Matematyczna postać schematu całkowania: Semi-Implicit Euler

W `src/physics/Car.ts` dynamika pojazdu jest rozwiązywana za pomocą **metody Semi-Implicit Euler** (znanej również jako **Euler-Cromer** lub **symplektyczny Euler**). 

W przeciwieństwie do standardowej metody jawnej Eulera (Explicit Euler):
$$\begin{aligned}
\vec{x}_{n+1} &= \vec{x}_n + \vec{v}_n \Delta t \\
\vec{v}_{n+1} &= \vec{v}_n + \vec{a}(\vec{x}_n, \vec{v}_n) \Delta t
\end{aligned}$$
w metodzie **Semi-Implicit Euler** położenie jest aktualizowane przy użyciu *nowej*, zaktualizowanej prędkości $\vec{v}_{n+1}$:
$$\begin{aligned}
\vec{v}_{n+1} &= \vec{v}_n + \vec{a}(\vec{x}_n, \vec{v}_n) \Delta t \\
\vec{x}_{n+1} &= \vec{x}_n + \vec{v}_{n+1} \Delta t
\end{aligned}$$

#### Rzeczywista implementacja w kodzie (`src/physics/Car.ts`):
1. **Predykcja prędkości wzdłużnej bez oporów:**
   $$v^* = v_{\text{forward}} + \frac{F_{\text{drive}} + F_{\text{aero\_drag}}}{m} \Delta t$$
2. **Korekta o siły oporowe (hamulce + opór toczenia):**
   $$v_{\text{forward}, n+1} = v^* + \frac{F_{\text{net\_resist}}}{m} \Delta t$$
3. **Aktualizacja kąta orientacji (Heading):**
   $$\omega_{n+1} = \text{actualYawRate}$$
   $$\theta_{n+1} = \theta_n + \omega_{n+1} \Delta t$$
4. **Transformacja wektorowa do układu globalnego:**
   $$\vec{u}_{\text{forward}} = \begin{bmatrix} \cos(\theta_{n+1}) \\ \sin(\theta_{n+1}) \end{bmatrix}, \quad \vec{u}_{\text{right}} = \begin{bmatrix} -\sin(\theta_{n+1}) \\ \cos(\theta_{n+1}) \end{bmatrix}$$
   $$\vec{v}_{n+1} = \vec{u}_{\text{forward}} \cdot v_{\text{forward}, n+1} + \vec{u}_{\text{right}} \cdot v_{\text{lateral}, n+1}$$
5. **Aktualizacja wektora położenia:**
   $$\vec{x}_{n+1} = \vec{x}_n + \vec{v}_{n+1} \Delta t$$

#### Zalety numeryczne Semi-Implicit Euler w tym zastosowaniu:
- **Symplektyczność (Zachowanie przestrzeni fazowej):** Schemat nie pompuje sztucznej energii kinetycznej do układu orbitalnego/obrotowego, co jest typową wadą jawnego Eulera w układach z siłami sprężysto-tłumiącymi.
- **Zerowy narzut pamięciowy:** Metody wyższych rzędów (np. Runge-Kutta 4. rzędu — RK4) wymagają 4 ewaluacji funkcji sił na krok, co przy 10 bolidach i 25 promieniach LiDARu na bolid oznaczałoby 1000 raycastów na pojedynczy krok dyskretny. Semi-Implicit Euler wymaga dokładnie 1 ewaluacji na krok.

### 2.3. Budżety obliczeniowe i profile wykonawcze (Eco, Balanced, Performance, Turbo)

Aby zbalansować zużycie procesora, płynność telemetrii i szybkość uczenia maszynowego, w `src/workers/sim.worker.ts` zaimplementowano konfigurowalny system profili obliczeniowych:

| Profil | Kroków na takt (`stepsPerTick`) | Częstotliwość migawek (`snapshotIntervalMs`) | Tryb Headless | Maks. budżet podkroków (`maxSubStepsBudget`) | Zastosowanie |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **`eco`** | 1 | 33 ms (~30 Hz) | `false` | 15 | Urządzenia mobilne, oszczędzanie baterii |
| **`balanced`** | 1 (lub mnożnik) | 16 ms (~60 Hz) | `false` | 200 | Domyślna rozgrywka, pełna wierność wizualna |
| **`performance`** | 5 | 33 ms (~30 Hz) | `false` | 250 | Szybka symulacja przy zachowaniu podglądu |
| **`turbo`** | 50 | 200 ms (5 Hz) | `true` | 300 | Trening AI na maksymalnej prędkości |

#### Ochrona pętli zdarzeń przed zagłodzeniem (Event Loop Starvation Protection):
W pętli wielokrokowych obliczeń (`sim.worker.ts`, linie 512–520):
```typescript
const tickStartTime = performance.now();
const MAX_TICK_EXECUTION_TIME_MS = 35; // Safe boundary limit

for (let s = 0; s < steps; s++) {
  if (s > 10 && (s & 3) === 0) {
    if (performance.now() - tickStartTime > MAX_TICK_EXECUTION_TIME_MS) {
      break; // Przerwij pętlę, oddaj sterowanie do event loopa
    }
  }
  // ... krok symulacji
}
```
Mechanizm ten zapobiega zawieszeniu workera przy skrajnych mnożnikach prędkości (np. `speed = max`), gwarantując, że komunikaty przychodzące z wątku głównego (`onmessage`) będą odbierane bez opóźnień.

### 2.4. Stabilność numeryczna przy prędkościach rzędu 400 km/h (111.1 m/s)

Bolidy Formuły 1 osiągają prędkości maksymalne rzędu $360\text{--}400\,\text{km/h}$ ($100\text{--}111.1\,\text{m/s}$). Zbadajmy stabilność układu przy $v = 111.1\,\text{m/s}$ i $\Delta t = 1/60\,\text{s}$:

#### 1. Przemieszczenie na krok (Displacement per Step):
$$\Delta s = v \cdot \Delta t = 111.1\,\text{m/s} \times 0.01667\,\text{s} \approx 1.852\,\text{m}$$
Przy skali $1\,\text{px} = 1\,\text{m}$ bolid przemieszcza się o $\approx 1.85\,\text{px}$ na krok.
Wymiary bolidu w symulacji to długość $L_{\text{vis}} = 30\,\text{px}$ i szerokość $W_{\text{vis}} = 14\,\text{px}$ (baza kół $L = 3.6\,\text{m}$, rozstaw kół $W = 1.8\,\text{m}$).
Ponieważ $\Delta s = 1.85\,\text{m} \ll L_{\text{vis}} = 30\,\text{m}$, nie występuje zjawisko "teleportacji" w jednym kroku względem własnej geometrii pojazdu.

#### 2. Stabilność tłumienia aerodynamicznego (Aero Damping Stability):
Równanie oporu aerodynamicznego:
$$F_{\text{drag}} = \frac{1}{2} \rho (C_d A) v^2$$
Równanie różniczkowe prędkości pod wpływem samego oporu:
$$\frac{dv}{dt} = -\frac{\rho C_d A}{2 m} v^2$$
Warunek stabilności numerycznej jawnego schematu dla równania nieliniowego typu $\dot{v} = -f(v)$ wymaga:
$$\Delta t < \frac{2}{\left| \frac{\partial f}{\partial v} \right|} = \frac{2 m}{\rho C_d A v}$$
Dla parametrów bolidu z `Car.ts`:
- $m = 798\,\text{kg} + 105\,\text{kg} = 903\,\text{kg}$
- $\rho = 1.225\,\text{kg/m}^3$
- $C_d A = 1.00\,\text{m}^2$
- $v = 111.1\,\text{m/s}$

Obliczamy graniczną wartość kroku czasowego:
$$\Delta t_{\text{crit}} = \frac{2 \times 903}{1.225 \times 1.00 \times 111.1} = \frac{1806}{136.1} \approx 13.27\,\text{s}$$
Ponieważ rzeczywisty krok $\Delta t = 0.0167\,\text{s}$ jest o **prawie 800 razy mniejszy** niż $\Delta t_{\text{crit}}$, człon oporu aerodynamicznego jest **bezwzględnie stabilny numerycznie** i nie wykazuje oscylacji.

#### 3. Docisk aerodynamiczny przy 400 km/h:
$$F_{\text{downforce}} = \frac{1}{2} \rho (C_l A) v^2 = 0.5 \times 1.225 \times 3.10 \times (111.11)^2 \approx 23\,443\,\text{N}$$
W przeliczeniu na masę ekwiwalentną:
$$m_{\text{aero}} = \frac{23\,443\,\text{N}}{9.81\,\text{m/s}^2} \approx 2390\,\text{kg} \quad (\approx 2.4\,\text{tony docisku})$$
Całkowity nacisk normalny na podłoże wynosi:
$$F_z = m \cdot g + F_{\text{downforce}} \approx 903 \times 9.81 + 23\,443 \approx 8858 + 23\,443 = 32\,301\,\text{N}$$
Dzięki temu dostępna siła przyczepności opon rośnie z $\approx 16\,387\,\text{N}$ przy zerowej prędkości do ponad $59\,750\,\text{N}$ przy $400\,\text{km/h}$.

### 2.5. Obsługa osobliwości numerycznych, przejścia przez zero i zapobieganie drganiom (Chatter)

Klasycznym problemem dyskretnych modeli tarcia w jawnym całkowaniu jest zachowanie przy zerowej prędkości: siła hamowania lub tarcia statycznego $F = -\text{sign}(v) \cdot F_{\text{brake}}$ przy małym $v$ i dużym $F_{\text{brake}}$ odwraca wektor prędkości w każdym kroku, generując niegasnące drgania o wysokiej częstotliwości (numerical chatter / hunting).

W `src/physics/Car.ts` (linie 592–612) zaimplementowano precyzyjne zabezpieczenie:
```typescript
// 1. Predykcja prędkości przed uwzględnieniem oporów:
const vStar = forwardSpeed + ((driveForceMag + aeroDragForce) / currentMass) * dt;

// 2. Maksymalna siła potrzebna do dokładnego zatrzymania w danym kroku:
const forceToStop = (currentMass * Math.abs(vStar)) / dt;

// 3. Rzeczywista siła oporu ograniczona do forceToStop:
const actualResistMag = Math.min(maxResistMag, forceToStop);
const netResistForce = -Math.sign(vStar) * actualResistMag;

let newForwardSpeed = vStar + (netResistForce / currentMass) * dt;
if (Math.abs(newForwardSpeed) < 1e-6) {
  newForwardSpeed = 0;
}
```

Dzięki temu:
- Siły oporowe (hamulce węglowe + opór toczenia) **nigdy nie są w stanie nadać pojazdowi prędkości wstecznej**.
- Przy zatrzymaniu pojazd osiąga dokładnie $v = 0$ bez oscylacji i bez artefaktów numerycznych.

---

## 3. Geometria Toru, Reprezentacja Przestrzenna i Detekcja Kolizji

### 3.1. Dyskretna siatka przestrzenna (Uniform Spatial Grid $O(1)$)

W profesjonalnych silnikach fizycznych stosuje się dwufazową detekcję kolizji: fazę zgrubną (Broadphase) oraz fazę szczegółową (Narrowphase). W F1 AI Simulator zaimplementowano autorską, wysoce zoptymalizowaną strukturę **Uniform Spatial Grid** w klasie `Track` (`src/track/Track.ts`).

#### Parametry struktury:
- Rozmiar komórki: `spatialCellSize = 80` px (metrów).
- Dwie niezależne siatki:
  1. `boundaryGrid: Map<number, IndexedSegment[]>` — krawędzie lewej i prawej bandy toru.
  2. `centerGrid: Map<number, IndexedSegment[]>` — segmenty linii środkowej toru (do testu wyjechania poza tor).

#### Bitowa funkcja haszująca komórki:
```typescript
private hashCell(gx: number, gy: number): number {
  return (gx << 16) | (gy & 0xffff);
}
```
Zastosowanie przesunięcia bitowego `(gx << 16) | (gy & 0xffff)` mapuje parę współrzędnych całkowitych siatki $(g_x, g_y)$ bezpośrednio na 32-bitową liczbę całkowitą (32-bit signed integer). W silniku V8 (Google Chrome / Node.js) liczby te są reprezentowane jako **SMI (Small Integers)** — natywne wartości bezpośrednie bez alokacji wskaźników na stercie, co zapewnia maksymalną wydajność operacji w `Map.get()` i `Map.set()`.

#### Indeksowanie segmentów w komórkach:
Każdy odcinek toru $\overline{P_1 P_2}$ wyznacza obwiednię AABB w układzie siatki:
$$g_{x,\min} = \left\lfloor \frac{\min(p_1.x, p_2.x)}{c_s} \right\rfloor, \quad g_{x,\max} = \left\lfloor \frac{\max(p_1.x, p_2.x)}{c_s} \right\rfloor$$
Segment jest dodawany wyłącznie do komórek pokrywających jego AABB.

```
+------------+------------+------------+
| (gx-1,gy+1)|  (gx,gy+1) | (gx+1,gy+1)|
|            |    P2      |            |
+------------+-----\------+------------+
| (gx-1,gy)  |      \     | (gx+1,gy)  |
|            |       \    |            |
+------------+--------\---+------------+
| (gx-1,gy-1)|  P1     \  | (gx+1,gy-1)|
|            |          \ |            |
+------------+------------+------------+
  <-- spatialCellSize = 80px -->
```

### 3.2. Bezalokacyjne filtrowanie zapytań (Query ID Cache Invalidation)

Segment geometryczny przekraczający granicę komórek siatki znajduje się na listach kilku sąsiednich komórek. Naiwne przeszukanie siatki prowadziłoby do wielokrotnego testowania tego samego segmentu w ramach jednego promienia LiDARu. Standardowe rozwiązanie z użyciem `Set<number>` generowałoby jednak setki alokacji obiektów na klatkę, obciążając Garbage Collector.

W `Track.ts` zastosowano technikę **Query ID**:
```typescript
export interface IndexedSegment extends LineSegment {
  id: number;
  lastQueryId: number;
}
```
Przy każdym zapytaniu (`castRay` lub `isOutOfBounds`) inkrementowany jest globalny licznik:
`this.queryId++`.
W pętli sprawdzania segmentów:
```typescript
if (seg.lastQueryId === qId) continue; // Już testowany w tym zapytaniu!
seg.lastQueryId = qId;
```
Dzięki temu żaden segment nie jest testowany dwukrotnie w tym samym zapytaniu, przy **zerowym koszcie alokacji pamięci** (brak alokacji `Set`, tablic pomocniczych czy czyszczenia struktur).

### 3.3. Interpolacja geometrii krzywymi Catmull-Rom ($C^1$) i reparametryzacja łukowa

Geometria toru jest generowana z punktów kontrolnych za pomocą **krzywych składanych Catmull-Rom** w klasie `Spline` (`src/math/Spline.ts`).

#### Matematyczne równanie bazowe Catmull-Rom:
Dla czterech punktów kontrolnych $P_0, P_1, P_2, P_3$ i parametru $t \in [0, 1]$:
$$\vec{C}(t) = \frac{1}{2} \begin{bmatrix} 1 & t & t^2 & t^3 \end{bmatrix} \begin{bmatrix} 0 & 2 & 0 & 0 \\ -1 & 0 & 1 & 0 \\ 2 & -5 & 4 & -1 \\ -1 & 3 & -3 & 1 \end{bmatrix} \begin{bmatrix} P_0 \\ P_1 \\ P_2 \\ P_3 \end{bmatrix}$$
Rozpisane na wielomiany wagowe:
$$\begin{aligned}
f_0(t) &= -0.5 t^3 + t^2 - 0.5 t \\
f_1(t) &= 1.5 t^3 - 2.5 t^2 + 1.0 \\
f_2(t) &= -1.5 t^3 + 2.0 t^2 + 0.5 t \\
f_3(t) &= 0.5 t^3 - 0.5 t^2
\end{aligned}$$
Krzywa ta posiada ciągłość klasy **$C^1$** — pierwsza pochodna $\vec{C}'(t)$ jest ciągła, co gwarantuje gładkość wektora stycznego i brak skoków siły odśrodkowej na łączeniach segmentów.

#### Reparametryzacja według długości łuku (Arc-Length Parameterization):
Równomierny przyrost parametru $t$ w krzywych sklejanych nie oznacza stałej prędkości wzdłuż krzywej ($|\vec{C}'(t)| \neq \text{const}$). Gdyby punkty toru rozmieścić według stałego $\Delta t$, na zakrętach punkty leżałyby gęściej lub rzadziej niż na prostych.

W `Spline.ts` zastosowano dwuetapową reparametryzację:
1. Wstępne gęste próbkowanie segmentu (12 próbek).
2. Obliczenie tablicy dystansu skumulowanego:
   $$s_0 = 0, \quad s_i = s_{i-1} + |P_i - P_{i-1}|$$
3. Ponowne próbkowanie ze stałym krokiem przestrzennym $\Delta s = \text{targetSpacing} \approx 18\text{--}20\,\text{m}$ za pomocą interpolacji liniowej pomiędzy próbkami:
   $$P(s) = \text{lerp}\left(P_A, P_B, \frac{s - s_A}{s_B - s_A}\right)$$

Daje to idealnie równomierną siatkę checkpointów wzdłuż całego toru.

### 3.4. Różniczkowe wyznaczanie krzywizny $\kappa(s)$ i wektorów Freneta

Dla każdego wygenerowanego punktu toru obliczany jest lokalny układ odniesienia (układ Freneta-Serreta w 2D):
- **Wektor styczny:**
  $$\vec{T}_i = \frac{P_{i+1} - P_{i-1}}{|P_{i+1} - P_{i-1}|}$$
- **Wektor normalny (skierowany w lewo):**
  $$\vec{N}_i = \begin{bmatrix} -T_{i,y} \\ T_{i,x} \end{bmatrix}$$
- **Krawędzie toru o szerokości $W$:**
  $$P_{\text{left}, i} = P_i + \vec{N}_i \cdot \frac{W}{2}, \quad P_{\text{right}, i} = P_i - \vec{N}_i \cdot \frac{W}{2}$$

#### Analityczna krzywizna $\kappa$:
Krzywizna $\kappa = \frac{d\theta}{ds}$ informuje o odwrotności promienia łuku ($R = 1 / |\kappa|$). W `Spline.ts` (linie 120–133) wyznaczana jest z iloczynu wektorowego i skalarnego kolejnych wektorów kierunkowych:
$$\vec{u}_1 = \frac{P_i - P_{i-1}}{|P_i - P_{i-1}|}, \quad \vec{u}_2 = \frac{P_{i+1} - P_i}{|P_{i+1} - P_i|}$$
$$\sin(\Delta\theta) = \vec{u}_1 \times \vec{u}_2 = u_{1,x} u_{2,y} - u_{1,y} u_{2,x}$$
$$\cos(\Delta\theta) = \vec{u}_1 \cdot \vec{u}_2 = u_{1,x} u_{2,x} + u_{1,y} u_{2,y}$$
$$\Delta\theta = \text{atan2}(\sin(\Delta\theta), \cos(\Delta\theta))$$
$$\kappa_i = \frac{\Delta\theta}{\Delta s_i} \quad \left[\frac{\text{rad}}{\text{m}} = \frac{1}{\text{m}}\right]$$
Znak $\kappa$ określa kierunek zakrętu ($\kappa > 0$ — skręt w lewo, $\kappa < 0$ — skręt w prawo). Informacja ta jest bezpośrednio przekazywana do systemu AI bolidu w celu predykcji stref dohamowania.

### 3.5. Bramki sektorowe (TimingGates) i ciągła detekcja kolizji (CCD)

Do precyzyjnego pomiaru czasów sektorowych i okrążeń w `Track.ts` i `Car.ts` zaimplementowano 4 bramki timingowe:
- **CP 1:** 25% dystansu toru (Sektor 1)
- **CP 2:** 50% dystansu toru (Sektor 2)
- **CP 3:** 75% dystansu toru (Sektor 3)
- **CP 4 (META):** 100% / linia Start/Meta (Sektor 4 i czas okrążenia)

#### Ciągła detekcja przecięcia bramki (CCD):
Aby wyeliminować ryzyko przeskoczenia linii mety przy $400\,\text{km/h}$, zastosowano test przecięcia odcinka przemieszczenia pojazdu $\overline{P_{\text{prev}} P_{\text{curr}}}$ z poprzecznym odcinkiem bramki $\overline{G_{\text{left}} G_{\text{right}}}$:
```typescript
// Szybka faza zgrubna AABB (Broadphase):
if (maxX1 >= minX2 && minX1 <= maxX2 && maxY1 >= minY2 && minY1 <= maxY2) {
  crossedGate = segmentsIntersect(this.prevPos, this.pos, nextCp.p1, nextCp.p2);
}
```
Funkcja `segmentsIntersect` wykorzystuje orientację punktów w przestrzeni (test CCW - Counter-Clockwise) oparty na znaku wyznacznika 2D:
$$\text{CCW}(A, B, C) = (C_y - A_y)(B_x - A_x) > (B_y - A_y)(C_x - A_x)$$
Warunek przecięcia:
$$\text{CCW}(P_1, Q_1, Q_2) \neq \text{CCW}(P_2, Q_1, Q_2) \quad \land \quad \text{CCW}(P_1, P_2, Q_1) \neq \text{CCW}(P_1, P_2, Q_2)$$

#### Zabezpieczenia synoptyczne i reguły sportowe:
1. **Kierunek wektora prędkości:** Bramka jest zaliczana tylko wtedy, gdy rzut prędkości na styczną toru jest dodatni: $\vec{v} \cdot \vec{T}_{\text{gate}} > 0.5$ (wykluczenie zaliczenia przy jeździe pod prąd).
2. **Sekwencyjność checkpointów:** Następny checkpoint to zawsze $(i + 1) \pmod N$. Bolid nie może ściąć toru pomijając sektory pośrednie.
3. **Zasada 80% okrążenia:** Aby zamknąć okrążenie na linii mety, bolid musi mieć zaliczone co najmniej $80\%$ wszystkich checkpointów toru (`checkpointsCleared >= track.checkpoints.length * 0.8`), co uniemożliwia zaliczenie okrążenia po natychmiastowym nawrocie za linią startu.

### 3.6. Model percepcyjny: Raycasting LiDAR (25 promieni, stożek $216^\circ$)

Sztuczna inteligencja bolidu postrzega otoczenie za pomocą wirtualnego sensora LiDAR (`Car.ts`, linie 118–128 oraz `Track.ts`, linie 213–252).

#### Parametry geometrii sensora:
- Liczba promieni: $N_{\text{rays}} = 25$ (wartość domyślna, konfigurowalna w UI).
- Kąt widzenia (Field of View): $216^\circ$ ($[-108^\circ, +108^\circ]$ względem osi wzdłużnej bolidu).
- Krok kątowy promieni:
  $$\Delta\alpha = \frac{216^\circ}{24} = 9^\circ$$
- Zasięg maksymalny: $R_{\text{max}} = 240\,\text{m}$.

#### Matematyka przecięcia promienia z segmentem bandy:
Dla promienia o początku $O$ i kierunku $\vec{D} = (\cos\phi, \sin\phi)$ o długości $R_{\text{max}}$, oraz segmentu bandy $\overline{A B}$:
Układ równań parametrycznych:
$$O + t \vec{D} = A + u (B - A), \quad t \in [0, 1], \quad u \in [0, 1]$$
Rozwiązanie z reguły Cramera:
$$\text{Det} = D_x (B_y - A_y) - D_y (B_x - A_x)$$
Jeśli $|\text{Det}| < 10^{-6}$, promień jest równoległy do bandy. W przeciwnym razie:
$$t = \frac{(A_x - O_x)(B_y - A_y) - (A_y - O_y)(B_x - A_x)}{\text{Det}}$$
$$u = \frac{(A_x - O_x) D_y - (A_y - O_y) D_x}{\text{Det}}$$
Przecięcie zachodzi, gdy $t \in [0, 1]$ oraz $u \in [0, 1]$. Rzeczywista odległość:
$$d = t \cdot R_{\text{max}}$$

Dzięki siatce przestrzennej `boundaryGrid` testowane są tylko segmenty w komórkach przecinanych przez promień, co redukuje liczbę sprawdzanych odcinków z 320 do zaledwie 4–8 na promień.

---

## 4. Porównanie z Profesjonalnymi Symulatorami (rFactor 2, Assetto Corsa, iRacing)

### 4.1. Macierz porównawcza modeli fizycznych i architektur obliczeniowych

Poniższa tabela stanowi szczegółowe inżynieryjne zestawienie F1 AI Simulator z wiodącymi silnikami symulacyjnymi na rynku:

| Cecha / Podsystem | F1 AI Simulator (Web/TypeScript) | rFactor 2 (ISI / Studio 397) | Assetto Corsa (Kunos Simulazioni) | iRacing (iRacing.com Motorsport) |
| :--- | :--- | :--- | :--- | :--- |
| **Środowisko uruchomieniowe** | Przeglądarka (V8 / Web Worker, JS/TS) | Natywna aplikacja C++ (DirectX/Win32) | Natywna aplikacja C++ (DirectX/Win32) | Natywna aplikacja C++ (DirectX/Win32) |
| **Częstotliwość pętli fizyki** | **60 Hz** ($\Delta t = 16.67\,\text{ms}$) | **400 Hz** ($\Delta t = 2.5\,\text{ms}$) | **333 Hz** ($\Delta t = 3.0\,\text{ms}$) | **360 Hz** ($\Delta t = 2.78\,\text{ms}$) |
| **Metoda całkowania** | Semi-Implicit Euler (1. rzędu) | Runge-Kutta 4. rzędu (RK4) / Symplectic | Runge-Kutta / Zmodyfikowany Euler | Niejawny Euler wielokrokowy |
| **Model opony** | Analityczne koło tarcia Kamma ($\mu F_z$) z poślizgiem | **TGM (Tyre Ground Model)** — fizyka szczotkowa 2D/3D z węzłami termicznymi | **Pacejka MF 5.2 / Kunos Brush Model** | **New Tyre Model (NTM v7)** — dyskretyzacja karkasu i bieżnika |
| **Termodynamika opon** | Brak (stałe $\mu$ z wariacją sesyjną) | Pełna: temperatura wewnętrzna, karkasu, bieżnika i błyskawiczna (flash temp.) | Pełna: rdzeń, powierzchnia, ciśnienie gazu | Pełna: dynamiczne ciśnienie, nagrzewanie, degradacja mieszanki |
| **Kinematyka zawieszenia** | 2D Single-Track (Bicycle) + wzdłużny/poprzeczny transfer masy | Pełne wielowahaczowe 3D (Double Wishbone, Pushrod, Heave Damper, ARB) | Wielowahaczowe 3D ze skokiem, kątami Camber/Toe i bump stopami | Wielowahaczowe 3D z ugięciem tulei metalowo-gumowych (compliance) |
| **Stopnie swobody (DOF)** | **3 DOF** ($x, y, \theta$) + 2 wirtualne (pitch, roll) | **14–20 DOF** (nadwozie 6 DOF + 4 koła po 2 DOF + układ kierowniczy) | **14 DOF** (nadwozie 6 DOF + 4 zawieszenia + 4 obroty kół) | **14–18 DOF** ze sprzężeniem aero-sprężystym |
| **Układ napędowy** | Płynny silnik $P_{\max} = 750\,\text{kW}$ ($F = P / v$) ze sztuczną kontrolą trakcji | V6 Turbo Hybryda (ICE + MGU-K + MGU-H), turbo lag, mapy momentu, 8 biegów | Skrzynia kłowa/sekwencyjna, dyferencjał płytkowy z preloadem, sprzęgło | Pełny model spalinowo-hybrydowy, czasy zmiany biegów, bezwładność wału |
| **Powierzchnia toru** | Płaska 2D, gładka krzywa Catmull-Rom | Prawdziwe 3D ze skanów laserowych, technologia RealRoad (gumowanie toru) | Prawdziwe 3D ze skanów LiDAR, zmienna przyczepność i wyboje | Skan laserowy sub-centymetrowy, dynamiczny stan toru (temperatura, guma) |
| **Liczba pojazdów symulowanych równolegle** | **10 bolidów z siecią neuronową i 25 promieniami LiDARu** | Zwykle 20–40 (natywny kod CPU, dedykowane rdzenie) | Zwykle 24–36 | Do 60 (serwer fizyczny) |

### 4.2. Elementy modelowane realistycznie

Wbrew pozorom i ograniczeniom przeglądarki, model w `Car.ts` implementuje zestaw równań, które z dużą wiernością oddają kluczowe zjawiska dynamiki bolidu wyścigowego:

#### 1. Aerodynamika zależna od kwadratu prędkości ($v^2$):
Wiele gier zręcznościowych stosuje stałą przyczepność niezależnie od prędkości. F1 AI Simulator ściśle przestrzega fizyki przepływu:
$$F_{\text{downforce}} = \frac{1}{2} \rho (C_l A) v^2, \quad F_{\text{drag}} = \frac{1}{2} \rho (C_d A) v^2$$
Dzięki temu:
- Przy niskich prędkościach (np. $80\,\text{km/h}$ w nawrocie) bolid ma relatywnie małą przyczepność i łatwo zerwać trakcję przy dodaniu gazu.
- W szybkich łukach ($250\text{--}300\,\text{km/h}$) docisk rzędu 1.5–2.0 ton pozwala na generowanie przeciążeń bocznych sięgających **$4.5\text{--}5.5\,G$**, co jest wzorcowoczą cechą współczesnych bolidów F1.

#### 2. Dynamiczny transfer obciążenia (Longitudinal & Lateral Weight Transfer):
Model nie traktuje bolidu jako punktu materialnego, lecz uwzględnia dynamiczny transfer masy wynikający z wysokości środka ciężkości ($h_{\text{CoG}} = 0.32\,\text{m}$), bazy kół ($L = 3.6\,\text{m}$) oraz rozstawu kół ($W = 1.8\,\text{m}$):
- **Hamowanie (Pitch dive):**
  $$\Delta F_{z,\text{pitch}} = m \cdot (-a_x) \cdot \frac{h_{\text{CoG}}}{L}$$
  Przednia oś jest dociążana (udział nacisku przodu wzrasta ze statycznych $46\%$ do ponad $65\%$), co zwiększa przyczepność przednich opon i pozwala na agresywne dohamowanie do zakrętu (trail braking).
- **Przyspieszanie (Squat):**
  Dociążenie tylnej osi zwiększa limit uciągu kół napędzanych ($F_{\text{rear,limit}} = \mu \cdot F_{z,\text{rear}}$).
- **Przechył w zakręcie (Body Roll):**
  $$\Delta F_{z,\text{roll}} = m \cdot a_y \cdot \frac{h_{\text{CoG}}}{W}$$
  Przeniesienie ciężaru na koła zewnętrzne generuje nieliniowy spadek sumarycznej przyczepności osi (tzw. tire load sensitivity), modelowany w kodzie jako współczynnik utraty przyczepności `rollGripLoss`.

#### 3. Elipsa tarcia Kamma (Kamm's Friction Circle):
W `Car.ts` (linie 628–638) zaimplementowano fundamentalne prawo dynamiki opon: siła wzdłużna (hamowanie/przyspieszanie) zmniejsza dostępny zasób siły poprzecznej (prowadzenia bocznego):
$$F_{y,\text{available}} = F_{y,\max} \cdot \sqrt{\max\left(0.05, \, 1 - \left(\frac{F_x}{F_{x,\max}}\right)^2\right)}$$
Jeżeli kierowca lub model AI zażąda $100\%$ siły hamowania w zakręcie, dostępna siła poprzeczna spada do minimum ($\approx 22\%$), co natychmiast prowadzi do zablokowania przednich kół i głębokiej podsterowności (understeer wash-out).

#### 4. Wpływ masy paliwa na osiągi (Fuel Mass Scaling):
Masa bolidu nie jest stała:
$$m(t) = m_{\text{dry}} (798\,\text{kg}) + m_{\text{fuel}}(t) \quad (m_{\text{fuel}} \in [0, 110]\,\text{kg})$$
Spalanie paliwa zależy od wciśnięcia pedału gazu oraz obciążenia silnika:
$$\dot{m}_{\text{fuel}} = 0.004 + 0.062 \cdot \text{throttle} \cdot \left(0.30 + 0.70 \frac{v}{95}\right) \quad \left[\frac{\text{kg}}{\text{s}}\right]$$
Spadek masy bolidu o $100\,\text{kg}$ w trakcie wyścigu skraca drogę hamowania, podnosi przyspieszenia wzdłużne i pozwala na osiąganie wyższych czasów okrążeń pod koniec stintu, co odpowiada rzeczywistym zjawiskom w Grand Prix F1.

### 4.3. Kompromisy inżynieryjne na rzecz środowiska przeglądarkowego

Aby utrzymać stabilne 60 klatek na sekundę dla 10 uczących się bolidów w jednowątkowym środowisku Web Workera, autorzy symulatora świadomie pominęli kilka złożonych modeli obliczeniowych:

#### 1. Brak pełnego modelu Pacejki (Pacejka Magic Formula 5.2 / 6.1) i kąta znoszenia (Slip Angle):
W Assetto Corsa i rFactor 2 siła boczna opony jest nieliniową funkcją kąta znoszenia koła $\alpha$:
$$F_y(\alpha) = D \sin\left(C \arctan\left(B \alpha - E (B \alpha - \arctan(B \alpha))\right)\right)$$
Wymaga to całkowania równań ruchu obrotowego koła wokół własnej osi, znajomości prędkości kątowej każdego z czterech kół $\omega_{\text{wheel}}$ oraz całkowania poślizgu wzdłużnego $\kappa = (\omega r - v)/v$.
- **W F1 AI Simulator:** Zastosowano model kinematyczno-kinetyczny. Poślizg jest stanem progowym, obliczanym z relacji siły odśrodkowej do maksymalnej siły poprzecznej Kamma ($F_{\text{cf}} > F_{\text{lat,total}}$). Jeśli siła odśrodkowa przekracza limit, yaw rate pojazdu jest skalowany w dół (`actualYawRate = idealYawRate * gripRatio`), a prędkość wzdłużna jest tłumiona przez tarcie ślizgowe (`newForwardSpeed *= (1.0 - 0.09 * dt)`). Jest to rozwiązanie rzędy wielkości szybsze obliczeniowo, dające jednak zbliżone wizualnie i behawioralnie efekty poślizgu.

#### 2. Uproszczona transmisja napędu (CVT / Electric Model vs 8-biegowa skrzynia F1):
W rzeczywistym bolidzie F1 kierowca operuje 8-biegową przekładnią sekwencyjną, a moment obrotowy na kołach zmienia się skokowo w zależności od obrotów silnika V6 Turbo ($15\,000\,\text{RPM}$) i przełożenia biegu.
- **W F1 AI Simulator:** Zastosowano ciągły model mocy silnika elektrycznego/CVT:
  $$F_{\text{drive}} = \frac{P_{\max} \cdot \text{throttle}}{\max(12.0, \, v)}$$
  Zabezpieczenie $\max(12.0, v)$ zapobiega dążeniu siły do nieskończoności przy $v \to 0$ (co odpowiada ograniczeniu momentu obrotowego na 1. biegu i ograniczeniu przyczepności opon). Eliminuje to konieczność modelowania sprzęgła, synchronizatorów i logiki automatycznej zmiany biegów w AI.

#### 3. Model 2D Bicycle Model zamiast pełnego zawieszenia 3D:
- W rFactor 2 ugięcie sprężyn i amortyzatorów jest liczone niezależnie dla każdego narożnika pojazdu w przestrzeni 3D z uwzględnieniem geometrii wahaczy poprzecznych i podłużnych.
- W F1 AI Simulator bolid porusza się w płaszczyźnie 2D ($x, y, \theta$). Kąty pochylenia nadwozia (`pitchAngle`, `rollAngle`) są wyznaczane quasi-statycznie z chwilowych przyspieszeń ($a_x, a_y$) wyłącznie do celów telemetrycznych i animacji na ekranie, bez dynamicznego sprzężenia zwrotnego z ugięciem opon.

### 4.4. Analiza budżetu pamięci i ograniczeń silnika JavaScript V8

Dlaczego symulator w przeglądarce musi stosować takie uproszczenia? Zbadajmy ograniczenia środowiska wykonawczego:

1. **Koszt Garbage Collection (Zarządzanie Pamięcią):**
   W C++ (rFactor 2) pamięć na obiekty kół, zawieszenia i wektory jest alokowana raz na stosie lub w ciągłych blokach pamięci (`std::vector`). W JavaScript tworzenie nowych instancji obiektów (np. `new Vector2()`) w pętli 60 Hz dla 10 bolidów powoduje szybkie zapełnianie pamięci młodej generacji (Young Generation / Nursery) w stercie V8. Skutkuje to cyklicznym uruchamianiem GC Scavenger, co powoduje mikroprzycięcia (frame drops).
   *W projekcie F1 AI Simulator widać dużą dbałość o optymalizację:* metody takie jak `addMut()`, `mulMut()` w `Vector2.ts` oraz cache `queryId` w `Track.ts` minimalizują alokację pamięci w gorącej pętli.

2. **JIT Compilation i Monomorfizm:**
   Struktury danych bolidu (`SerializedCar`, `Car`) posiadają stabilne kształty obiektów (Hidden Classes / Maps w V8), co pozwala kompilatorowi TurboFan na generowanie zoptymalizowanego kodu maszynowego bez deoptymalizacji (deopt bailout).

---

## 5. Wnioski i Rekomendacje Rozwojowe

Projekt **F1 AI Simulator** reprezentuje znakomicie zaprojektowany inżynieryjny kompromis pomiędzy akademicką wiernością dynamiki pojazdu a rygorystycznymi ograniczeniami wydajnościowymi środowiska Web/V8. 

### Kluczowe atuty obecnej implementacji:
1. **Semi-Implicit Euler** zapewnia stabilność i symplektyczne zachowanie energii bez narzutu obliczeniowego metod wyższego rzędu.
2. **Uniform Spatial Grid $O(1)$** z bitowym haszowaniem SMI i filtrowaniem Query ID rozwiązuje wąskie gardło raycastingu LiDAR, umożliwiając symulację 10 bolidów (250 promieni na krok) przy minimalnym obciążeniu CPU.
3. Połączenie **docisku aerodynamicznego $v^2$**, **dynamicznego transferu masy** i **koła tarcia Kamma** tworzy model fizyczny o zaskakująco realistycznym zachowaniu (trail braking, utrata przyczepności przy przyspieszaniu na wyjściu z zakrętu, docisk w szybkich łukach).

### Rekomendowane kierunki dalszego rozwoju (Roadmap):
1. **Wprowadzenie uproszczonego modelu termiki opon (Thermal Window):**
   Wystarczy prosty model dyskretny 1. rzędu dla temperatury powierzchni opony:
   $$T_{n+1} = T_n + \left(k_{\text{heat}} \cdot F_{\text{friction}} \cdot v_{\text{slip}} - k_{\text{cool}} \cdot (T_n - T_{\text{ambient}})\right) \Delta t$$
   gdzie współczynnik przyczepności $\mu(T)$ osiąga optimum w zakresie $90\text{--}105^\circ\text{C}$. Wzbogaciłoby to strategię wyścigową o zarządzanie oponami (tyre management).
2. **Sub-stepping w fazie ostrego hamowania (Adaptive Sub-stepping):**
   Gdy opóźnienie $|a_x| > 3.5\,G$, krok $\Delta t = 1/60\,\text{s}$ mógłby być dzielony na 2 podkroki po $1/120\,\text{s}$ wyłącznie wewnątrz `Car.updatePhysics`, co jeszcze bardziej podniosłoby precyzję progową bez obciążania całego workera.
3. **Pojedyncza warstwa poślizgu Pacejki (Simplified Pacejka Curve):**
   Zastąpienie progowego odcięcia siły poprzecznej znormalizowaną krzywą $F_y = D \sin(C \arctan(B \alpha))$, co pozwoliłoby bolidom AI na jazdę "na krawędzi przyczepności" z kontrolowanym mikro-poślizgiem (slip angle $4\text{--}8^\circ$), tak jak czynią to zawodowi kierowcy Formuły 1.
