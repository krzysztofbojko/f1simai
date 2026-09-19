# 🏎️ Pełna Specyfikacja Techniczna Systemu F1 AI Simulator

Dokument stanowi wyczerpującą specyfikację inżynieryjną, matematyczną i architektoniczną projektu **F1 AI Simulator**. Zawiera pełny opis modeli fizycznych, równań różniczkowych, wag i topologii sieci neuronowych, algorytmów uczenia, struktur danych, protokołów komunikacji wątkowej oraz mechanizmów bezpieczeństwa numerycznego.

---

## 📑 Spis Treści
1. [Architektura Systemowa i Model Wielowątkowości](#1-architektura-systemowa-i-model-wielowątkowości)
2. [Specyfikacja Matematyczno-Fizyczna Pojazdu (Vehicle Dynamics 2D)](#2-specyfikacja-matematyczno-fizyczna-pojazdu-vehicle-dynamics-2d)
   - [2.1 Tabela Stałych i Parametrów Fizycznych](#21-tabela-stałych-i-parametrów-fizycznych)
   - [2.2 Równania Masowe i Dynamika Paliwa](#22-równania-masowe-i-dynamika-paliwa)
   - [2.3 Model Aerodynamiczny (Docisk i Opór Powietrza)](#23-model-aerodynamiczny-docisk-i-opór-powietrza)
   - [2.4 Dynamiczny Transfer Mas (Wzdłużny i Poprzeczny)](#24-dynamiczny-transfer-mas-wzdłużny-i-poprzeczny)
   - [2.5 Napęd, Hamowanie Carbon-Ceramic i Przeciążenia 5G](#25-napęd-hamowanie-carbon-ceramic-i-przeciążenia-5g)
   - [2.6 Model Przyczepności Opon, Koło Kamma i Uślizgi](#26-model-przyczepności-opon-koło-kamma-i-uślizgi)
3. [Specyfikacja Sztucznej Inteligencji i Sieci Neuronowych](#3-specyfikacja-sztucznej-inteligencji-i-sieci-neuronowych)
   - [3.1 Topologia Wielowarstwowego Perceptronu (MLP)](#31-topologia-wielowarstwowego-perceptronu-mlp)
   - [3.2 Wektor Wejściowy i Sensory LiDAR (Raycasting)](#32-wektor-wejściowy-i-sensory-lidar-raycasting)
   - [3.3 Warstwa Wyjściowa i Mapowanie Sygnałów Sterujących](#33-warstwa-wyjściowa-i-mapowanie-sygnałów-sterujących)
   - [3.4 Uczenie Online (Backpropagation & Replay Buffer)](#34-uczenie-online-backpropagation--replay-buffer)
   - [3.5 Algorytm Genetyczny, Selekcja i Simulated Annealing](#35-algorytm-genetyczny-selekcja-i-simulated-annealing)
4. [Polityka Sterowania i Autonomiczny Kierowca Wyścigowy](#4-polityka-sterowania-i-autonomiczny-kierowca-wyścigowy)
   - [4.1 Szacowanie Prędkości Dopuszczalnej i Stref Dohamowań](#41-szacowanie-prędkości-dopuszczalnej-i-stref-dohamowań)
   - [4.2 Polityka 100% Pełnego Gazu na Prostych i Wyjściach](#42-polityka-100-pełnego-gazu-na-prostych-i-wyjściach)
   - [4.3 Telemetry Coaching (Kooperacja z Liderem Sesji)](#43-telemetry-coaching-kooperacja-z-liderem-sesji)
   - [4.4 Performance Guard (Mechanizm Samonaprawczy Mózgów AI)](#44-performance-guard-mechanizm-samonaprawczy-mózgów-ai)
5. [Geometria Toru i Przyspieszenie Przestrzenne](#5-geometria-toru-i-przyspieszenie-przestrzenne)
   - [5.1 Interpolacja Krzywymi Składanymi Catmull-Rom](#51-interpolacja-krzywymi-składanymi-catmull-rom)
   - [5.2 Siatka Przestrzenna (Uniform Spatial Grid $O(1)$)](#52-siatka-przestrzenna-uniform-spatial-grid-o1)
   - [5.3 Sektory i Bramki Pomiarowe (TimingGates)](#53-sektory-i-bramki-pomiarowe-timinggates)
6. [Maszyna Stanów Wyścigu Grand Prix i Pit-Stopy](#6-maszyna-stanów-wyścigu-grand-prix-i-pit-stopy)
   - [7. Protokoły Komunikacyjne i Interfejs Danych (SimSnapshot)](#7-protokoły-komunikacyjne-i-interfejs-danych-simsnapshot)
8. [Podsumowanie Zaimplementowanych Poprawek Inżynieryjnych](#8-podsumowanie-zaimplementowanych-poprawek-inżynieryjnych)

---

## 1. Architektura Systemowa i Model Wielowątkowości

System opiera się na separacji wątku renderowania od wątku obliczeniowego:

```
[Główny Wątek Przeglądarki (UI Thread)]
 │
 ├── Pętla renderowania requestAnimationFrame (~60 FPS)
 ├── Renderer Canvas 2D (Renderer.ts)
 ├── Obsługa zdarzeń DOM i klawiatury gracza (main.ts)
 └── SimBridge (SimBridge.ts)
      │
      │ Web Worker postMessage (JSON / Structured Clone)
      ▼
[Wątek Obliczeniowy (sim.worker.ts)]
 ├── Pętla symulacji ze stałym krokiem czasowym dt = 1/60 s
 ├── Fizyka pojazdów 2D (Car.ts)
 ├── Sieci neuronowe i propagacja w przód (NeuralNetwork.ts)
 ├── Ewolucja i populacja 10 zespołów (Population.ts)
 └── Detekcja kolizji na siatce przestrzennej (Track.ts)
```

Zalety rozwiązania:
- Złożona inferencja 10 sieci neuronowych, raycasting (250 promieni na klatkę) oraz całkowanie fizyki nie powodują mikroprzycięć animacji.
- Możliwość przyspieszenia symulacji (1x, 2x, 5x, 10x, MAX) bez spadku płynności interfejsu.

---

## 2. Specyfikacja Matematyczno-Fizyczna Pojazdu (Vehicle Dynamics 2D)

### 2.1 Tabela Stałych i Parametrów Fizycznych

| Parametr | Symbol | Wartość w kodzie | Jednostka | Opis fizyczny |
| :--- | :--- | :--- | :--- | :--- |
| **Grawitacja** | $g$ | `9.81` | $\text{m/s}^2$ | Przyspieszenie ziemskie |
| **Masa sucha** | $m_{dry}$ | `798.0` | $\text{kg}$ | Masa bolidu bez paliwa (FIA F1) |
| **Maksymalne paliwo** | $M_{fuel}^{max}$ | `105.0` | $\text{kg}$ | Pojemność baku |
| **Moc maksymalna** | $P_{max}$ | `750000.0` | $\text{W}$ | $750\text{ kW} \approx 1020\text{ KM}$ |
| **Gęstość powietrza** | $\rho$ | `1.225` | $\text{kg/m}^3$ | Standardowa gęstość na poziomie morza |
| **Współczynnik oporu** | $C_D \cdot A$ | `0.70` | $\text{m}^2$ | Efektywna powierzchnia oporu aerodynamicznego |
| **Współczynnik docisku**| $C_L \cdot A$ | `3.20` | $\text{m}^2$ | Efektywny współczynnik docisku skrzydeł i dyfuzora |
| **Przyczepność opon** | $\mu_{base}$ | `1.70` | $-$ | Współczynnik tarcia miękkiej mieszanki slick |
| **Rozstaw osi** | $L$ | `3.60` | $\text{m}$ | Wheelbase bolidu F1 |
| **Rozstaw kół** | $W$ | `1.80` | $\text{m}$ | Szerokość osi |
| **Wysokość środka ciężkości** | $h_{CoG}$ | `0.32` | $\text{m}$ | Nisko położony środek masy bolidu F1 |
| **Maks. kąt skrętu** | $\delta_{max}$ | `0.40` | $\text{rad}$ | $\approx 22.9^\circ$ |
| **Opór toczenia** | $C_{rr}$ | `0.012` | $-$ | Opory toczenia opon |

---

### 2.2 Równania Masowe i Dynamika Paliwa

Całkowita masa bolidu w chwili $t$:
$$m(t) = m_{dry} + m_{fuel}(t)$$

Zużycie paliwa w czasie $\Delta t$:
$$\frac{dm_{fuel}}{dt} = \dot{m}_{base} + \dot{m}_{load} \cdot u_{throttle} \cdot \left(0.30 + 0.70 \cdot \frac{v}{95.0}\right)$$
gdzie:
- $\dot{m}_{base} = 0.004\text{ kg/s}$ (bieg jałowy / toczenie),
- $\dot{m}_{load} = 0.062\text{ kg/s}$ (spalanie przy pełnym obciążeniu silnika),
- $u_{throttle} \in [0.0, 1.0]$ to sygnał otwarcia przepustnicy.

Gdy $m_{fuel} \le 0.001\text{ kg}$, włącza się tryb awaryjny (*Limp Mode*): przepustnica zostaje ograniczona do $8\%$, pozwalając na powolne doczołganie się do boksu ($\sim 18\text{ km/h}$).

---

### 2.3 Model Aerodynamiczny (Docisk i Opór Powietrza)

1. **Siła oporu powietrza (Drag)**:
   $$F_{drag} = -\frac{1}{2} \cdot \rho \cdot (C_D \cdot A) \cdot k_{drag} \cdot v^2 \cdot \operatorname{sgn}(v_{forward})$$
   gdzie $k_{drag} \in [0.985, 1.015]$ to losowa fluktuacja osiągów bolidu w danej sesji.

2. **Docisk aerodynamiczny (Downforce)**:
   $$F_{downforce} = \frac{1}{2} \cdot \rho \cdot (C_L \cdot A) \cdot v^2$$
   Docisk rośnie z kwadratem prędkości. Przy $v = 111.1\text{ m/s}$ ($400\text{ km/h}$):
   $$F_{downforce} = \frac{1}{2} \cdot 1.225 \cdot 3.20 \cdot (111.1)^2 \approx 24\ 197\text{ N} \approx 2466\text{ kg docisku!}$$
   To ponad trzykrotność masy własnej bolidu!

3. **Całkowity nacisk pionowy na podłoże ($F_z$)**:
   $$F_z = m \cdot g + F_{downforce}$$

---

### 2.4 Dynamiczny Transfer Mas (Wzdłużny i Poprzeczny)

#### Transfer wzdłużny (Pitch – pochylenie nadwozia)
Statyczny rozkład mas wynosi $46\%$ na przód i $54\%$ na tył. Pod wpływem przyspieszenia wzdłużnego $a_x$:
$$\Delta F_{z,pitch} = m \cdot (-a_x) \cdot \frac{h_{CoG}}{L}$$
Naciski na osie wynoszą:
$$F_{z,front} = \max\left(100\text{ N}, 0.46 \cdot F_z + \Delta F_{z,pitch}\right)$$
$$F_{z,rear} = \max\left(100\text{ N}, 0.54 \cdot F_z - \Delta F_{z,pitch}\right)$$

#### Transfer poprzeczny (Roll – przechył boczny w zakręcie)
Pod wpływem przyspieszenia odśrodkowego $a_y$:
$$\Delta F_{z,roll} = m \cdot a_y \cdot \frac{h_{CoG}}{W}$$
Przeniesienie obciążenia na opony zewnętrzne powoduje stratę efektywnej przyczepności bocznej o wartość:
$$\Delta\mu_{roll} = \min\left(0.08, \frac{|\Delta F_{z,roll}|}{F_z} \cdot 0.15\right)$$

---

### 2.5 Napęd, Hamowanie Carbon-Ceramic i Przeciążenia 5G

#### Napęd na tylną oś (RWD)
Moc silnika przekłada się na siłę napędową:
$$F_{engine} = \frac{P_{max} \cdot u_{throttle} \cdot k_{power}}{\max(12.0, v_{forward})}$$
Maksymalna siła napędowa jest limitowana przyczepnością tylnej osi (trakcja):
$$F_{traction,max} = \mu_{base} \cdot k_{grip} \cdot F_{z,rear}$$
$$F_{drive} = \min\left(F_{traction,max}, F_{engine}\right)$$

#### Hamowanie Carbon-Ceramic z dociskiem aero
Balans hamulców wynosi $56\%$ przód, $44\%$ tył. Układ hamulcowy wykorzystuje agresywny docisk pionowy:
$$F_{brake,max} = u_{brake} \cdot \mu_{base} \cdot 1.60 \cdot (F_{z,front} + F_{z,rear})$$
Przy $400\text{ km/h}$ z dociskiem $24\text{ kN}$ opóźnienie hamowania osiąga:
$$a_x = \frac{F_{brake} + F_{drag}}{m} \approx \frac{42\ 000\text{ N}}{850\text{ kg}} \approx 49.4\text{ m/s}^2 \approx \mathbf{5.04\text{ G}!}$$
Pozwala to wyhamować bolid z $400\text{ km/h}$ do $120\text{ km/h}$ na odcinku zaledwie **110–120 metrów**.

---

### 2.6 Model Przyczepności Opon, Koło Kamma i Uślizgi

Wektor przyspieszenia w układzie pojazdu podlega ograniczeniu elipsy przyczepności Kamma (*Kamm's Friction Circle*):
$$\left(\frac{F_x}{F_{x,max}}\right)^2 + \left(\frac{F_y}{F_{y,max}}\right)^2 \le 1.0$$
- Jeśli kierowca wciska hamulec w zakręcie na $100\%$, siła boczna $F_y$ drastycznie spada, generując podsterowność (*lock-up*).
- Kąty poślizgu kół przednich ($\alpha_f$) i tylnych ($\alpha_r$) określają uślizg:
  $$\text{understeerSlip} = \max(0, |\alpha_f| - |\alpha_r|)$$
  $$\text{oversteerSlip} = \max(0, |\alpha_r| - |\alpha_f|)$$
- Gdy uślizg przekracza próg $0.35$, opony wchodzą w poślizg kinetyczny, generując dym i ślady spalonej gumy (*skid marks*).

---

## 3. Specyfikacja Sztucznej Inteligencji i Sieci Neuronowych

### 3.1 Topologia Wielowarstwowego Perceptronu (MLP)

Każdy bolid posiada w pełni połączoną sieć neuronową o strukturze:
$$\text{Wejście } (N_{inputs}) \longrightarrow \text{Ukryta 1 } (18) \longrightarrow \text{Ukryta 2 } (14) \longrightarrow \text{Wyjście } (3)$$
gdzie $N_{inputs} = N_{rays} + 5$. Przy domyślnej liczbie 25 promieni LiDAR, warstwa wejściowa liczy **30 neuronów**.

Wszystkie warstwy ukryte i wyjściowa używają funkcji aktywacji tangensa hiperbolicznego:
$$f(x) = \tanh(x) = \frac{e^x - e^{-x}}{e^x + e^{-x}}, \quad f'(x) = 1 - \tanh^2(x)$$

---

### 3.2 Wektor Wejściowy i Sensory LiDAR (Raycasting)

Wektor wejściowy składa się z 30 wartości znormalizowanych do zakresu $[-1.0, 1.0]$ lub $[0.0, 1.0]$:

```
Inputs = [
  r_0, r_1, ..., r_24,   // 25 odczytów promieni LiDAR (odległość / 240m)
  v_norm,                 // Znormalizowana prędkość: min(1.0, v / 95.0 m/s)
  omega_norm,             // Prędkość kątowa: clamp(-1.0, 1.0, omega * 1.5)
  cpAngleDiff,            // Kąt odchylenia wektora jazdy od osi toru [-1.0, 1.0]
  curvatureInput,         // Zbliżająca się krzywizna toru: min(1.0, maxK * 24.0)
  overspeedDelta          // Wskaźnik konieczności dohamowania [-1.0, 1.0]
]
```

Kąty promieni LiDAR pokrywają wachlarz od $-85^\circ$ do $+85^\circ$ względem osi wzdłużnej bolidu, ze szczególnym zagęszczeniem w strefie czołowej.

---

### 3.3 Warstwa Wyjściowa i Mapowanie Sygnałów Sterujących

Neurony wyjściowe generują sygnały w zakresie $[-1.0, 1.0]$:
1. **$y_0$ (Steering)**: Bezpośredni kąt skrętu kierownicy:
   $$u_{steer} = \operatorname{clamp}(-1.0, 1.0, y_0)$$
2. **$y_1$ (Throttle Raw)**:
   $$u_{throttle,raw} = \operatorname{clamp}(0.0, 1.0, (y_1 + 0.3) \cdot 1.12)$$
3. **$y_2$ (Brake Raw)**:
   $$u_{brake,raw} = y_2 > 0.05 \ ? \ \min(1.0, (y_2 - 0.05) \cdot 1.35) \ : \ 0.0$$

---

### 3.4 Uczenie Online (Backpropagation & Replay Buffer)

Bolidy zbierają próbki do bufora `replayBuffer` (pojemność 40 próbek). 
- Co 90 kroków fizyki (1.5 sekundy) losowane są 3 próbki o najwyższej nagrodzie `reward = speedKmh`.
- Wsteczna propagacja błędu aktualizuje wagi:
  $$\delta_o = (a_o - t_o) \cdot (1 - a_o^2)$$
  $$\delta_h^{(l)} = \left(\sum_{k} \delta_k^{(l+1)} \cdot W_{kh}^{(l+1)}\right) \cdot (1 - (a_h^{(l)})^2)$$
  $$W_{ij} \leftarrow \operatorname{clamp}\left(-3.0, 3.0, W_{ij} - \eta \cdot \delta_i \cdot a_j\right)$$
  gdzie $\eta = 0.001$ (bezpieczny krok uczący zapobiegający rozmywaniu wag).

---

### 3.5 Algorytm Genetyczny, Selekcja i Simulated Annealing

- **Krzyżowanie (Uniform Crossover)**: Połączenie cech kierowcy z sesyjnym liderem P1 (`championBrain`).
- **Mutacja wag**: Do wybranych wag dodawana jest losowa zmienna gaussowska:
  $$W_{ij} \leftarrow W_{ij} + \mathcal{N}(0, \sigma^2)$$
- **Adaptacyjne chłodzenie (Simulated Annealing)**:
  - Gdy kierowca pobije swój rekord życiowy, współczynnik mutacji jest schładzany:
    $$\text{mutRate} \leftarrow \max(0.025, \text{mutRate} \cdot 0.85)$$
  - Utrwala to zwycięską linię jazdy i zapobiega destabilizacji bolidu.

---

## 4. Polityka Sterowania i Autonomiczny Kierowca Wyścigowy

### 4.1 Szacowanie Prędkości Dopuszczalnej i Stref Dohamowań

Algorytm skanuje trasę naprzód na odległość $K$ punktów kontrolnych ($K = \operatorname{clamp}(5, 16, \lceil v / 5.2 \rceil)$):

Dla każdego punktu w horyzoncie obliczana jest maksymalna dopuszczalna prędkość pokonania łuku o promieniu $R = \frac{1}{\kappa}$:
$$v_{safe} = \sqrt{R \cdot g \cdot \mu_{eff} \cdot 0.88}$$
Z równania ruchu jednostajnie opóźnionego wyznaczana jest maksymalna prędkość, z której bolid zdoła wyhamować do $v_{safe}$ na dystansie $d$:
$$v_{allowed} = \sqrt{v_{safe}^2 + 2 \cdot a_{brake} \cdot d}$$
Wskaźnik konieczności hamowania wynosi:
$$\text{overspeedDelta} = \max_{k} \left(\frac{v - v_{allowed,k}}{20.0}\right)$$

---

### 4.2 Polityka 100% Pełnego Gazu na Prostych i Wyjściach

Wyeliminowano problem zwalniania do 280 km/h za pomocą bezwzględnej reguły logicznej:

```ts
if (overspeedDelta > 0.0) {
  // STREFA DOHAMOWANIA:
  throttle = 0.0;
  brake = Math.max(0.40, Math.min(1.0, 0.40 + overspeedDelta * 1.5));
} else {
  // STREFA PRZYSPIESZANIA / JAZDY:
  brake = 0.0; // Absolutny zakaz dotykania hamulca!
  
  if (minCenterClearance > 0.18) {
    if (Math.abs(steer) < 0.35) {
      // Proste, łuki i wyjścia z zakrętów: 100% PEŁEN GAZ!
      throttle = 1.0;
    } else {
      // Wierzchołek ciasnego zakrętu: kontrola trakcji
      const steerExcess = Math.abs(steer) - 0.35;
      throttle = Math.max(0.50, 1.0 - steerExcess * 0.80);
    }
  }
}
```

Dzięki temu bolidy osiągają pełną moc 1000 KM na każdej prostej, bez oporów rozpędzając się do **390–422 km/h**.

---

### 4.3 Telemetry Coaching (Kooperacja z Liderem Sesji)

Gdy bolid jedzie wolniej od zarejestrowanego rekordu lidera w danym punkcie toru o więcej niż $8\text{ km/h}$, algorytm natychmiast wymusza otwarcie przepustnicy na $100\%$, wymuszając agresywną jazdę na poziomie mistrza sesji.

---

### 4.4 Performance Guard (Mechanizm Samonaprawczy Mózgów AI)

Aby zapobiec degradacji osiągów po setkach okrążeń (L800+):
1. Mózg mistrzowski `record.bestBrain` jest zapisywany **wyłącznie w chwili pobicia rekordu życiowego**.
2. Usunięto destrukcyjną losową mutację po ukończeniu okrążenia.
3. Jeśli bolid przejedzie okrążenie wolniejsze o $> 2.5\text{ s}$ od swojego rekordu życiowego (np. w wyniku kolizji lub poślizgu), jego wagi sieci są natychmiast przywracane z `bestBrain.clone()`.

---

## 5. Geometria Toru i Przyspieszenie Przestrzenne

### 5.1 Interpolacja Krzywymi Składanymi Catmull-Rom

Dowolny zestaw punktów kontrolnych $P_0, P_1, \dots, P_{N-1}$ narysowany przez gracza tworzy zamkniętą pętlę wygładzaną funkcją:
$$C(t) = \frac{1}{2} \begin{bmatrix} 1 & t & t^2 & t^3 \end{bmatrix} \begin{bmatrix} 0 & 2 & 0 & 0 \\ -1 & 0 & 1 & 0 \\ 2 & -5 & 4 & -1 \\ -1 & 3 & -3 & 1 \end{bmatrix} \begin{bmatrix} P_{i-1} \\ P_i \\ P_{i+1} \\ P_{i+2} \end{bmatrix}$$
Dla każdego wyliczonego punktu osi środkowej wyznaczane są:
- Wektor styczny $\vec{T} = \frac{C'(t)}{\|C'(t)\|}$,
- Wektor normalny $\vec{N} = (-T_y, T_x)$,
- Krawędź lewa $P_{left} = C(t) - \vec{N} \cdot \frac{W_{track}}{2}$,
- Krawędź prawa $P_{right} = C(t) + \vec{N} \cdot \frac{W_{track}}{2}$,
- Krzywizna $\kappa = \frac{x' y'' - y' x''}{(x'^2 + y'^2)^{3/2}}$.

---

### 5.2 Siatka Przestrzenna (Uniform Spatial Grid $O(1)$)

Dla toru o długości kilku kilometrów test kolizji 25 promieni dla 10 bolidów (250 promieni na klatkę $\times$ setki segmentów toru) w złożoności $O(N)$ zużywałby za dużo mocy obliczeniowej.

Zastosowano **Uniform Spatial Grid** z rozmiarem komórki $80\text{ px}$:
- Wszystkie segmenty barier toru są przypisywane do komórek siatki przy inicjalizacji toru.
- Algorytm raycastingu bada wyłącznie komórki leżące na trasie promienia za pomocą szybkiego algorytmu DDA (*Digital Differential Analyzer*).
- Złożoność raycastingu wynosi **$O(1)$**.

---

### 5.3 Sektory i Bramki Pomiarowe (TimingGates)

Tor jest automatycznie dzielony na 4 strefy czasowe:
- **CP 1 (Sektor 1)**: $25\%$ długości toru,
- **CP 2 (Sektor 2)**: $50\%$ długości toru,
- **CP 3 (Sektor 3)**: $75\%$ długości toru,
- **CP 4 / META (Sektor 4)**: $100\%$ (linia start/meta).

Każda bramka rejestruje precyzyjny międzyczas przecięcia promienia przez przód bolidu z dokładnością do $1\text{ ms}$.

---

## 6. Maszyna Stanów Wyścigu Grand Prix i Pit-Stopy

```
       [IDLE] ─── (Kliknięcie "Rozpocznij Wyścig") ───┐
         ▲                                            ▼
         │                                      [GRID_START]
         │                              (5 czerwonych świateł zapalanych
         │                               co 1s, start po zgaśnięciu)
         │                                            │
         │                                            ▼
   [Przerwij Wyścig]                              [RACING]
         │                               (Okrążenia 1..N, pit-stopy,
         │                                zużycie paliwa, reguła DNF)
         │                                            │
         │                                            ▼
         └────────────────────────────────────── [FINISHED]
                                           (Podium, klasyfikacja)
```

### Zasady Wyścigu:
1. **Reguła DNF**: W wyścigu bolid, który uderzy w barierę, zostaje trwale wyeliminowany (`💥 DNF`). Nie ma respawnów.
2. **Pit-Stop**:
   - Bolid zjeżdża do alei serwisowej po wciśnięciu `[P]` lub automatycznie przy $m_{fuel} < 12\text{ kg}$.
   - Zatrzymanie w boksie trwa $3.2\text{ s}$.
   - Paliwo tankowane jest z prędkością $28\text{ kg/s}$ do poziomu $105\text{ kg}$.

---

## 7. Protokoły Komunikacyjne i Interfejs Danych (SimSnapshot)

Struktura obiektu `SimSnapshot` przesyłana z workera do wątku głównego:

```typescript
export interface SimSnapshot {
  cars: SerializedCar[];                  // Stany 10 bolidów AI
  playerCar: SerializedCar | null;        // Stan bolidu gracza (WASD)
  bestRacingLine: TrajectoryPoint[];      // Rekordowa linia wyścigowa sesji
  leaderCheckpointSpeeds: number[];       // Profil prędkości mistrza
  teamStandings: LapLeaderboardEntry[];   // Tabela z czasami BEST, LAST, TERAZ
  learningHistory: LearningPoint[];       // Dane wykresu postępów w czasie
  aliveCount: number;                     // Liczba aktywnych bolidów
  globalBestLap: number | null;           // Rekord absolutny sesji
  generation: number;                     // Numer generacji ewolucyjnej
  maxFitness: number;                     // Najwyższy wskaźnik przystosowania
  speedMultiplier: number | 'max';        // Prędkość symulacji (1x..MAX)
  timingGates: TimingGate[];              // Współrzędne 4 sektorów F1
  sessionBestSplits: (number | null)[];   // Najlepsze międzyczasy sesji
  raceState: RaceState;                   // IDLE | GRID_START | RACING | FINISHED
  raceTotalLaps: number;                  // Liczba okrążeń wyścigu (50..100)
  raceCurrentLap: number;                 // Bieżące okrążenie lidera
  raceStartLights: number;                // 0..5 (czerwone światła), -1 (start)
  raceWinner: string | null;              // Nazwisko zwycięzcy wyścigu
  raceStandings: RaceStanding[];          // Kolejność i straty czasowe / duble
}
```

---

## 8. Podsumowanie Zaimplementowanych Poprawek Inżynieryjnych

| Problem | Przyczyna źródłowa | Rozwiązanie inżynieryjne | Skutek |
| :--- | :--- | :--- | :--- |
| **Prędkość 280 km/h zamiast 400 km/h** | Zbyt daleki horyzont `isOpenStraight` (224m) wyłączał pełen gaz na prostej. | Bezwzględna reguła: 100% gazu i 0% hamulca, gdy bolid nie jest w strefie hamowania. | Bolidy osiągają **390–422 km/h** na każdej długiej prostej. |
| **Degradacja czasów o 15s po 800 okrążeniach** | Ślepa mutacja `mutate(0.012, 0.035)` co okrążenie i nadpisywanie `bestBrain` przez monotoniczny fitness. | Usunięcie ślepych mutacji, zapis `bestBrain` tylko przy rekordzie, dodanie *Performance Guard*. | Czasy okrążeń pozostają idealnie stabilne przez tysiące okrążeń. |
| **Brak synchronizacji bramek przy nowym torze** | Flaga w `main.ts` blokowała aktualizację bramek, gdy tor miał już bramki. | Automatyczna synchronizacja `timingGates` przy każdej zmianie geometrii toru. | Wszystkie 4 sektory zawsze idealnie pokrywają nowo narysowany tor. |
| **Wyświetlanie ostatniego czasu okrążenia** | Tabela pokazywała tylko czas najlepszy i bieżący. | Dodanie kolumny `LAST` obok `BEST` bez naruszania wielkości fontów. | Pełny podgląd tempa wyścigowego każdego kierowcy w czasie rzeczywistym. |
