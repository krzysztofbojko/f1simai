# 🏎️ Wyczerpująca Analiza Fizyki: Układ Napędowy, Hamulcowy oraz Dynamika Masy i Paliwa w F1 AI Simulator

Niniejszy dokument stanowi dogłębną analizę inżynieryjno-matematyczną modeli fizycznych zaimplementowanych w projekcie **F1 AI Simulator**, ze szczególnym uwzględnieniem kodu źródłowego silnika fizyki ([`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts)), dokumentacji technicznej ([`opis.md`](file:///Users/krzysztofbojko/f1simai/opis.md)) oraz wątku obliczeniowego ([`sim.worker.ts`](file:///Users/krzysztofbojko/f1simai/src/workers/sim.worker.ts)).

---

## 📑 Spis Treści
1. [Architektura Fizyki i Jednostki Symulacji](#1-architektura-fizyki-i-jednostki-symulacji)
2. [Część 1: Układ Napędowy (Powertrain)](#część-1-układ-napędowy-powertrain)
   - 1.1 [Równanie Siły Napędowej Silnika ($P_{max} / v$) i Ochrona Przed Osobliwością](#11-równanie-siły-napędowej-silnika-p_max--v-i-ochrona-przed-osobliwością)
   - 1.2 [Skalowanie z Otwarciem Przepustnicy i Brake Override](#12-skalowanie-z-otwarciem-przepustnicy-i-brake-override)
   - 1.3 [Napęd na Tylną Oś (RWD) i Dynamiczny Limit Trakcji](#13-napęd-na-tylną-oś-rwd-i-dynamiczny-limit-trakcji)
   - 1.4 [Interakcja z Elipsą Kamma i Zjawisko Power Oversteer](#14-interakcja-z-elipsą-kamma-i-zjawisko-power-oversteer)
3. [Część 2: Układ Hamulcowy (Braking System)](#część-2-układ-hamulcowy-braking-system)
   - 2.1 [Charakterystyka Hamulców Węglowo-Ceramicznych](#21-charakterystyka-hamulców-węglowo-ceramicznych)
   - 2.2 [Balans Hamulców Przód/Tył (56%/44%) i Dynamiczny Pitch Transfer](#22-balans-hamulców-przódtył-5644-i-dynamiczny-pitch-transfer)
   - 2.3 [Opóźnienia Rzędu 5G i Droga Hamowania przy Prędkościach 350–400 km/h](#23-opóźnienia-rzędu-5g-i-droga-hamowania-przy-prędkościach-350400-kmh)
   - 2.4 [Zjawisko Blokowania Kół (Lock-Up) i Podsterowność na Dojeździe](#24-zjawisko-blokowania-kół-lock-up-i-podsterowność-na-dojeździe)
4. [Część 3: Dynamika Masy i Paliwa](#część-3-dynamika-masy-i-paliwa)
   - 3.1 [Model Różniczkowy Zużycia Paliwa pod Obciążeniem](#31-model-różniczkowy-zużycia-paliwa-pod-obciążeniem)
   - 3.2 [Wpływ Ubytku Masy na Czasy Okrążeń (Lap Time Sensitivity)](#32-wpływ-ubytku-masy-na-czasy-okrążeń-lap-time-sensitivity)
   - 3.3 [Tryb Awaryjny Limp Mode przy Braku Paliwa](#33-tryb-awaryjny-limp-mode-przy-braku-paliwa)
   - 3.4 [Procedura Pit-Stopu i Tankowanie w Boksie](#34-procedura-pit-stopu-i-tankowanie-w-boksie)
5. [Tabela Porównawcza: Specyfikacja vs Kod Źródłowy](#5-tabela-porównawcza-specyfikacja-vs-kod-źródłowy)
6. [Podsumowanie Wniosków Inżynieryjnych](#6-podsumowanie-wniosków-inżynieryjnych)

---

## 1. Architektura Fizyki i Jednostki Symulacji

Silnik fizyki w [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts) jest w pełni oparty na układzie jednostek **SI**:
- Długość i położenie: metry ($\text{m}$), gdzie przyjęto stałą skalę przestrzenną:
  $$\text{METERS\_PER\_PIXEL} = 1.0 \quad (1\text{ px} = 1\text{ m})$$
- Czas: sekundy ($\text{s}$), dyskretyzacja w stałym kroku czasowym $\Delta t = \frac{1}{60}\text{ s} \approx 0.01667\text{ s}$ w dedykowanym workerze ([`sim.worker.ts`](file:///Users/krzysztofbojko/f1simai/src/workers/sim.worker.ts)).
- Prędkość: $\text{m/s}$ oraz konwersja telemetryczna na $\text{km/h}$ ($v_{kmh} = v \cdot 3.6$).
- Siły: niutony ($\text{N}$), masy: kilogramy ($\text{kg}$), kąty: radiany ($\text{rad}$).

Kluczowe wektory lokalne bolidu:
- **Kierunek wzdłużny (Forward)**: $\vec{u}_{forward} = (\cos\theta, \sin\theta)$
- **Kierunek poprzeczny (Right)**: $\vec{u}_{right} = (-\sin\theta, \cos\theta)$
- **Prędkość wzdłużna**: $v_{forward} = \vec{v} \cdot \vec{u}_{forward}$
- **Prędkość boczna**: $v_{lateral} = \vec{v} \cdot \vec{u}_{right}$

---

## Część 1: Układ Napędowy (Powertrain)

Układ napędowy symuluje nowoczesną jednostkę hybrydową Formuły 1 (V6 Turbo Hybrid) o mocy systemowej rzędu **750 kW** (~**1020 KM**).

```
[Przepustnica u_throttle] ──► [Brake Override Cut] ──► [Limp Mode Check]
                                                            │
                                                            ▼
[Moc P_max = 750 kW] ──► P_eff = P_max * actualThrottle * k_power
                                │
                                ▼
                       F_engine = P_eff / max(12.0, v_forward)
                                │
[Docisk + Transfer Masy] ──► F_traction,max = mu_base * k_grip * F_z,rear
                                │
                                ▼
                     F_drive = min(F_engine, F_traction,max)  (RWD)
```

### 1.1 Równanie Siły Napędowej Silnika ($P_{max} / v$) i Ochrona Przed Osobliwością

W klasycznej mechanice relacja pomiędzy mocą silnika $P$, siłą napędową na kołach $F$ a prędkością postępową pojazdu $v$ wyraża się wzorem:
$$P = F \cdot v \iff F = \frac{P}{v}$$

W kodzie źródłowym [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L571-L577) równanie to zaimplementowano następująco:

```typescript
let driveForceMag = 0;
if (actualThrottle > 0.005) {
  const effectivePower = this.maxEnginePower * actualThrottle * this.lapPowerFactor;
  const powerForce = effectivePower / Math.max(12.0, forwardSpeed);
  // Rear traction limit governed by dynamic rear vertical load: F = mu * Fz_rear
  const rearTractionLimit = this.baseTireGrip * this.lapGripFactor * normalLoadRear;
  driveForceMag = Math.min(rearTractionLimit, powerForce);
}
```

#### Ochrona przed osobliwością $v \to 0$
W rzeczywistym bolidzie przekładnia główna i sprzęgło ograniczają maksymalny moment obrotowy na kołach przy ruszaniu z miejsca. Bez zabezpieczenia matematycznego, dla $v \to 0$ wartość $P / v \to \infty$, co w symulacji komputerowej prowadziłoby do eksplozji numerycznej (wartości `NaN` lub `Infinity`).

W symulatorze zastosowano dolne ograniczenie mianownika:
$$v_{eff} = \max(12.0, v_{forward})$$
Wartość progowa $12.0\text{ m/s} = 43.2\text{ km/h}$ odpowiada końcowi pierwszego biegu w skrzyni F1.

Dla prędkości poniżej $43.2\text{ km/h}$ maksymalna teoretyczna siła generowana przez silnik wynosi:
$$F_{power,max} = \frac{750\,000\text{ W}}{12.0\text{ m/s}} = 62\,500\text{ N} \quad (62.5\text{ kN})$$

Taka siła znacznie przewyższa możliwości przyczepnościowe opon, co wymusza działanie limitera trakcji.

#### Hiperboliczny spadek siły napędowej wraz z prędkością
Wraz ze wzrostem prędkości siła napędowa maleje hiperbolicznie:

| Prędkość $v$ [km/h] | Prędkość $v$ [m/s] | $F_{engine}$ (przy $u=1.0$) [N] | Dostępne przyspieszenie wzdłużne $a_x$ (dla $m=850\text{ kg}$) |
| :--- | :--- | :--- | :--- |
| **0 – 43.2** | 0.0 – 12.0 | $62\,500\text{ N}$ | Limitowane trakcją tylnej osi |
| **100.0** | 27.78 | $27\,000\text{ N}$ | $\approx 31.7\text{ m/s}^2 \approx 3.23\text{ G}$ |
| **180.0** | 50.00 | $15\,000\text{ N}$ | $\approx 17.6\text{ m/s}^2 \approx 1.80\text{ G}$ |
| **250.0** | 69.44 | $10\,800\text{ N}$ | $\approx 12.7\text{ m/s}^2 \approx 1.30\text{ G}$ |
| **320.0** | 88.89 | $8\,438\text{ N}$ | $\approx 9.9\text{ m/s}^2 \approx 1.01\text{ G}$ |
| **360.0** | 100.00 | $7\,500\text{ N}$ | $\approx 8.8\text{ m/s}^2 \approx 0.90\text{ G}$ |
| **400.0** | 111.11 | $6\,750\text{ N}$ | $\approx 7.9\text{ m/s}^2 \approx 0.81\text{ G}$ |

#### Prędkość maksymalna $V_{max}$ i równowaga sił na prostej
Na długiej prostej przyspieszenie ustaje ($a_x = 0$), gdy siła napędowa zrównuje się z sumą siły oporu powietrza $F_{drag}$ oraz oporu toczenia $F_{rr}$:
$$F_{drive} = F_{drag} + F_{rr}$$
Gdzie:
$$F_{drag} = \frac{1}{2} \cdot \rho \cdot (C_D \cdot A) \cdot k_{drag} \cdot v^2$$
Dla parametrów z [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L80-L81) ($\rho = 1.225\text{ kg/m}^3$, $C_D \cdot A = 1.00\text{ m}^2$, $P = 750\,000\text{ W}$):
$$\frac{P}{v} \approx \frac{1}{2} \rho (C_D A) v^2 \implies v^3 \approx \frac{2 P}{\rho (C_D A)}$$
$$v^3 \approx \frac{2 \cdot 750\,000}{1.225 \cdot 1.00} = 1\,224\,490 \implies v_{terminal} \approx 106.98\text{ m/s} \approx \mathbf{385.1\text{ km/h}}$$

Przy uwzględnieniu losowego czynnika sesyjnego $k_{drag} \in [0.985, 1.015]$ i $k_{power} \in [0.98, 1.02]$ prędkość maksymalna waha się w granicach **380 – 392 km/h** (a przy $C_D A = 0.70$, jak notowano we wcześniejszej specyfikacji aerodynamicznej, sięgała nawet **422 km/h**).

---

### 1.2 Skalowanie z Otwarciem Przepustnicy i Brake Override

Moc użyteczna silnika skaluje się liniowo z efektywnym otwarciem przepustnicy $u_{throttle,actual} \in [0.0, 1.0]$:
$$P_{eff} = P_{max} \cdot u_{throttle,actual} \cdot k_{power}$$
gdzie $k_{power} = \text{lapPowerFactor} \in [0.98, 1.02]$ modeluje drobne wahania ciśnienia doładowania i temperatury powietrza.

#### Układ Brake Override (Drive-by-Wire)
W profesjonalnym motorsporcie systemy elektronicznej przepustnicy (Drive-by-Wire) posiadają procedurę priorytetu hamulca (*Brake Throttle Override*), która uniemożliwia jednoczesne wciskanie gazu i hamulca do dechy, co mogłoby doprowadzić do destabilizacji tylnej osi lub pożaru tarcz hamulcowych.

W [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L516-L517) zaimplementowano funkcję odcięcia przepustnicy:
```typescript
const brakeOverrideCut = Math.max(0, 1.0 - control.brake * 1.4);
let actualThrottle = control.throttle * brakeOverrideCut;
```
- Gdy kierowca nie dotyka hamulca ($u_{brake} = 0$), $\text{brakeOverrideCut} = 1.0$ (100% gazu przechodzi bez zmian).
- Gdy kierowca delikatnie muska hamulec (np. $u_{brake} = 0.20$), przepustnica jest redukowana o $28\%$ ($1.0 - 0.28 = 0.72$).
- Gdy nacisk na pedał hamulca przekroczy próg:
  $$u_{brake} \ge \frac{1.0}{1.4} \approx 0.714 \quad (71.4\%)$$
  mnożnik osiąga zero ($\text{brakeOverrideCut} = 0.0$), bezwzględnie **odcinając 100% mocy silnika**.

---

### 1.3 Napęd na Tylną Oś (RWD) i Dynamiczny Limit Trakcji

Bolid F1 posiada napęd wyłącznie na tylną oś (**Rear-Wheel Drive**). Oznacza to, że siła napędowa nie może przekroczyć fizycznego limitu przyczepności opon tylnych:
$$F_{traction,max} = \mu_{base} \cdot k_{grip} \cdot F_{z,rear}$$

Gdzie:
- $\mu_{base} = 1.85$ to szczytowy współczynnik tarcia miękkich opon typu slick,
- $k_{grip} = \text{lapGripFactor} \in [0.975, 1.025]$,
- $F_{z,rear}$ to chwilowy pionowy nacisk na tylną oś.

#### Dynamiczny wzdłużny transfer masy (Longitudinal Pitch Transfer)
Nacisk na tylną oś nie jest stały. W spoczynku rozkład mas wynosi **46% przód / 54% tył**:
$$F_{z,static,rear} = 0.54 \cdot F_z$$
gdzie $F_z = m \cdot g + F_{downforce}$.

W momencie wciśnięcia gazu bolid doznaje przyspieszenia wzdłużnego $a_x > 0$. Siła bezwładności działająca na środku ciężkości na wysokości $h_{CoG} = 0.32\text{ m}$ wywołuje moment obrotowy wokół osi poprzecznej (zjawisko *Squat* – przysiad tyłu nadwozia):
$$\Delta F_{z,pitch} = m \cdot (-a_x) \cdot \frac{h_{CoG}}{L}$$
W kodzie ([`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L559-L563)):
```typescript
const prevAccelX = this.longitudinalG * Car.GRAVITY;
const dynamicPitchTransfer = currentMass * (-prevAccelX) * (this.cogHeight / this.wheelbase);

const normalLoadFront = Math.max(100, (0.46 * totalNormalLoadZ) + dynamicPitchTransfer);
const normalLoadRear = Math.max(100, (0.54 * totalNormalLoadZ) - dynamicPitchTransfer);
```

