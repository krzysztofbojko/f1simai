# 🏎️ Architektura Zaawansowanego Modelu Opon i Termodynamiki (F1 AI Simulator)
## Model Pacejka 'Magic Formula' (MF 5.2) oraz Dwuwarstwowy Model Termiczny

> **Dokument techniczno-inżynieryjny**: Propozycja rozbudowy fizyki pojazdu w projekcie **F1 AI Simulator**  
> **Lokalizacja docelowa**: [`/Users/krzysztofbojko/f1simai/`](file:///Users/krzysztofbojko/f1simai/)  
> **Odnośniki bazowe**: [`src/physics/Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts), [`src/workers/sim.worker.ts`](file:///Users/krzysztofbojko/f1simai/src/workers/sim.worker.ts), [`opis.md`](file:///Users/krzysztofbojko/f1simai/opis.md)  
> **Status**: Gotowa specyfikacja implementacyjna z kodem TypeScript zoptymalizowanym pod Web Worker (Zero GC Allocations)

---

## Spis Treści
1. [Wprowadzenie i Diagnoza Obecnych Uproszczeń](#1-wprowadzenie-i-diagnoza-obecnych-uproszczeń)
2. [Część I: Analityczny Model Pacejka 'Magic Formula' (MF 5.2)](#2-część-i-analityczny-model-pacejka-magic-formula-mf-52)
   - [2.1 Kinematyka Kąta Poślizgu ($\alpha$) i Poślizgu Wzdłużnego ($\kappa$)](#21-kinematyka-kąta-poślizgu-alpha-i-poślizgu-wzdłużnego-kappa)
   - [2.2 Równanie Bazowe Magic Formula i Parametryzacja F1](#22-równanie-bazowe-magic-formula-i-parametryzacja-f1)
   - [2.3 Czułość na Nacisk Pionowy (Load Sensitivity $D(F_z)$)](#23-czułość-na-nacisk-pionowy-load-sensitivity-df_z)
   - [2.4 Sprzężenie Wzdłużno-Poprzeczne (Combined Slip)](#24-sprzężenie-wzdłużno-poprzeczne-combined-slip)
3. [Część II: Dwuwarstwowy Model Termiczny Opon (Dual-Layer Thermal Model)](#3-część-ii-dwuwarstwowy-model-termiczny-opon-dual-layer-thermal-model)
   - [3.1 Struktura Termiczna: Bieżnik ($T_{surface}$) i Osnowa ($T_{core}$)](#31-struktura-termiczna-bieżnik-t_surface-i-osnowa-t_core)
   - [3.2 Równania Różniczkowe Bilansu Ciepła](#32-równania-różniczkowe-bilansu-ciepła)
   - [3.3 Okno Termiczne F1 (90–110°C) i Funkcja Mnożnika Przyczepności $\mu(T)$](#33-okno-termiczne-f1-90110c-i-funkcja-mnożnika-przyczepności-mut)
   - [3.4 Mechaniczne Zużycie Bieżnika i Degradacja Odwracalna/Nieodwracalna](#34-mechaniczne-zużycie-bieżnika-i-degradacja-odwracalnanieodwracalna)
4. [Część III: Architektura Kodu TypeScript Zoptymalizowana pod Web Worker](#4-część-iii-architektura-kodu-typescript-zoptymalizowana-pod-web-worker)
   - [4.1 Paradygmat Zero-Allocation per Tick ($O(1)$ Garbage Collection)](#41-paradygmat-zero-allocation-per-tick-o1-garbage-collection)
   - [4.2 Struktury Danych i Płaski Bufor `Float64Array`](#42-struktury-danych-i-płaski-bufor-float64array)
   - [4.3 Kompletna Implementacja Modułu `TireModel.ts`](#43-kompletna-implementacja-modułu-tiremodelts)
   - [4.4 Integracja z Klasą `Car.ts` i Pętlą Fizyki](#44-integracja-z-klasą-carts-i-pętlą-fizyki)
5. [Część IV: Wpływ na Autonomicznego Kierowcę AI (MLP & Strategia)](#5-część-iv-wpływ-na-autonomicznego-kierowcę-ai-mlp--strategia)
6. [Podsumowanie i Harmonogram Wdrożenia](#6-podsumowanie-i-harmonogram-wdrożenia)

---

## 1. Wprowadzenie i Diagnoza Obecnych Uproszczeń

Aktualna implementacja w [`src/physics/Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts) zawiera zaawansowane elementy mechaniki pojazdu (docisk $v^2$, transfer masy pitch/roll, elipsę Kamma), jednak w obszarze kontaktu opony z nawierzchnią opiera się na **trzech istotnych uproszczeniach**:

1. **Brak analitycznego kąta poślizgu ($\alpha$) i poślizgu wzdłużnego ($\kappa$)**:
   Obecnie w kodzie (linie 614–615 i 648–654) skręt realizowany jest poprzez geometryczną prędkość kątową Ackermanna:
   $$\omega_{ideal} = \frac{v_{forward}}{L} \cdot \tan(\delta)$$
   Jeśli siła odśrodkowa przekroczy limit przyczepności, prędkość obrotu jest sztucznie skalowana współczynnikiem $\text{gripRatio}$. W rzeczywistym bolidzie siła poprzeczna $F_y$ nie wynika z geometrii, lecz **wyłącznie ze zjawiska uślizgu kątowego opony** ($\alpha = \text{kąt pomiędzy płaszczyzną koła a wektorem jego prędkości}$).
2. **Kwadratowe odcięcie Kamma zamiast nieliniowej krzywej szczytowej (Peak Grip Curve)**:
   Prawdziwa opona F1 wykazuje wyraźne maksimum przy kącie $\alpha_{peak} \approx 6^\circ\text{--}9^\circ$. Przed szczytem zachowuje się quasi-liniowo, a po przekroczeniu szczytu siła poprzeczna **spada o 15–25%**, wywołując gwałtowną podsterowność lub nadsterowność. Obecny model nie odwzorowuje tego spadku – opona po prostu „ślizga się” bez nieliniowej utraty nośności.
3. **Całkowity brak termodynamiki opon**:
   W prawdziwym bolidzie slick opona zimna ($< 70^\circ\text{C}$) traci ponad $25\%$ przyczepności (jest twarda i śliska). W oknie $90^\circ\text{C}\text{--}110^\circ\text{C}$ klei idealnie, a powyżej $125^\circ\text{C}$ ulega przegrzaniu (*graining/blistering*). Brak termiki uniemożliwia symulację zarządzania oponami (*tire management*), dogrzewania hamulcami czy strategii podcięć w pit-stopach (*undercut*).

Poniższa architektura eliminuje te ograniczenia, wprowadzając zoptymalizowany numerycznie model **Pacejka MF 5.2** zintegrowany z **dwuwarstwową termodynamiką opon** bez jakiegokolwiek narzutu alokacji pamięci na wątku Web Workera.

---

## 2. Część I: Analityczny Model Pacejka 'Magic Formula' (MF 5.2)

### 2.1 Kinematyka Kąta Poślizgu ($\alpha$) i Poślizgu Wzdłużnego ($\kappa$)

W modelu 4-kołowym (lub uproszczonym modelu rowerowym / 2-osiowym) wyznaczamy lokalne wektory prędkości w środkach powierzchni styku opon z uwzględnieniem obrotu bolidu wokół osi pionowej z prędkością kątową $\omega = \frac{d\theta}{dt}$.

```
                 ▲ v_forward
                 │
           ┌─────┴─────┐
      FL   │  [δ]      │   FR [δ]      Oś Przednia (odległość a od CoG)
      ───► │     ▲     │ ◄───
           │     │ a   │
           │     ▼     │
           │   (CoG)   │ ◄────────── Środek Ciężkości
           │     ▲     │
           │     │ b   │
      RL   │     ▼     │   RR          Oś Tylna (odległość b od CoG)
      ───► │  [0]      │ ◄───
           └─────┬─────┘
                 │
           ◄─────┴─────► W = 1.80 m (Rozstaw kół)
```

Dla rozstawu osi $L = 3.60\text{ m}$ i statycznego rozkładu mas $46\%/54\%$:
- Odległość od CoG do osi przedniej: $a = L \cdot 0.54 = 1.944\text{ m}$
- Odległość od CoG do osi tylnej: $b = L \cdot 0.46 = 1.656\text{ m}$

#### Kąt poślizgu opony (Slip Angle $\alpha$):
Dla osi przedniej (z kątem skrętu kół $\delta$):
$$v_{x,front} = v_{forward}$$
$$v_{y,front} = v_{lateral} + a \cdot \omega$$
$$\alpha_{front} = \delta - \arctan\left(\frac{v_{y,front}}{\max(1.0, |v_{x,front}|)}\right)$$

Dla osi tylnej (koła nieskrętne, $\delta = 0$):
$$v_{x,rear} = v_{forward}$$
$$v_{y,rear} = v_{lateral} - b \cdot \omega$$
$$\alpha_{rear} = -\arctan\left(\frac{v_{y,rear}}{\max(1.0, |v_{x,rear}|)}\right)$$

#### Wzdłużny poślizg opony (Slip Ratio $\kappa$):
Poślizg wzdłużny określa różnicę pomiędzy prędkością obrotową koła $v_{wheel} = \omega_{wheel} \cdot R_w$ a rzeczywistą prędkością wzdłużną pojazdu $v_{x}$:
$$\kappa = \frac{\omega_{wheel} \cdot R_w - v_{x}}{\max(1.0, |v_{x}|)}$$
- $\kappa = 0$: swobodne toczenie bez poślizgu,
- $\kappa > 0$: poślizg napędowy (przyspieszanie, *wheelspin*),
- $\kappa < 0$: poślizg hamujący ($\kappa = -1.0$ oznacza pełne zablokowanie koła, *lock-up*).

---

### 2.2 Równanie Bazowe Magic Formula i Parametryzacja F1

Zgodnie z modelem Hansa B. Pacejki (MF 5.2), siła generowana przez oponę w czystym poślizgu (pure slip) opisana jest funkcją trygonometryczną:

$$y(x) = D \cdot \sin\left( C \cdot \arctan\left( B \cdot x - E \cdot \left( B \cdot x - \arctan(B \cdot x) \right) \right) \right)$$

Gdzie:
- $x$ – zmienna poślizgu ($\alpha$ dla siły bocznej, $\kappa$ dla siły wzdłużnej),
- $y$ – generowana siła ($F_y$ lub $F_x$),
- **$D$ (Peak Factor)**: maksymalna osiągalna siła przyczepności,
- **$C$ (Shape Factor)**: współczynnik kształtu krzywej (determinuje asymptotę przy $x \to \infty$),
- **$B$ (Stiffness Factor)**: współczynnik sztywności; iloczyn $B \cdot C \cdot D = C_{\alpha}$ definiuje początkową sztywność narożną (pochodną w zerze $\left.\frac{dy}{dx}\right|_{x=0}$),
- **$E$ (Curvature Factor)**: współczynnik krzywizny wierzchołka i stromości opadania po przekroczeniu optimum.

```
 Siła boczna Fy [N]
   ▲
 D │                 Szczyt (Peak Slip Angle α_peak ~ 7.5°)
   │                  ┌───┐
   │                ┌─┘   └─┐
   │              ┌─┘       └───┐ Asymptota tarcia ślizgowego (78% D)
   │             ┌┘             └───────────────────────────►
   │           ┌─┘
   │          ┌┘  Strefa liniowa (Cornering Stiffness B*C*D)
   │         ┌┘
 0 └─────────┴──────────────────────────────────────────────► Kąt poślizgu α [rad]
             0                α_peak                        0.35 rad (~20°)
```

#### Kalibracja Współczynników dla Mieszanki F1 Slick (C3 Medium):

| Parametr | Siła Boczna $F_y(\alpha)$ | Siła Wzdłużna $F_x(\kappa)$ | Fizyczne Znaczenie w F1 |
| :--- | :---: | :---: | :--- |
| **$C$ (Shape)** | `1.35` | `1.65` | Opona F1 ma bardziej agresywne wejście w poślizg wzdłużny niż boczny |
| **$\alpha_{peak} / \kappa_{peak}$** | `0.130 rad` ($\approx 7.45^\circ$) | `0.115` ($11.5\%$) | Punkt maksymalnej przyczepności przed zerwaniem |
| **$B$ (Stiffness)** | $\frac{1.0}{\alpha_{peak} \cdot C} \approx 5.698$ | $\frac{1.0}{\kappa_{peak} \cdot C} \approx 5.270$ | Zapewnia precyzyjne ulokowanie maksimum w żądanym punkcie |
| **$E$ (Curvature)** | `-0.85` | `-0.65` | Ujemna wartość wywołuje realistyczny spadek siły za szczytem o $\sim 22\%$ |
| **Asymptota ($x \to \infty$)** | $D \cdot \sin(C \cdot \frac{\pi}{2}) \approx 0.85 \cdot D$ | $D \cdot \sin(C \cdot \frac{\pi}{2}) \approx 0.78 \cdot D$ | Siła tarcia kinetycznego po całkowitym zerwaniu |

---

### 2.3 Czułość na Nacisk Pionowy (Load Sensitivity $D(F_z)$)

Współczynnik tarcia opony nie jest stały – spada wraz ze wzrostem obciążenia normalnego $F_z$. W modelu Pacejki siła szczytowa $D$ jest degressywną funkcją $F_z$:

$$D(F_z, T) = \mu_{eff}(T) \cdot F_z \cdot \left( 1.0 - k_{sens} \cdot \frac{F_z - F_{z0}}{F_{z0}} \right)$$

Gdzie:
- $F_{z0} = 4\ 500\text{ N}$ – nominalny nacisk statyczny przypadający na koło bolidu,
- $k_{sens} = 0.12$ – współczynnik czułości na obciążenie (przy podwojeniu obciążenia współczynnik tarcia spada o $12\%$).
- $\mu_{eff}(T)$ – współczynnik tarcia modyfikowany temperaturą opony (sekcja 3.3).

Dzięki temu dynamiczny transfer masy (zarówno wzdłużny $pitch$, jak i poprzeczny $roll$) automatycznie powoduje naturalną stratę sumarycznej przyczepności osi bez potrzeby stosowania heurystycznych sztuczek!

---

### 2.4 Sprzężenie Wzdłużno-Poprzeczne (Combined Slip)

Gdy opona jednocześnie hamuje i skręca, wektor poślizgu całkowitego wynosi:
$$\sigma = \sqrt{\left(\frac{\kappa}{\kappa_{peak}}\right)^2 + \left(\frac{\alpha}{\alpha_{peak}}\right)^2}$$

Zamiast gwałtownego ucinania sił, stosujemy analityczne wagi redukcyjne $G_{xa}$ i $G_{yk}$:

$$F_x = F_{x0}(\kappa, F_z) \cdot \frac{\frac{\kappa}{\kappa_{peak}}}{\max(1.0, \sigma)}$$
$$F_y = F_{y0}(\alpha, F_z) \cdot \frac{\frac{\alpha}{\alpha_{peak}}}{\max(1.0, \sigma)}$$

Gdzie $F_{x0}$ i $F_{y0}$ to siły obliczone z czystych równań Pacejki. Dla $\sigma \le 1.0$ opona pracuje wewnątrz elipsy Kamma; dla $\sigma > 1.0$ siły są płynnie normalizowane do krawędzi elipsy, zachowując idealną gładkość różniczkowalną $C^1$.

---

## 3. Część II: Dwuwarstwowy Model Termiczny Opon (Dual-Layer Thermal Model)

### 3.1 Struktura Termiczna: Bieżnik ($T_{surface}$) i Osnowa ($T_{core}$)

W bolidzie Formuły 1 opona zachowuje się termicznie jak układ dwukomponentowy:
1. **Warstwa Powierzchniowa / Bieżnik ($T_{surface}$)**:
   - Grubość: $\sim 2\text{--}3\text{ mm}$ gumy stykającej się bezpośrednio z asfaltem.
   - Bardzo mała pojemność cieplna ($C_{surf} \approx 1\ 200\text{ J/K}$).
   - Błyskawiczna reakcja: potrafi rozgrzać się o $+40^\circ\text{C}$ w ułamku sekundy podczas zblokowania kół lub uślizgu, i natychmiast ostygnąć na prostej.
2. **Osnowa / Rdzeń Opony ($T_{core}$)**:
   - Karkas ze splotu aramidowo-stalowego i gruba warstwa wewnętrzna.
   - Duża pojemność cieplna ($C_{core} \approx 14\ 000\text{ J/K}$).
   - Wolna dynamika (stała czasowa rzędu 8–15 sekund): magazynuje ciepło, determinuje ciśnienie w oponie i długoterminową degradację.

```
                             Powietrze Napływające (Konwekcja Q_conv)
                                              ▲
                                              │
    ┌─────────────────────────────────────────┴─────────────────────────────────────────┐
    │  BIEŻNIK / POWIERZCHNIA (T_surface)                                               │
    │  Generowanie: Tarcie uślizgu Q_fric                                               │
    └─────────────────────────────────────────┬─────────────────────────────────────────┘
                                              │ Przewodzenie wewnętrzne Q_cond
                                              ▼
    ┌───────────────────────────────────────────────────────────────────────────────────┐
    │  OSNOWA / RDZEŃ (T_core)                                                          │
    │  Generowanie: Histereza deformacji Q_def, Chłodzenie przez felgę                  │
    └───────────────────────────────────────────────────────────────────────────────────┘
                                              │
                                              ▼
                                Asfalt (Przewodzenie Q_track)
```

---

### 3.2 Równania Różniczkowe Bilansu Ciepła

Układ dwóch równań różniczkowych zwyczajnych (ODE) rozwiązujemy numerycznie metodą Eulera w każdym kroku $\Delta t$:

$$\frac{d T_{surface}}{dt} = \frac{1}{C_{surf}} \cdot \left( \dot{Q}_{fric} - \dot{Q}_{cond} - \dot{Q}_{conv} - \dot{Q}_{track} \right)$$
$$\frac{d T_{core}}{dt} = \frac{1}{C_{core}} \cdot \left( \dot{Q}_{def} + \dot{Q}_{cond} - \dot{Q}_{rim} \right)$$

#### Strumienie ciepła ($\text{W} = \text{J/s}$):

1. **Ciepło tarcia uślizgu ($\dot{Q}_{fric}$)**:
   Moc wydzielana przez tarcie w płaszczyźnie styku opony:
   $$\dot{Q}_{fric} = |F_x \cdot v_{slip,x}| + |F_y \cdot v_{slip,y}|$$
   gdzie $v_{slip,x} = \kappa \cdot v_x$, a $v_{slip,y} = v_x \cdot \tan(\alpha)$.
2. **Ciepło deformacji karkasu ($\dot{Q}_{def}$)**:
   Straty histerezowe gumy podczas ciągłego uginania się opony pod naciskiem $F_z$:
   $$\dot{Q}_{def} = C_{hyst} \cdot F_z \cdot v$$
   ($C_{hyst} \approx 0.008\text{ J/(N}\cdot\text{m)}$).
3. **Wewnętrzne przewodzenie ciepła ($\dot{Q}_{cond}$)**:
   Transfer ciepła pomiędzy gorącym bieżnikiem a rdzeniem:
   $$\dot{Q}_{cond} = K_{cond} \cdot (T_{surface} - T_{core})$$
   ($K_{cond} \approx 45.0\text{ W/K}$).
4. **Chłodzenie konwekcyjne pędem powietrza ($\dot{Q}_{conv}$)**:
   Współczynnik wnikania ciepła rośnie z prędkością bolidu $v^{0.8}$:
   $$h_{conv}(v) = h_0 + h_1 \cdot v^{0.8} \quad (h_0 = 15.0, \ h_1 = 3.2)$$
   $$\dot{Q}_{conv} = h_{conv}(v) \cdot (T_{surface} - T_{ambient})$$
5. **Wymiana ciepła z torem ($\dot{Q}_{track}$)**:
   $$\dot{Q}_{track} = K_{track} \cdot (T_{surface} - T_{track}) \quad (K_{track} \approx 35.0\text{ W/K})$$

---

### 3.3 Okno Termiczne F1 (90–110°C) i Funkcja Mnożnika Przyczepności $\mu(T)$

Przyczepność mieszanki gumowej zależy nieliniowo od temperatury bieżnika $T_{surface}$. Wprowadzamy asymetryczną funkcję dzwonową (*Asymmetric Gaussian Grip Curve*):

```
 Współczynnik przyczepności μ(T)
   ▲
1.0│                   Okno optymalne (90°C - 110°C)
   │                   ┌──────────────┐
   │                  /                \
0.8│                 /                  \   Przegrzanie / Graining (>120°C)
   │   Zimna opona  /                    \
   │   (< 75°C)    /                      \──── Blistering (>140°C)
0.6│──────────────┘                        \────────────────►
 0 └──────────────┬───────────────────┬─────────────────────► Temperatura [°C]
                 70°C                100°C                 140°C
```

Analityczny wzór mnożnika termicznego $\mu_{thermal}(T) \in [0.65, 1.00]$:

$$\mu_{thermal}(T) = \begin{cases} 
0.72 + 0.28 \cdot \exp\left( -\frac{(T - 100.0)^2}{2 \cdot 18.0^2} \right) & \text{dla } T < 100.0^\circ\text{C} \\
0.65 + 0.35 \cdot \exp\left( -\frac{(T - 100.0)^2}{2 \cdot 22.0^2} \right) & \text{dla } T \ge 100.0^\circ\text{C} 
\end{cases}$$

- **$T = 60^\circ\text{C}$ (wyjazd z boksu)**: $\mu_{thermal} \approx 0.74$ (bolid jest podsterowny i śliski; kierowca musi dogrzewać opony wężykowaniem i ostrym dohamowywaniem).
- **$T = 100^\circ\text{C}$ (optimum)**: $\mu_{thermal} = 1.00$ (pełna przyczepność $\mu_{base} = 1.85$).
- **$T = 130^\circ\text{C}$ (przegrzanie)**: $\mu_{thermal} \approx 0.79$ (utrata $21\%$ przyczepności, „pływanie” bolidu w zakrętach).

---

### 3.4 Mechaniczne Zużycie Bieżnika i Degradacja Odwracalna/Nieodwracalna

Łączne zużycie opony składa się z dwóch składowych:
1. **Zużycie nieodwracalne (Wear $W \in [0.0, 1.0]$)**:
   Ścieranie mechaniczne bieżnika w funkcji pracy tarcia:
   $$\frac{dW}{dt} = k_{wear} \cdot \left( \frac{T_{surface}}{100.0} \right)^2 \cdot \dot{Q}_{fric}$$
   Gdy $W$ rośnie od $0.0$ (nowy slick) do $1.0$ (zużyty do karkasu), bazowa przyczepność spada o $25\%$:
   $$\mu_{wear}(W) = 1.0 - 0.25 \cdot W^{1.4}$$
2. **Degradacja termiczna odwracalna (Overheating)**:
   Ustępuje samoistnie po schłodzeniu opony na prostej (np. zjechanie z linii wyścigowej na czystą stronę toru).

---

## 4. Część III: Architektura Kodu TypeScript Zoptymalizowana pod Web Worker

### 4.1 Paradygmat Zero-Allocation per Tick ($O(1)$ Garbage Collection)

W wątku obliczeniowym [`sim.worker.ts`](file:///Users/krzysztofbojko/f1simai/src/workers/sim.worker.ts) pętla symulacji wykonuje setki kroków na klatkę przy trybach przyspieszonych (`performance` – 5 kroków, `turbo` – 50 kroków dla 10 bolidów jednocześnie = do **500 kroków fizyki na tick**).

> **Kluczowa zasada wydajności**: W metodzie `updatePhysics` ani w kalkulatorze opon **nie może powstać ani jeden obiekt tymczasowy** (`no new`, no closures, no array spreads, no object literals). Wszystkie struktury są prealokowane w pamięci podręcznej bolidu w postaci tablicy typowanej `Float64Array`.

---

### 4.2 Struktury Danych i Płaski Bufor `Float64Array`

Dla każdego bolidu tworzymy 4 narożniki opon (indeksy: `0: FL`, `1: FR`, `2: RL`, `3: RR`).
Stan termiczno-mechaniczny wszystkich 4 kół mieści się w jednym płaskim buforze `Float64Array(32)` (po 8 liczb float na oponę):

```
Offset per tire (strides of 8):
[0]: T_surface (°C)
[1]: T_core (°C)
[2]: Wear (0.0 to 1.0)
[3]: SlipAngle alpha (rad)
[4]: SlipRatio kappa (-1.0 to 1.0)
[5]: Force Fx (N)
[6]: Force Fy (N)
[7]: ThermalGripFactor mu_thermal (0.0 to 1.0)
```

---

### 4.3 Kompletna Implementacja Modułu `TireModel.ts`

Utwórzmy dedykowany, wysoce zoptymalizowany plik silnika opon [`src/physics/TireModel.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/TireModel.ts):

```ts
/**
 * TireModel.ts - Zaawansowany model opon F1: Pacejka MF 5.2 + Dwuwarstwowa Termodynamika
 * Zoptymalizowany pod Web Worker: Zero Garbage Collection Allocations!
 */

export const TIRE_FL = 0;
export const TIRE_FR = 1;
export const TIRE_RL = 2;
export const TIRE_RR = 3;

// Stride w buforze Float64Array per opona
export const TIRE_DATA_STRIDE = 8;
export const T_SURF_OFFSET = 0;
export const T_CORE_OFFSET = 1;
export const WEAR_OFFSET = 2;
export const ALPHA_OFFSET = 3;
export const KAPPA_OFFSET = 4;
export const FX_OFFSET = 5;
export const FY_OFFSET = 6;
export const MU_THERMAL_OFFSET = 7;

export interface PacejkaConfig {
  bLat: number; // Stiffness lateral
  cLat: number; // Shape lateral
  eLat: number; // Curvature lateral
  bLong: number; // Stiffness longitudinal
  cLong: number; // Shape longitudinal
  eLong: number; // Curvature longitudinal
  alphaPeak: number; // Peak slip angle (rad)
  kappaPeak: number; // Peak slip ratio
  loadSens: number;  // Load sensitivity factor
}

export const DEFAULT_F1_PACEJKA: PacejkaConfig = {
  bLat: 5.698,
  cLat: 1.35,
  eLat: -0.85,
  bLong: 5.270,
  cLong: 1.65,
  eLong: -0.65,
  alphaPeak: 0.130, // ~7.45 deg
  kappaPeak: 0.115, // 11.5% slip
  loadSens: 0.12
};

export class TireModel {
  // Pojemności cieplne i stałe przewodzenia
  private static readonly C_SURF: number = 1250.0; // J/K
  private static readonly C_CORE: number = 14200.0; // J/K
  private static readonly K_COND: number = 42.0;   // W/K
  private static readonly K_TRACK: number = 32.0;  // W/K
  private static readonly C_HYST: number = 0.0075; // J/(N*m)

  /**
   * Czysta funkcja Magic Formula Pacejka (bez alokacji pamięci)
   */
  public static evaluatePacejka(x: number, B: number, C: number, D: number, E: number): number {
    const Bx = B * x;
    const arcBx = Math.atan(Bx);
    return D * Math.sin(C * Math.atan(Bx - E * (Bx - arcBx)));
  }

  /**
   * Obliczenie mnożnika termicznego przyczepności mu(T)
   */
  public static evaluateThermalGrip(tempC: number): number {
    if (tempC < 100.0) {
      const dt = tempC - 100.0;
      return 0.72 + 0.28 * Math.exp(-(dt * dt) / (2.0 * 18.0 * 18.0));
    } else {
      const dt = tempC - 100.0;
      return 0.65 + 0.35 * Math.exp(-(dt * dt) / (2.0 * 22.0 * 22.0));
    }
  }

  /**
   * Krok całkowania termiki i obliczenia sił dla pojedynczej opony
   * Zapisuje wyniki in-place do bufora carTireBuffer
   */
  public static updateTire(
    buffer: Float64Array,
    tireIndex: number,
    alpha: number,
    kappa: number,
    fz: number,
    speedMps: number,
    baseGrip: number,
    dt: number,
    ambientTempC: number = 25.0,
    trackTempC: number = 38.0,
    cfg: PacejkaConfig = DEFAULT_F1_PACEJKA
  ): void {
    const baseIdx = tireIndex * TIRE_DATA_STRIDE;

    let tSurf = buffer[baseIdx + T_SURF_OFFSET];
    let tCore = buffer[baseIdx + T_CORE_OFFSET];
    let wear = buffer[baseIdx + WEAR_OFFSET];

    // 1. Czułość na nacisk i mnożnik termiczny
    const fzNorm = Math.max(100.0, fz);
    const loadFactor = Math.max(0.70, 1.0 - cfg.loadSens * ((fzNorm - 4500.0) / 4500.0));
    const muTherm = TireModel.evaluateThermalGrip(tSurf);
    const wearFactor = 1.0 - 0.25 * Math.pow(wear, 1.4);

    const effMu = baseGrip * muTherm * loadFactor * wearFactor;
    const peakForce = effMu * fzNorm;

    // 2. Czyste siły Pacejka (Pure Slip)
    const fx0 = TireModel.evaluatePacejka(kappa, cfg.bLong, cfg.cLong, peakForce, cfg.eLong);
    const fy0 = TireModel.evaluatePacejka(alpha, cfg.bLat, cfg.cLat, peakForce, cfg.eLat);

    // 3. Combined Slip (Elipsa tarcia znormalizowana)
    const normKappa = kappa / cfg.kappaPeak;
    const normAlpha = alpha / cfg.alphaPeak;
    const sigma = Math.hypot(normKappa, normAlpha);

    let fx = fx0;
    let fy = fy0;
    if (sigma > 1.0) {
      fx = fx0 * (normKappa / sigma);
      fy = fy0 * (normAlpha / sigma);
    }

    // 4. Bilans termiczny (Termodynamika)
    // Prędkości poślizgu w m/s
    const vSlipX = Math.abs(kappa * speedMps);
    const vSlipY = Math.abs(speedMps * Math.tan(alpha));

    // Strumienie ciepła
    const qFric = Math.abs(fx * vSlipX) + Math.abs(fy * vSlipY);
    const qDef = TireModel.C_HYST * fzNorm * speedMps;
    const qCond = TireModel.K_COND * (tSurf - tCore);

    // Konwekcja z prędkością wiatru napływającego
    const hConv = 15.0 + 3.2 * Math.pow(Math.max(0, speedMps), 0.8);
    const qConv = hConv * (tSurf - ambientTempC);
    const qTrack = TireModel.K_TRACK * (tSurf - trackTempC);

    // Krok różniczkowy Eulera
    const dTSurf = ((qFric - qCond - qConv - qTrack) / TireModel.C_SURF) * dt;
    const dTCore = ((qDef + qCond - 10.0 * (tCore - ambientTempC)) / TireModel.C_CORE) * dt;

    tSurf = Math.max(ambientTempC, Math.min(180.0, tSurf + dTSurf));
    tCore = Math.max(ambientTempC, Math.min(150.0, tCore + dTCore));

    // Przyrost zużycia opony
    const wearRate = 0.00000008 * Math.pow(tSurf / 100.0, 2.0) * qFric * dt;
    wear = Math.min(1.0, wear + wearRate);

    // Zapis in-place do bufora
    buffer[baseIdx + T_SURF_OFFSET] = tSurf;
    buffer[baseIdx + T_CORE_OFFSET] = tCore;
    buffer[baseIdx + WEAR_OFFSET] = wear;
    buffer[baseIdx + ALPHA_OFFSET] = alpha;
    buffer[baseIdx + KAPPA_OFFSET] = kappa;
    buffer[baseIdx + FX_OFFSET] = fx;
    buffer[baseIdx + FY_OFFSET] = fy;
    buffer[baseIdx + MU_THERMAL_OFFSET] = muTherm;
  }
}
```

---

### 4.4 Integracja z Klasą `Car.ts` i Pętlą Fizyki

W klasie [`src/physics/Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts) dodajemy jedno prealokowane pole:

```ts
// src/physics/Car.ts
import { TireModel, TIRE_FL, TIRE_FR, TIRE_RL, TIRE_RR, TIRE_DATA_STRIDE, T_SURF_OFFSET, T_CORE_OFFSET, WEAR_OFFSET, FX_OFFSET, FY_OFFSET } from './TireModel';

export class Car {
  // Prealokowany bufor 4 kół x 8 liczb Float64 (Zero GC!)
  public tiresBuffer: Float64Array = new Float64Array(32);

  // Konstruktor - inicjalizacja temperaturami kocy grzewczych (Tire Warmers = 80°C)
  constructor(...) {
    this.initTires(85.0, 80.0);
  }

  public initTires(surfTempC: number = 85.0, coreTempC: number = 80.0): void {
    for (let i = 0; i < 4; i++) {
      const idx = i * TIRE_DATA_STRIDE;
      this.tiresBuffer[idx + T_SURF_OFFSET] = surfTempC;
      this.tiresBuffer[idx + T_CORE_OFFSET] = coreTempC;
      this.tiresBuffer[idx + WEAR_OFFSET] = 0.0;
    }
  }
```

W metodzie `updatePhysics(control, dt, track)`:
Zamiast obecnych uproszczonych formuł `idealYawRate`, wpinamy wyznaczenie sił opon:

```ts
  // 1. Geometria prędkości i kąty poślizgu
  const a = this.wheelbase * 0.54; // 1.944 m
  const b = this.wheelbase * 0.46; // 1.656 m
  const steerAngle = control.steer * this.maxSteerAngle;

  const vFrontY = lateralSpeed + a * this.angularVelocity;
  const vRearY = lateralSpeed - b * this.angularVelocity;
  const safeVx = Math.max(1.5, Math.abs(forwardSpeed));

  const alphaFront = steerAngle - Math.atan2(vFrontY, safeVx);
  const alphaRear = -Math.atan2(vRearY, safeVx);

  // 2. Poślizg wzdłużny kappa (wyznaczony z gazu/hamulca)
  let kappaFront = 0.0;
  if (control.brake > 0.01) {
    kappaFront = -Math.min(1.0, control.brake * 0.85);
  }

  let kappaRear = 0.0;
  if (control.brake > 0.01) {
    kappaRear = -Math.min(1.0, control.brake * 0.70);
  } else if (actualThrottle > 0.01) {
    // Trakcja silnika: poślizg napędowy
    kappaRear = Math.min(0.40, (actualThrottle * 0.15) * (30.0 / Math.max(5.0, this.speed)));
  }

  // 3. Rozkład nacisków na 4 koła (Pitch + Roll)
  const fzFL = normalLoadFront * 0.5;
  const fzFR = normalLoadFront * 0.5;
  const fzRL = normalLoadRear * 0.5;
  const fzRR = normalLoadRear * 0.5;

  // 4. Wywołanie silnika opon TireModel (Zero Allocations!)
  TireModel.updateTire(this.tiresBuffer, TIRE_FL, alphaFront, kappaFront, fzFL, this.speed, this.baseTireGrip, dt);
  TireModel.updateTire(this.tiresBuffer, TIRE_FR, alphaFront, kappaFront, fzFR, this.speed, this.baseTireGrip, dt);
  TireModel.updateTire(this.tiresBuffer, TIRE_RL, alphaRear, kappaRear, fzRL, this.speed, this.baseTireGrip, dt);
  TireModel.updateTire(this.tiresBuffer, TIRE_RR, alphaRear, kappaRear, fzRR, this.speed, this.baseTireGrip, dt);

  // 5. Pobranie zsumowanych sił z bufora
  const totalFyFront = this.tiresBuffer[TIRE_FL * TIRE_DATA_STRIDE + FY_OFFSET] + this.tiresBuffer[TIRE_FR * TIRE_DATA_STRIDE + FY_OFFSET];
  const totalFyRear = this.tiresBuffer[TIRE_RL * TIRE_DATA_STRIDE + FY_OFFSET] + this.tiresBuffer[TIRE_RR * TIRE_DATA_STRIDE + FY_OFFSET];
  const totalFx = this.tiresBuffer[TIRE_FL * TIRE_DATA_STRIDE + FX_OFFSET] + this.tiresBuffer[TIRE_FR * TIRE_DATA_STRIDE + FX_OFFSET] +
                  this.tiresBuffer[TIRE_RL * TIRE_DATA_STRIDE + FX_OFFSET] + this.tiresBuffer[TIRE_RR * TIRE_DATA_STRIDE + FX_OFFSET];

  // 6. Równania ruchu obrotowego (Moment kątowy Yaw)
  // Moment bezwładności bolidu wokół osi pionowej: Iz = m * (a * b)
  const Iz = currentMass * a * b; // ~2900 kg*m^2
  const yawTorque = (totalFyFront * a) - (totalFyRear * b);
  const yawAccel = yawTorque / Iz;

  this.angularVelocity += yawAccel * dt;
  this.heading += this.angularVelocity * dt;
```

---

## 5. Część IV: Wpływ na Autonomicznego Kierowcę AI (MLP & Strategia)

Wzbogacenie modelu fizyki o Pacejkę i termikę wnosi symulację na poziom profesjonalnych symulatorów wyścigowych klasy rFactor Pro czy Assetto Corsa. Jak wpłynie to na model sztucznej inteligencji [`NeuralNetwork.ts`](file:///Users/krzysztofbojko/f1simai/src/ai/NeuralNetwork.ts)?

```
 [Sensory LiDAR (25)] ──┐
 [Prędkość v / 95]   ──┤
 [Omega_yaw]          ──┤
 [Curvature / Delta]  ──┼──► [Sieć Neuronowa MLP] ──► [Kierownica (Steer)]
 [Śr. Temp Opon T_f]  ──┤     (18 ukryte -> 14)      ──► [Przepustnica (Throttle)]
 [Śr. Zużycie Wear]   ──┘                            ──► [Hamulec (Brake)]
```

1. **Wzbogacenie wektora wejściowego sieci (Inputs)**:
   Dodanie 2 nowych znormalizowanych wejść do sieci:
   - `avgTireTempNorm`: $\operatorname{clamp}(0.0, 1.0, \frac{T_{avg} - 60^\circ\text{C}}{80^\circ\text{C}})$,
   - `tireWearNorm`: $W_{avg} \in [0.0, 1.0]$.
2. **Samouczące się zachowania F1**:
   - **Tire Warming**: Na okrążeniu wyjazdowym (Out-Lap) sztuczna inteligencja szybko odkryje, że agresywne zygzakowanie i dohamowania rozgrzewają zimne opony ($65^\circ\text{C} \to 95^\circ\text{C}$), zapewniając natychmiastowy skok przyczepności o $+28\%$ na starcie okrążenia pomiarowego.
   - **Tire Management**: Zbyt agresywne wchodzenie w zakręty ze zbyt dużym kątem $\alpha$ (za szczytem Pacejki) drastycznie przegrzewa bieżnik ($>125^\circ\text{C}$) i ściera oponę. Algorytm genetyczny w naturalny sposób wyeliminuje kierowców niszczących gumy, nagradzając tych, którzy jadą płynnie w granicznym kącie $\alpha_{peak} \approx 7.5^\circ$.
   - **Strategia Pit-Stopów**: Bolid ze zużytymi oponami ($W > 0.70$) będzie tracił po 1.5–2.0 sekundy na okrążeniu, co wymusi na maszynie stanów wyścigu (`RaceState`) optymalne planowanie zjazdów do boksu po świeże komplety.

---

## 6. Podsumowanie i Harmonogram Wdrożenia

### Zestawienie Porównawcze: Model Aktualny vs Proponowany

| Cecha | Stan Aktualny (`Car.ts`) | Proponowany Model (`TireModel.ts`) |
| :--- | :--- | :--- |
| **Krzywa przyczepności bocznej** | Uproszczona elipsa Kamma ze sztucznym odcięciem | **Pacejka MF 5.2** z analitycznym szczytem przy $\alpha \approx 7.45^\circ$ |
| **Zachowanie za szczytem (Post-Peak)** | Płaskie tarcie | **Nieliniowy spadek o $\sim 22\%$** (realistyczny poślizg) |
| **Kąt poślizgu $\alpha$ i poślizg $\kappa$** | Brak jawnych obliczeń kinematycznych | **Precyzyjna kinematyka lokalna kół** z prędkością kątową $\omega$ |
| **Temperatura opon** | Brak ($0^\circ\text{C}$, stała przyczepność) | **2 warstwy (Bieżnik + Osnowa)** z bilansem ciepła, tarciem i konwekcją |
| **Okno pracy mieszanki** | Brak | **Optimum 90–110°C**; spadek przyczepności na zimno i przy przegrzaniu |
| **Zużycie opon (Tire Wear)** | Brak | **Ciągłe ścieranie $W(t)$**, degradacja stintu, strategia pit-stopów |
| **Zarządzanie pamięcią** | Okazjonalne alokacje obiektów | **Ścisłe $0$ alokacji (Zero-GC)** dzięki `Float64Array(32)` |

### Rekomendowany Plan Implementacji:
1. **Krok 1**: Utworzenie niezależnego modułu [`src/physics/TireModel.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/TireModel.ts) i testy jednostkowe krzywych Pacejki.
2. **Krok 2**: Dodanie bufora `tiresBuffer` do klasy [`Car`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts) i zastąpienie równania obrotu pełnym momentem sił $Yaw = (F_{y,f} \cdot a) - (F_{y,r} \cdot b)$.
3. **Krok 3**: Serializacja temperatur 4 kół w [`SerializedCar`](file:///Users/krzysztofbojko/f1simai/src/workers/sim.worker.ts#L83) i dodanie termicznego widżetu 4 kół (FL/FR/RL/RR) z paletą kolorów (Niebieski $\to$ Zielony $\to$ Czerwony) w Canvas UI (`Renderer.ts`).
4. **Krok 4**: Wpięcie znormalizowanej temperatury do wektora wejściowego sieci neuronowej.