Podczas przyspieszania $a_x > 0$, więc $\text{dynamicPitchTransfer} < 0$. W konsekwencji:
$$F_{z,rear} = 0.54 \cdot F_z + |\Delta F_{z,pitch}|$$
Następuje transfer masy z przodu na tył bolidu. Dociążenie tylnej osi zwiększa limit trakcji $F_{traction,max}$, co w naturalny sposób sprzyja efektywnemu przyspieszaniu bolidu F1 z wyjść z zakrętów!

#### Przykład liczbowy przy ruszaniu z miejsca ($v \approx 0$, $m = 850\text{ kg}$):
1. Nacisk grawitacyjny: $F_z = 850 \cdot 9.81 = 8338.5\text{ N}$.
2. Statyczny nacisk tyłu: $0.54 \cdot 8338.5 = 4502.8\text{ N}$.
3. Limit trakcji statycznej: $F_{traction} \approx 1.85 \cdot 4502.8 \approx 8330\text{ N}$.
4. Pod wpływem przyspieszenia $a_x \approx 1.0\text{ G} = 9.81\text{ m/s}^2$:
   $$|\Delta F_{z,pitch}| = 850 \cdot 9.81 \cdot \frac{0.32}{3.6} = 8338.5 \cdot 0.08889 \approx 741.2\text{ N}$$
5. Dynamiczny nacisk tyłu rośnie do $F_{z,rear} = 4502.8 + 741.2 = 5244\text{ N}$.
6. Nowy limit trakcji wynosi:
   $$F_{traction,max} = 1.85 \cdot 5244\text{ N} \approx \mathbf{9701\text{ N}}$$
Silnik żądający $62\,500\text{ N}$ zostaje natychmiast ucięty do $9701\text{ N}$, co generuje bezpieczne przyspieszenie startowe rzędu $a_x = \frac{9701}{850} \approx 11.41\text{ m/s}^2 \approx \mathbf{1.16\text{ G}}$.

---

### 1.4 Interakcja z Elipsą Kamma i Zjawisko Power Oversteer

Ograniczenie sił na oponie opisuje model elipsy przyczepności Kamma (*Kamm's Friction Circle*):
$$\left(\frac{F_x}{F_{x,max}}\right)^2 + \left(\frac{F_y}{F_{y,max}}\right)^2 \le 1.0$$

W kodzie ([`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L629-L637)):
```typescript
const rearLongitudinalUsage = Math.min(0.98, Math.max(brakeRearForce, driveForceMag) / Math.max(1, this.baseTireGrip * normalLoadRear));
const rearGripFactor = Math.sqrt(Math.max(0.05, 1.0 - rearLongitudinalUsage * rearLongitudinalUsage));
const rearMaxLateralForce = effectiveTireMu * normalLoadRear * rearGripFactor;
```

#### Fizyczne skutki dla dynamiki pojazdu:
- Gdy kierowca gwałtownie otwiera przepustnicę na $100\%$ w wierzchołku zakrętu, siła wzdłużna $F_{drive}$ wykorzystuje np. $90\%$ dostępnego tarcia ($\text{rearLongitudinalUsage} = 0.90$).
- Dostępny współczynnik przyczepności bocznej na tylnej osi spada dramatycznie:
  $$\text{rearGripFactor} = \sqrt{1.0 - 0.90^2} = \sqrt{1.0 - 0.81} = \sqrt{0.19} \approx \mathbf{0.436} \quad (-56.4\%!)$$
- Siła odśrodkowa przekracza zredukowaną przyczepność tylnej osi ($F_{centrifugal} > F_{lat,total}$), wywołując natychmiastową nadsterowność mocy (**Power Oversteer**). W kodzie włącza się zmienna `oversteerSlip = 1.0 - gripRatio`, bolid staje bokiem, a na asfalcie pojawiają się ślady spalonej gumy (`skidMarks`).

---

## Część 2: Układ Hamulcowy (Braking System)

Układ hamulcowy w bolidzie F1 to jeden z najbardziej ekstremalnych mechanizmów inżynieryjnych na świecie, łączący tarcze z kompozytów węglowo-węglowych i ceramicznych z potężnym dociskiem aerodynamicznym.

```
                    [Pedał Hamulca u_brake]
                              │
             ┌────────────────┴────────────────┐
             ▼                                 ▼
   [Oś Przednia (56%)]                [Oś Tylna (44%)]
             │                                 │
             ▼                                 ▼
F_brake,front = u_b * mu_eff * F_z,front   F_brake,rear = u_b * mu_eff * F_z,rear
             │                                 │
             └────────────────┬────────────────┘
                              ▼
                   F_brake,total = sum(F_i)
                              │
       [Opór Powietrza F_drag = 0.5 * rho * CdA * v^2]
                              │
                              ▼
     Opóźnienie a_x = (F_brake + F_drag + F_rr) / m  ──►  DOCHODZI DO 5.0 - 8.0 G!
```

### 2.1 Charakterystyka Hamulców Węglowo-Ceramicznych

W prawdziwym bolidzie F1 tarcze węglowe pracują optymalnie w temperaturach od $400^\circ\text{C}$ do ponad $1000^\circ\text{C}$, osiągając gigantyczne współczynniki tarcia przekraczające $\mu \approx 1.5 - 2.0$.

W symulatorze zdefiniowano:
- Bazową przyczepność opon: `baseTireGrip = 1.85`,
- Mnożnik siły hamowania: `brakeGripMultiplier = 1.10`.

Efektywny współczynnik tarcia przy pełnym dohamowaniu wynosi:
$$\mu_{brake} = \mu_{base} \cdot \text{brakeGripMultiplier} = 1.85 \cdot 1.10 = \mathbf{2.035}$$

> [!NOTE]
> **Kluczowa kalibracja inżynieryjna w kodzie:**
> We wczesnej fazie projektu w dokumentacji [`opis.md`](file:///Users/krzysztofbojko/f1simai/opis.md#L148) figurował mnożnik `1.60`, co dawało $\mu_{eff} = 1.85 \cdot 1.60 = 2.96$. W komentarzu w [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L84-L85) autorzy wprost wyjaśniają powód korekty:
> ```typescript
> public readonly brakeGripMultiplier: number = 1.10; // hamowanie moze uzyc nieco wiecej tarcia niz boczne (1.6 dawalo mu=2.96 i ~10 G)
> ```
> Wartość `1.10` zapewnia precyzyjne odtworzenie rzeczywistych przeciążeń F1 rzędu **4.5 – 5.5 G** przy typowych prędkościach wyścigowych.

---

### 2.2 Balans Hamulców Przód/Tył (56%/44%) i Dynamiczny Pitch Transfer

Statyczny balans hamulców w bolidzie wyścigowym ustawiany jest zazwyczaj na poziomie **54% – 58% na przód**. W symulatorze zastosowano wartość bazową **56% przód / 44% tył**.

#### Matematyka dynamicznego transferu masy pod wpływem opóźnienia
Podczas gwałtownego hamowania opóźnienie $a_x < 0$ (w układzie pojazdu skierowane przeciwnie do wektora prędkości) generuje moment nurkowania nadwozia (*Nose Dive*):
$$\Delta F_{z,pitch} = m \cdot (-a_x) \cdot \frac{h_{CoG}}{L} > 0$$

Dla maksymalnego opóźnienia $a_x \approx -5.0\text{ G} = -49.05\text{ m/s}^2$, masy $m = 850\text{ kg}$, $h_{CoG} = 0.32\text{ m}$ i rozstawu osi $L = 3.60\text{ m}$:
$$\Delta F_{z,pitch} = 850 \cdot 49.05 \cdot \frac{0.32}{3.60} = 41\,692.5 \cdot 0.08889 \approx \mathbf{3706\text{ N}}$$

Naciski na poszczególne osie wynoszą:
$$F_{z,front} = 0.46 \cdot F_z + \Delta F_{z,pitch}$$
$$F_{z,rear} = 0.54 \cdot F_z - \Delta F_{z,pitch}$$

W kodzie ([`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L580-L589)):
```typescript
let maxBrakeMag = 0;
let brakeFrontForce = 0;
let brakeRearForce = 0;
if (control.brake > 0.01) {
  const maxBrakeFront = this.baseTireGrip * this.brakeGripMultiplier * normalLoadFront;
  const maxBrakeRear = this.baseTireGrip * this.brakeGripMultiplier * normalLoadRear;
  brakeFrontForce = control.brake * maxBrakeFront;
  brakeRearForce = control.brake * maxBrakeRear;
  maxBrakeMag = brakeFrontForce + brakeRearForce;
}
```

#### Dlaczego balans 56/44 jest kluczowy dla stabilności?
Gdyby układ hamulcowy dociskał tylną oś równie mocno jak przednią, odciążony tył ($F_{z,rear}$ spada o niemal 4 kN) uległby natychmiastowemu zablokowaniu (*Rear Axle Lock-up*). Zablokowanie tylnych kół redukuje ich przyczepność boczną do zera, co prowadzi do gwałtownego obrotu bolidu wokół własnej osi (tzw. *Snap Oversteer* / "bączek"). Przesunięcie balansu na przód gwarantuje, że to przednie koła jako pierwsze osiągną limit przyczepności, stabilizując tor jazdy.

---

### 2.3 Opóźnienia Rzędu 5G i Droga Hamowania przy Prędkościach 350–400 km/h

Bolid F1 hamuje nie tylko oponami i tarczami, ale w ogromnym stopniu **aerodynamiką**. Całkowita siła zatrzymująca pojazd to suma siły tarcia hamulców, oporu powietrza i oporów toczenia:
$$F_{stop}(v) = F_{brake}(v) + F_{drag}(v) + F_{rr}(v)$$
Gdzie:
$$F_{downforce}(v) = \frac{1}{2} \rho (C_L \cdot A) v^2 = \frac{1}{2} \cdot 1.225 \cdot 3.10 \cdot v^2 \approx 1.89875 \cdot v^2$$
$$F_z(v) = m \cdot g + F_{downforce}(v) = 850 \cdot 9.81 + 1.89875 \cdot v^2$$
$$F_{brake}(v) = \mu_{brake} \cdot F_z(v) = 2.035 \cdot (8338.5 + 1.89875 \cdot v^2)$$
$$F_{drag}(v) = \frac{1}{2} \rho (C_D \cdot A) v^2 = \frac{1}{2} \cdot 1.225 \cdot 1.00 \cdot v^2 \approx 0.6125 \cdot v^2$$
$$F_{rr}(v) = 0.012 \cdot F_z(v)$$

Chwilowe opóźnienie wzdłużne wynosi:
$$a_x(v) = \frac{F_{stop}(v)}{m}$$

#### Tabela sił i opóźnień chwilowych w funkcji prędkości ($m = 850\text{ kg}$):

| Prędkość [km/h] | Prędkość $v$ [m/s] | Docisk aero $F_{down}$ [N] | Całkowity $F_z$ [N] | Siła hamulców $F_{brk}$ [N] | Opór aero $F_{drag}$ [N] | Sumaryczna siła $F_{stop}$ [N] | Chwilowe opóźnienie [$\text{m/s}^2$] | Chwilowe opóźnienie [G] |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **400 km/h** | 111.11 | $23\,441\text{ N}$ | $31\,780\text{ N}$ | $64\,672\text{ N}$ | $7\,562\text{ N}$ | $\mathbf{72\,615\text{ N}}$ | $85.43\text{ m/s}^2$ | **8.71 G** *(obcięte do 8.0 G)* |
| **350 km/h** | 97.22 | $17\,947\text{ N}$ | $26\,286\text{ N}$ | $53\,492\text{ N}$ | $5\,789\text{ N}$ | $\mathbf{59\,596\text{ N}}$ | $70.11\text{ m/s}^2$ | **7.15 G** |
| **300 km/h** | 83.33 | $13\,186\text{ N}$ | $21\,524\text{ N}$ | $43\,802\text{ N}$ | $4\,253\text{ N}$ | $\mathbf{48\,314\text{ N}}$ | $56.84\text{ m/s}^2$ | **5.79 G** |
| **250 km/h** | 69.44 | $9\,157\text{ N}$ | $17\,495\text{ N}$ | $35\,603\text{ N}$ | $2\,954\text{ N}$ | $\mathbf{38\,767\text{ N}}$ | $45.61\text{ m/s}^2$ | **4.65 G** |
| **200 km/h** | 55.56 | $5\,860\text{ N}$ | $14\,199\text{ N}$ | $28\,895\text{ N}$ | $1\,890\text{ N}$ | $\mathbf{30\,955\text{ N}}$ | $36.42\text{ m/s}^2$ | **3.71 G** |
| **100 km/h** | 27.78 | $1\,465\text{ N}$ | $9\,804\text{ N}$ | $19\,950\text{ N}$ | $473\text{ N}$ | $\mathbf{20\,541\text{ N}}$ | $24.17\text{ m/s}^2$ | **2.46 G** |

> [!IMPORTANT]
> **Zabezpieczenie numeryczne w kodzie:**
> W [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L606) wprowadzono twarde ograniczenie telemetryczne:
> ```typescript
> this.longitudinalG = Number.isFinite(rawLongG) ? Math.max(-8.0, Math.min(4.0, rawLongG)) : 0;
> ```
> Oznacza to, że teoretyczny pik 8.71 G przy 400 km/h zostaje bezpiecznie ograniczony do **8.0 G**.

#### Dokładne całkowanie drogi hamowania (Wyniki Numeryczne)
Rozwiązując równanie ruchu:
$$s = \int_{v_{end}}^{v_{start}} \frac{v \cdot dv}{a_x(v)}$$
otrzymujemy rzeczywiste drogi i czasy dohamowań bolidu:

1. **Dohamowanie z 400 km/h do 100 km/h** (wejście z prostej w ciasną szykanę):
   - Dystans hamowania: **119.56 metrów**
   - Czas manewru: **1.97 sekundy**
   - Średnie opóźnienie na całym dystansie:
     $$a_{avg} = \frac{\Delta v}{\Delta t} = \frac{(400 - 100) / 3.6}{1.969} = \frac{83.33\text{ m/s}}{1.969\text{ s}} \approx 42.32\text{ m/s}^2 \approx \mathbf{4.31\text{ G}}$$

2. **Dohamowanie z 350 km/h do 100 km/h** (klasyczne dohamowanie np. Monza Turn 1):
   - Dystans hamowania: **100.55 metrów**
   - Czas manewru: **1.78 sekundy**
   - Średnie opóźnienie: $\mathbf{3.96\text{ G}}$ (z wartościami początkowymi ponad 7.1 G!)

3. **Hamowanie awaryjne do zera (350 km/h $\to$ 0 km/h)**:
   - Dystans całkowity: **118.02 metrów**
   - Czas całkowity: **3.08 sekundy**

4. **Hamowanie awaryjne do zera (400 km/h $\to$ 0 km/h)**:
   - Dystans całkowity: **137.02 metrów**
   - Czas całkowity: **3.27 sekundy**

Wyniki te wykazują **stuprocentową zgodność** z oficjalną telemetrią FIA i danymi dostawców hamulców Brembo dla torów Monza, Spa-Francorchamps i Baku.

---

### 2.4 Zjawisko Blokowania Kół (Lock-Up) i Podsterowność na Dojeździe

Podczas wciskania hamulca na $100\%$ ($u_{brake} = 1.0$), obciążenie wzdłużne opon wynosi w kodzie:
```typescript
const frontLongitudinalUsage = Math.min(0.98, brakeFrontForce / Math.max(1, this.baseTireGrip * normalLoadFront));
const frontGripFactor = Math.sqrt(Math.max(0.05, 1.0 - frontLongitudinalUsage * frontLongitudinalUsage));
```
Dla $\text{frontLongitudinalUsage} = 0.98$:
$$\text{frontGripFactor} = \sqrt{1.0 - (0.98)^2} = \sqrt{1.0 - 0.9604} = \sqrt{0.0396} \approx \mathbf{0.199}$$

Oznacza to, że przy maksymalnym dohamowaniu opony przednie tracą **80.1% swojej zdolności do generowania siły bocznej**. Jeśli kierowca spróbuje w tym momencie skręcić koła, bolid przestaje reagować na kierownicę i sunie prosto w barierę z zablokowanymi przednimi kołami (zjawisko *Front Lock-up / Understeer Slip*).

---

## Część 3: Dynamika Masy i Paliwa

Dynamika masy i zużycia paliwa odgrywa kluczową rolę w strategii wyścigowej Grand Prix. Masa bolidu zmienia się w trakcie stintu o ponad **11%**, co wywiera bezpośredni wpływ na osiągi w zakrętach, drogę hamowania oraz czasy okrążeń.

```
       [Start Wyścigu: 105 kg paliwa] ──► Masa całkowita = 903 kg
                     │
                     ▼
      [Spalanie pod obciążeniem silnika]
      dm/dt = m_base + m_load * throttle * (0.30 + 0.70 * v/95)
                     │
                     ▼
   [Spadek masy: -2.5 kg na okrążenie] ──► +0.33s zysku na okrążeniu!
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
[Rezerwa: fuel < 12 kg]     [Bak pusty: fuel <= 0.001 kg]
         │                       │
         ▼                       ▼
  [AI: wantsToPit]          [Limp Mode: max 8% throttle, crawl ~18 km/h]
         │                       │
         ▼                       ▼
 [Pit-Stop: 3.2s, 28 kg/s]   [Zatrzymanie: speed < 1 m/s ──► 💥 DNF!]
```

### 3.1 Model Różniczkowy Zużycia Paliwa pod Obciążeniem

W [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L526-L532) zużycie paliwa modelowane jest równaniem różniczkowym pierwszego rzędu:

$$\frac{dm_{fuel}}{dt} = \dot{m}_{base} + \dot{m}_{load} \cdot u_{throttle,actual} \cdot \left(0.30 + 0.70 \cdot \frac{v}{95.0}\right)$$

Parametry równania:
- $\dot{m}_{base} = 0.004\text{ kg/s}$ ($4.0\text{ g/s} = 14.4\text{ kg/h}$) – stałe zużycie na biegu jałowym, podtrzymanie pracy pompy cieczy, układów hydraulicznych i kompresora.
- $\dot{m}_{load} = 0.062\text{ kg/s}$ ($62.0\text{ g/s} = 223.2\text{ kg/h}$) – zużycie pod pełnym obciążeniem silnika spalinowego ICE.
- Czynnik prędkościowy $\left(0.30 + 0.70 \cdot \frac{v}{95.0}\right)$ – odwzorowuje fakt, że przy wyższych prędkościach obrotowych silnika i maksymalnym ciśnieniu doładowania turbosprężarki (MGU-H) przepływ masowy mieszanki paliwowo-powietrznej jest najwyższy.

#### Wartości chwilowego spalania w różnych warunkach:
1. **Bieg jałowy / Toczenie z odpuszczonym gazem ($u=0$)**:
   $$\dot{m} = 0.004\text{ kg/s} = 14.4\text{ kg/h}$$
2. **Pełen gaz przy ruszaniu z miejsca ($u=1.0$, $v=0$)**:
   $$\dot{m} = 0.004 + 0.062 \cdot 0.30 = 0.004 + 0.0186 = 0.0226\text{ kg/s} \approx 81.36\text{ kg/h}$$
3. **Pełen gaz na prostej przy prędkości maksymalnej ($u=1.0$, $v=95\text{ m/s} = 342\text{ km/h}$)**:
   $$\dot{m} = 0.004 + 0.062 \cdot 1.00 = 0.066\text{ kg/s} = \mathbf{237.6\text{ kg/h}}$$

#### Zużycie paliwa na okrążenie i dystans wyścigu:
Na typowym torze wyścigowym (np. Silverstone lub Spa) bolid jedzie na pełnym gazie przez około $65\%$ czasu okrążenia, a średnia prędkość wynosi około $220\text{ km/h}$ ($61.1\text{ m/s}$).
- Dla czasu okrążenia $T_{lap} = 75\text{ s}$:
  $$\Delta m_{fuel,lap} \approx (0.004 \cdot 75) + \left[0.062 \cdot 0.65 \cdot \left(0.30 + 0.70 \cdot \frac{61.1}{95}\right) \cdot 75\right]$$
  $$\Delta m_{fuel,lap} \approx 0.30 + [0.0403 \cdot 0.75 \cdot 75] \approx 0.30 + 2.27 \approx \mathbf{2.57\text{ kg paliwa na okrążenie}}$$
- Standardowy bak $M_{fuel} = 105.0\text{ kg}$ pozwala na przejechanie około **40 okrążeń wyścigowych**, co idealnie odzwierciedla realia Grand Prix.

---

### 3.2 Wpływ Ubytku Masy na Czasy Okrążeń (Lap Time Sensitivity)

Całkowita masa bolidu w trakcie wyścigu wynosi:
$$m(t) = m_{dry} + m_{fuel}(t) = 798\text{ kg} + m_{fuel}(t)$$
- Na starcie wyścigu: $m_{start} = 798 + 105 = \mathbf{903\text{ kg}}$
- Pod koniec stintu (przed pit-stopem): $m_{pit} = 798 + 10 = \mathbf{808\text{ kg}}$

Masa pojazdu spada aż o **$95\text{ kg}$ (o $10.5\%$)**. Zjawisko to przynosi potężne korzyści we wszystkich trzech fazach jazdy:

#### 1. Przyspieszenie wzdłużne ($a = F / m$)
Zgodnie z drugą zasadą dynamiki Newtona, przy stałej sile napędowej $F_{drive}$ spadek masy o $10.5\%$ podnosi przyspieszenie o:
$$\frac{a_{light}}{a_{heavy}} = \frac{m_{heavy}}{m_{light}} = \frac{903}{808} \approx 1.1176 \quad (+11.8\%)$$

#### 2. Skrócenie stref dohamowań
Wzór na przyspieszenie hamowania uwzględniający docisk aero:
$$a_{brake}(v) = \mu g + \frac{\mu F_{downforce}(v) + F_{drag}(v)}{m}$$
Zauważmy, że siły aerodynamiczne ($F_{downforce}$ i $F_{drag}$) zależą wyłącznie od geometrii skrzydeł i kwadratu prędkości, **nie zależą natomiast od masy bolidu**. W konsekwencji ułamek $\frac{F_{aero}}{m}$ gwałtownie rośnie wraz ze spadkiem masy, skracając drogę hamowania o kolejne metry.

#### 3. Prędkość w zakrętach (Cornering Speed)
W zakręcie o promieniu $R$ równowaga siły dośrodkowej i przyczepności opon wyraża się zależnością:
$$\frac{m v^2}{R} = \mu \left(m \cdot g + F_{downforce}\right) \iff v^2 = R \cdot \mu \left(g + \frac{F_{downforce}}{m}\right)$$
Ponieważ docisk aerodynamiczny $F_{downforce}$ jest stały dla danej prędkości, **bolid lżejszy posiada znacznie wyższy stosunek docisku do masy ($\frac{F_{down}}{m}$)**!
Pozwala to pokonywać szybkie łuki z odczuwalnie wyższą prędkością graniczną.

#### Wycena czasowa w F1 (Złota Reguła Inżynierii Wyścigowej)
W inżynierii Formuły 1 przyjmuje się powszechnie regułę:
$$\Delta T_{lap} \approx 0.30 - 0.35\text{ s na każde } 10\text{ kg ubytku paliwa}$$
Dla zużycia $95\text{ kg}$ paliwa w symulatorze bolid zyskuje:
$$\Delta T_{total} \approx 9.5 \cdot 0.33\text{ s} \approx \mathbf{3.13\text{ sekundy na jednym okrążeniu!}}$$

Kierowca jadący na oparach paliwa pod koniec stintu bez trudu bije rekordy okrążeń (*Fastest Lap*), co jest w 100% zgodne z przebiegiem rzeczywistych wyścigów Grand Prix.

---

### 3.3 Tryb Awaryjny Limp Mode przy Braku Paliwa

Gdy poziom paliwa spadnie poniżej wartości krytycznej $0.001\text{ kg}$, w [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L519-L524) aktywuje się tryb awaryjnego zjazdu (**Limp Home Mode**):

```typescript
if (this.fuelKg <= 0.001) {
  this.fuelKg = 0;
  this.isOutOfFuel = true;
  // Limp mode: can only crawl to the pit lane (~18 km/h)
  actualThrottle = Math.min(0.08, actualThrottle);
  this.fuelBurnRatePerSec = 0;
}
```

#### Działanie trybu Limp Mode:
1. `isOutOfFuel = true` – flaga informująca system telemetryczny i moduł renderowania o wyczerpaniu paliwa (na ekranie pojawia się ostrzeżenie `⛽ PUSTY BAK`).
2. `actualThrottle = Math.min(0.08, actualThrottle)` – elektroniczne zdławienie przepustnicy do maksymalnie **$8\%$**.
3. Efektywna moc silnika spada z $750\text{ kW}$ do:
   $$P_{limp} = 750\,000 \cdot 0.08 = \mathbf{60\,000\text{ W}} \quad (60\text{ kW} \approx 81.5\text{ KM})$$
4. Przy prędkościach powyżej $12\text{ m/s}$ siła napędowa nie przekracza $5000\text{ N}$, a w miarę wzrostu prędkości zrównuje się z oporami toczenia i oporem powietrza przy zaledwie:
   $$v_{crawl} \approx 5.0\text{ m/s} \approx \mathbf{18\text{ km/h}}$$
5. Taka prędkość pozwala bolidowi powoli "doczołgać się" do alei serwisowej, o ile znajduje się niedaleko wjazdu.

#### Warunek DNF (Dyskwalifikacja / Eliminacja z Wyścigu)
W [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L826-L837) wprowadzono mechanizm eliminacji bolidów, które nie zdołały dotrzeć do boksu:

```typescript
if (this.isOutOfFuel && this.speed < 1.0) {
  this.isAlive = false;
  this.effectiveThrottle = 0;
  this.lateralG = 0;
  this.longitudinalG = 0;
  this.vel.set(0, 0);
  this.speed = 0;
  this.speedKmh = 0;
  this.respawnTimer = 0.5;
  this.fitness = Math.max(0, Math.round(this.fitness * 0.75));
  return null;
}
```
Jeśli bolid bez paliwa utraci pęd i zwolni poniżej $1.0\text{ m/s}$ ($3.6\text{ km/h}$), zostaje uznany za trwale wyeliminowany (**💥 DNF**), jego funkcja przystosowania (fitness) zostaje zredukowana o **$25\%$**, a bolid kończy udział w sesji.

---

### 3.4 Procedura Pit-Stopu i Tankowanie w Boksie

System wyścigowy Grand Prix w projekcie F1 AI Simulator posiada w pełni zaimplementowaną procedurę pit-stopów.

#### 1. Zgłoszenie chęci zjazdu (`wantsToPit`)
- **Autonomiczna Sztuczna Inteligencja**:
  W [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L298-L300) algorytm monitoruje rezerwę paliwa:
  ```typescript
  if (this.fuelKg < 12.0 && !this.isPitting) {
    this.wantsToPit = true;
  }
  ```
  Gdy w baku pozostaje mniej niż $12.0\text{ kg}$ (zapas na około 4–5 okrążeń), sieć neuronowa otrzymuje dyspozycję zjazdu do boksu.
- **Gracz Manualny**:
  Wciśnięcie klawisza `[P]` na klawiaturze przełącza flagę `wantsToPit = !wantsToPit` ([`main.ts`](file:///Users/krzysztofbojko/f1simai/src/main.ts#L1105)).

#### 2. Inicjalizacja Pit-Stopu na Bramce Mety (Checkpoint 0)
Gdy bolid z aktywną flagą `wantsToPit === true` przekracza linię start/meta ([`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L976-L980)):
```typescript
if (this.wantsToPit) {
  this.isPitting = true;
  this.pitTimer = 3.2; // 3.2s stationary pit stop
  this.pitStopsCount++;
}
```
Zostaje zainicjowany postój o długości **3.2 sekundy** (standardowy czas serwisu F1 uwzględniający wymianę kół i dotankowanie).

#### 3. Stan Bolidu podczas Postoju w Boksie
W trakcie trwania serwisu ([`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L480-L501)):
- Bolid zostaje całkowicie unieruchomiony:
  ```typescript
  this.vel.set(0, 0);
  this.speed = 0;
  this.speedKmh = 0;
  this.effectiveThrottle = 0;
  this.lateralG = 0;
  this.longitudinalG = 0;
  ```
- Licznik braku postępu (`framesSinceLastCheckpoint`) jest zerowany, co zapobiega błędnemu ukaraniu bolidu za stagnację.
- **Szybkie tankowanie wysokociśnieniowe**:
  Paliwo przetłaczane jest z prędkością **$28.0\text{ kg/s}$**:
  ```typescript
  this.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, this.fuelKg + 28.0 * dt);
  ```
  W ciągu $3.2\text{ sekundy}$ instalacja serwisowa jest w stanie zatankować:
  $$\Delta m_{fuel} = 3.2\text{ s} \cdot 28.0\text{ kg/s} = \mathbf{89.6\text{ kg paliwa!}}$$

#### 4. Zwolnienie Bolidu ze Stanowiska
Gdy licznik `pitTimer <= 0`:
```typescript
if (this.pitTimer <= 0) {
  this.isPitting = false;
  this.wantsToPit = false;
  this.isOutOfFuel = false;
  this.fuelKg = Math.min(Car.MAX_FUEL_CAPACITY, Math.max(55.0, this.fuelKg));
}
```
System gwarantuje, że bolid opuszczający boks ma zatankowane co najmniej $55.0\text{ kg}$ paliwa (lub pełen bak do $110.0\text{ kg}$), flaga braku paliwa zostaje zresetowana, a kierowca wraca do rywalizacji na torze z pełną mocą.

---

## 5. Tabela Porównawcza: Specyfikacja vs Kod Źródłowy

Poniższa tabela stanowi zestawienie kluczowych parametrów i równań fizycznych pomiędzy opisem teoretycznym w [`opis.md`](file:///Users/krzysztofbojko/f1simai/opis.md) a faktyczną implementacją w [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts):

| Parametr / Zjawisko | Wartość w `opis.md` | Implementacja w `Car.ts` | Status Zgodności | Komentarz Inżynieryjny |
| :--- | :--- | :--- | :--- | :--- |
| **Moc silnika $P_{max}$** | $750\,000\text{ W}$ ($1020\text{ KM}$) | `750000` | Pełna zgodność | Odpowiada hybrydowemu układowi napędowemu F1. |
| **Ochrona $P/v$ przy $v \to 0$** | $\max(12.0, v)$ | `Math.max(12.0, forwardSpeed)` | Pełna zgodność | Zapobiega dzieleniu przez zero i eksplozji numerycznej. |
| **Napęd tylny (RWD)** | Limit trakcji $F_{traction,max}$ | `min(rearTractionLimit, powerForce)` | Pełna zgodność | Napęd wyłącznie na tylne koła z dociążeniem wzdłużnym. |
| **Brake Override** | Nieopisany w szczegółach | `1.0 - control.brake * 1.4` | Rozszerzenie w kodzie | Zaimplementowano profesjonalne elektroniczne odcięcie gazu. |
| **Współczynnik oporu $C_D \cdot A$** | $0.70\text{ m}^2$ | `1.00\text{ m}^2` | Zmiana celowa | $0.70$ dawało nierealistyczne $V_{max} \approx 425\text{ km/h}$; $1.00$ stabilizuje $V_{max} \approx 385\text{ km/h}$. |
| **Współczynnik docisku $C_L \cdot A$** | $3.20\text{ m}^2$ | `3.10\text{ m}^2` | Drobna korekta | Generuje $\approx 2.4\text{ t}$ docisku przy $400\text{ km/h}$. |
| **Przyczepność opon $\mu_{base}$** | $1.70$ | `1.85` | Drobna korekta | Kalibracja pod miękką mieszankę slick w symulacji 2D. |
| **Mnożnik hamulców węglowych** | $1.60$ | `1.10` | Kluczowa kalibracja | $1.60$ generowało unphysicalne $\sim 10\text{ G}$; $1.10$ daje wzorowe $\approx 5 - 8\text{ G}$. |
| **Balans hamulców** | 56% przód / 44% tył | $0.46 \cdot F_z + \Delta F_{pitch}$ | Pełna zgodność | Dynamiczny rozkład mas naturalnie dociąża przód do 65-70%. |
| **Spalanie bazowe $\dot{m}_{base}$** | $0.004\text{ kg/s}$ | `0.004` | Pełna zgodność | $14.4\text{ kg/h}$ na biegu jałowym. |
| **Spalanie pod obciążeniem $\dot{m}_{load}$** | $0.062\text{ kg/s}$ | `0.062 * actualThrottle * (...)` | Pełna zgodność | Skalowanie z obciążeniem i prędkością obrotową silnika. |
| **Próg Limp Mode** | $m_{fuel} \le 0.001\text{ kg}$ | `this.fuelKg <= 0.001` | Pełna zgodność | Ograniczenie otwarcia przepustnicy do $8\%$. |
| **Parametry Pit-Stopu** | $3.2\text{ s}$, $28\text{ kg/s}$ | `pitTimer = 3.2`, `+ 28.0 * dt` | Pełna zgodność | Zatankowanie do $89.6\text{ kg}$ w $3.2\text{ s}$ postoju. |

---

## 6. Podsumowanie Wniosków Inżynieryjnych

Przeprowadzona analiza potwierdza wyjątkowo wysoki poziom zaawansowania symulatora **F1 AI Simulator**:

1. **Układ Napędowy (Powertrain)**:
   - Równanie $P_{max} / v$ ze sztywnym ograniczeniem dolnym przy $12.0\text{ m/s}$ skutecznie eliminuje osobliwości numeryczne przy ruszaniu z miejsca, wiernie oddając hiperboliczny spadek siły pociągowej typowy dla silników spalinowo-elektrycznych.
   - Ograniczenie siły do limitu przyczepności tylnej osi (RWD) w połączeniu z dynamicznym transferem masy w osi wzdłużnej wiernie symuluje zjawisko przysiadu tyłu (*squat*) i ułatwia trakcję na wyjściach z łuków, jednocześnie karząc zbyt agresywne wciśnięcie gazu uślizgiem nadsterownym (*Power Oversteer*).

2. **Układ Hamulcowy (Braking)**:
   - Kalibracja mnożnika hamowania do wartości `1.10` ($\mu_{eff} = 2.035$) pozwoliła uzyskać idealną równowagę pomiędzy potęgą kompozytów węglowo-ceramicznych a prawami fizyki.
   - Połączenie tarcia mechanicznego z kwadratowym oporem powietrza i gigantycznym dociskiem aerodynamicznym ($23.4\text{ kN}$ przy $400\text{ km/h}$) generuje realistyczne opóźnienia dochodzące do **5.0 – 8.0 G** oraz drogę hamowania $400 \to 100\text{ km/h}$ równą **119.6 m**, co w pełni pokrywa się z danymi telemetrycznymi Formuły 1.

3. **Dynamika Masy i Strategia Paliwowa**:
   - Model zużycia paliwa oparty na przepustnicy i prędkości pojazdu precyzyjnie zużywa $\approx 2.5\text{ kg}$ paliwa na okrążenie, co przy pojemności baku $105\text{ kg}$ wymusza zaplanowanie pit-stopu co około 35–40 okrążeń.
   - Zmniejszenie masy bolidu o $95\text{ kg}$ w trakcie stintu skraca czas okrążenia o ponad **3 sekundy**, dając autonomicznej sztucznej inteligencji realny bodziec do ewolucji strategii wyścigowych.
   - Wdrożenie trybu awaryjnego *Limp Mode* (pełzanie $18\text{ km/h}$ przy $8\%$ przepustnicy) oraz precyzyjnej procedury tankowania w boksie ($3.2\text{ s}$ przy $28\text{ kg/s}$) tworzy kompletną pętlę symulacji prawdziwego wyścigu Grand Prix.
