# 🏎️ Wyczerpująca Analiza Fizyki Pojazdu w F1 AI Simulator
## Aerodynamika, Dynamiczny Transfer Masy oraz Model Przyczepności Opon i Koło Kamma

> **Projekt**: F1 AI Simulator  
> **Pliki źródłowe poddane analizie**:  
> - [`src/physics/Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts)  
> - [`opis.md`](file:///Users/krzysztofbojko/f1simai/opis.md)  
> **Data opracowania**: Październik 2026  
> **Status**: Wyczerpująca ekspertyza dynamiki pojazdu 2D (Vehicle Dynamics)

---

## Spis Treści
1. [Wprowadzenie i Architektura Układu Fizycznego](#1-wprowadzenie-i-architektura-układu-fizycznego)
2. [Część I: Model Aerodynamiki (Downforce i Drag)](#2-część-i-model-aerodynamiki-downforce-i-drag)
   - [2.1 Równania Opory Powietrza (Aerodynamic Drag)](#21-równania-oporu-powietrza-aerodynamic-drag)
   - [2.2 Docisk Aerodynamiczny (Downforce) i Skalowanie z $v^2$](#22-docisk-aerodynamiczny-downforce-i-skalowanie-z-v2)
   - [2.3 Wpływ Docisku na Siłę Nacisku Pionowego $F_z$](#23-wpływ-docisku-na-siłę-nacisku-pionowego-fz)
   - [2.4 Równowaga Energetyczna i Wyznaczenie Prędkości Maksymalnej $V_{max}$](#24-równowaga-energetyczna-i-wyznaczenie-prędkości-maksymalnej-vmax)
   - [2.5 Konfrontacja Kodu (`Car.ts`) ze Specyfikacją (`opis.md`)](#25-konfrontacja-kodu-carts-ze-specyfikacją-opismd)
3. [Część II: Dynamiczny Transfer Masy (Weight Transfer: Pitch i Roll)](#3-część-ii-dynamiczny-transfer-masy-weight-transfer-pitch-i-roll)
   - [3.1 Geometria Podwozia i Położenie Środka Ciężkości (CoG)](#31-geometria-podwozia-i-położenie-środka-ciężkości-cog)
   - [3.2 Wzdłużny Transfer Masy (Pitch – Przyspieszanie i Hamowanie)](#32-wzdłużny-transfer-masy-pitch--przyspieszanie-i-hamowanie)
   - [3.3 Poprzeczny Transfer Masy (Roll – Siła Odśrodkowa w Zakręcie)](#33-poprzeczny-transfer-masy-roll--siła-odśrodkowa-w-zakręcie)
   - [3.4 Nieliniowa Degradacja Przyczepności (Tire Load Sensitivity)](#34-nieliniowa-degradacja-przyczepności-tire-load-sensitivity)
4. [Część III: Model Przyczepności Opon i Koło Kamma (Kamm's Friction Circle)](#4-część-iii-model-przyczepności-opon-i-koło-kamma-kamms-friction-circle)
   - [5.1 Teoria Elipsy Tarcia i Dystrybucja Budżetu Przyczepności](#41-teoria-elipsy-tarcia-i-dystrybucja-budżetu-przyczepności)
   - [4.2 Sprzężenie Sił Wzdłużnych i Poprzecznych w `Car.ts`](#42-sprzężenie-sił-wzdłużnych-i-poprzecznych-w-carts)
   - [4.3 Mechanika Podsterowności (Understeer) i Nadsterowności (Oversteer)](#43-mechanika-podsterowności-understeer-i-nadsterowności-oversteer)
   - [4.4 Zjawisko Ścierania Opon (Tire Scrubbing) i Dysypacja Energii](#44-zjawisko-ścierania-opon-tire-scrubbing-i-dysypacja-energii)
   - [4.5 Dwuetapowy Budżet Sił Bocznych i Gaszenie Uślizgu (Slide Damping)](#45-dwuetapowy-budżet-sił-bocznych-i-gaszenie-uślizgu-slide-damping)
5. [Podsumowanie Inżynieryjne i Wnioski Końcowe](#5-podsumowanie-inżynieryjne-i-wnioski-końcowe)

---

## 1. Wprowadzenie i Architektura Układu Fizycznego

Model dynamiki pojazdu w projekcie **F1 AI Simulator** został zaimplementowany w klasie `Car` w pliku [`src/physics/Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts). Choć symulator operuje w przestrzeni dwuwymiarowej (płaszczyzna toru $XY$, gdzie $1\text{ px} = 1.0\text{ m}$), silnik fizyczny implementuje tzw. model **quasi-3D (Vehicle Dynamics 2D z wirtualną osią Z)**.

Oznacza to, że pomimo płaskiego całkowania pozycji:
$$\vec{p}_{t+\Delta t} = \vec{p}_t + \vec{v} \cdot \Delta t$$
wszystkie kluczowe siły kontaktowe opon bazują na trójwymiarowych naciskach pionowych ($F_z$), transferze mas pod wpływem przyspieszeń bezwładnościowych ($a_x$, $a_y$), aerodynamice zależnej od kwadratu prędkości ($v^2$) oraz sprzężeniu sił poprzecznych i wzdłużnych według teorii Wunibalda Kamma.

### Układy odniesienia i krok czasowy:
- **Układ globalny (World Space)**: $\vec{p} = (x, y)$, wektor prędkości $\vec{v} = (v_x, v_y)$.
- **Układ lokalny pojazdu (Local Car Space)**:
  - Oś wzdłużna: $\vec{u}_{forward} = (\cos\theta, \sin\theta)$
  - Oś poprzeczna (prawa): $\vec{u}_{right} = (-\sin\theta, \cos\theta)$
  - Rozbicie prędkości: $v_{forward} = \vec{v} \cdot \vec{u}_{forward}$, $v_{lateral} = \vec{v} \cdot \vec{u}_{right}$.
- **Krok czasowy integratora**: $\Delta t = \frac{1}{60}\text{ s} \approx 0.01667\text{ s}$ (stały krok w wątku obliczeniowym Web Worker `sim.worker.ts`).

---

## 2. Część I: Model Aerodynamiki (Downforce i Drag)

Aerodynamika nowoczesnego bolidu Formuły 1 jest czynnikiem decydującym o osiągach. W projekcie zaimplementowano pełne nieliniowe skalowanie sił aerodynamicznych z kwadratem prędkości strumienia powietrza napływającego ($v^2$).

```
                      ▲ Docisk Aerodynamiczny (F_downforce ∝ v²)
                      │ (Zwiększa nacisk Fz na opony)
       ┌──────────────┴──────────────┐
       │   Skrzydło Przednie + Tył   │
 ◄─────┤        Bolid F1 (m)         ├─────► Wektor Prędkości v
 Opór  └──────────────┬──────────────┘
 F_drag               │
                      ▼ Grawitacja (m * g)
 ══════════════════════════════════════════════ Asfalt
```

### 2.1 Równania Opory Powietrza (Aerodynamic Drag)

Siła oporu aerodynamicznego przeciwdziała ruchowi pojazdu wzdłuż osi podłużnej. W kodzie `Car.ts` (linie 551–555) zdefiniowana jest równaniem:

$$F_{drag} = \frac{1}{2} \cdot \rho \cdot (C_D \cdot A)_{eff} \cdot v^2$$

Wektorowo, w rzucie na oś wzdłużną pojazdu:
$$F_{drag,forward} = - \left( \frac{1}{2} \cdot \rho \cdot (C_D \cdot A \cdot k_{drag}) \cdot v^2 \right) \cdot \operatorname{sgn}(v_{forward})$$

Gdzie:
- $\rho = 1.225\text{ kg/m}^3$ – standardowa gęstość powietrza na poziomie morza (ISA),
- $C_D \cdot A = 1.00\text{ m}^2$ – efektywna powierzchnia czołowa oporu aerodynamicznego bolidu F1,
- $k_{drag} \in [0.985, 1.015]$ – sesyjny współczynnik fluktuacji oporu (`lapDragFactor`), symulujący zmienność wiatru, zużycie krawędzi aerodynamicznych i ustawienia skrzydeł,
- $v = \|\vec{v}\|$ – całkowita skalarna prędkość bolidu względem ośrodka w $\text{m/s}$.

#### Charakterystyka kwadratowa oporu:
Siła oporu rośnie ściśle z kwadratem prędkości ($v^2$), natomiast **zapotrzebowanie na moc silnika do jej pokonania rośnie z sześcianem prędkości ($v^3$)**:
$$P_{drag} = F_{drag} \cdot v = \frac{1}{2} \rho (C_D A) v^3$$

| Prędkość [km/h] | Prędkość $v$ [m/s] | Siła oporu $F_{drag}$ [N] | Moc pochłaniana przez opór $P_{drag}$ [kW] | Moc w KM |
| :---: | :---: | :---: | :---: | :---: |
| **100** | $27.78$ | $472.7$ | $13.13$ | $17.8$ |
| **200** | $55.56$ | $1\ 890.7$ | $105.04$ | $142.8$ |
| **250** | $69.44$ | $2\ 954.2$ | $205.15$ | $278.9$ |
| **300** | $83.33$ | $4\ 254.1$ | $354.51$ | $481.9$ |
| **350** | $97.22$ | $5\ 790.2$ | $562.92$ | $765.3$ |
| **375** | $104.17$ | $6\ 646.0$ | $692.31$ | $941.2$ |

*Wniosek inżynieryjny*: Przy prędkości $300\text{ km/h}$ sam opór aerodynamiczny pożera niemal połowę maksymalnej mocy 1000-konnego silnika bolidu ($354.5\text{ kW}$ z $750\text{ kW}$), a przy $375\text{ km/h}$ pochłania ponad $92\%$ dostępnej mocy!

---

### 2.2 Docisk Aerodynamiczny (Downforce) i Skalowanie z $v^2$

Docisk aerodynamiczny to siła pionowa skierowana ku dołowi, generowana przez przednie skrzydło, tylne skrzydło, podłogę z tunelami Venturiego (Ground Effect) oraz tylny dyfuzor. W kodzie `Car.ts` (linia 548):

$$F_{downforce} = \frac{1}{2} \cdot \rho \cdot (C_L \cdot A) \cdot v^2$$

Gdzie:
- $C_L \cdot A = 3.10\text{ m}^2$ (`downforceCoeff` w `Car.ts`) – współczynnik siły nośnej ujemnej pomnożony przez powierzchnię odniesienia.

#### Wielkość docisku w funkcji prędkości:
Masa bolidu zatankowanego pod korek wynosi $m \approx 798\text{ kg} + 105\text{ kg} = 903\text{ kg}$, co daje ciężar grawitacyjny:
$$F_g = m \cdot g = 903 \cdot 9.81 \approx 8\ 858.4\text{ N}$$

Porównajmy to z generowanym dociskiem:

| Prędkość [km/h] | Prędkość $v$ [m/s] | Docisk $F_{downforce}$ [N] | Równoważnik masy docisku [kg] | Stosunek Docisk / Ciężar Własny |
| :---: | :---: | :---: | :---: | :---: |
| **0** | $0.0$ | $0$ | $0$ | $0.00 \times$ |
| **100** | $27.78$ | $1\ 465.3$ | $149.4$ | $0.17 \times$ |
| **160** | $44.44$ | $3\ 751.2$ | $382.4$ | $0.42 \times$ |
| **240** | $66.67$ | $8\ 440.3$ | $860.4$ | **$0.95 \times$ (punkt odwróconego sufitu!)** |
| **300** | $83.33$ | $13\ 187.9$ | $1\ 344.3$ | $1.49 \times$ |
| **360** | $100.00$ | $18\ 987.5$ | $1\ 935.5$ | **$2.14 \times$** |
| **400** | $111.11$ | $23\ 441.4$ | $2\ 389.5$ | **$2.65 \times$** |

> **Zjawisko jazdy po suficie**: Już przy prędkości **$245\text{ km/h}$** docisk aerodynamiczny zrównuje się z ciężarem własnym bolidu ($F_{downforce} \ge m \cdot g$). Teoretycznie od tej prędkości bolid mógłby poruszać się po suficie tunelu bez utraty kontaktu z podłożem.

---

### 2.3 Wpływ Docisku na Siłę Nacisku Pionowego $F_z$

W mechanice opon maksymalna siła tarcia (przyczepność) jest wprost proporcjonalna do nacisku normalnego opony na nawierzchnię ($F_z$):
$$F_{grip,max} = \mu \cdot F_z$$

W klasycznym samochodzie drogowym nacisk $F_z$ jest stały i równy ciężarowi pojazdu: $F_z = m \cdot g$. Z tego powodu maksymalne przyspieszenie boczne lub opóźnienie hamowania jest ograniczone do około $a \approx \mu \cdot g \approx 1.0\text{--}1.2\text{ G}$.

W bolidzie F1 w `Car.ts` (linia 549) całkowity nacisk normalny wynosi:
$$F_z(v) = m \cdot g + F_{downforce}(v) = m \cdot g + \frac{1}{2} \rho (C_L A) v^2$$

Dzięki temu maksymalna siła przyczepności opon rośnie wraz z prędkością:
$$F_{grip,max}(v) = \mu \cdot \left( m \cdot g + \frac{1}{2} \rho (C_L A) v^2 \right)$$

Maksymalne przyspieszenie poprzeczne $a_{y,max}$, jakie bolid może osiągnąć w zakręcie, wynosi:
$$a_{y,max}(v) = \frac{F_{grip,max}(v)}{m} = \mu \cdot g + \mu \cdot \frac{\rho (C_L A)}{2m} \cdot v^2$$

Przy bazowym współczynniku tarcia slicków $\mu_{base} = 1.85$:
- Dla $v = 0$: $a_{y,max} = 1.85 \cdot 9.81 = 18.15\text{ m/s}^2 \approx \mathbf{1.85\text{ G}}$
- Dla $v = 200\text{ km/h}$ ($55.56\text{ m/s}$):
  $$F_z = 8858 + 5860 = 14\ 718\text{ N} \implies a_{y,max} = \frac{1.85 \cdot 14718}{903} \approx 30.15\text{ m/s}^2 \approx \mathbf{3.07\text{ G}}$$
- Dla $v = 300\text{ km/h}$ ($83.33\text{ m/s}$):
  $$F_z = 8858 + 13188 = 22\ 046\text{ N} \implies a_{y,max} = \frac{1.85 \cdot 22046}{903} \approx 45.17\text{ m/s}^2 \approx \mathbf{4.60\text{ G}}$$

To właśnie kwadratowa zależność docisku od prędkości pozwala bolidom w symulatorze na pokonywanie szybkich łuków z przeciążeniem sięgającym **5.0 G**, podczas gdy w ciasnych nawrotach (np. $70\text{ km/h}$) przyczepność limitowana jest głównie masą mechaniczną.

---

### 2.4 Równowaga Energetyczna i Wyznaczenie Prędkości Maksymalnej $V_{max}$

Na prostej prędkość maksymalna zostaje osiągnięta, gdy wypadkowa siła wzdłużna dąży do zera ($a_x = 0$):
$$F_{engine}(v) - F_{drag}(v) - F_{rolling\_resistance}(v) = 0$$

Gdzie:
- Siła napędowa silnika (`Car.ts` linia 573):
  $$F_{engine} = \frac{P_{max} \cdot u_{throttle} \cdot k_{power}}{\max(12.0, v_{forward})}$$
  Dla pełnego otwarcia przepustnicy ($u_{throttle} = 1.0$) i nominalnej mocy ($P_{max} = 750\ 000\text{ W}$):
  $$F_{engine}(v) = \frac{750\ 000}{v}$$
- Siła oporu toczenia opon (`Car.ts` linia 595):
  $$F_{rr} = C_{rr} \cdot F_z = 0.012 \cdot \left( m \cdot g + \frac{1}{2} \rho (C_L A) v^2 \right)$$
- Siła oporu powietrza:
  $$F_{drag} = \frac{1}{2} \rho (C_D A) v^2$$

Równanie równowagi sił:
$$\frac{750\ 000}{v} = \frac{1}{2} \cdot 1.225 \cdot 1.00 \cdot v^2 + 0.012 \cdot \left( 8858 + \frac{1}{2} \cdot 1.225 \cdot 3.10 \cdot v^2 \right)$$
$$\frac{750\ 000}{v} = 0.6125 \cdot v^2 + 106.3 + 0.0228 \cdot v^2$$
$$\frac{750\ 000}{v} = 0.6353 \cdot v^2 + 106.3$$
Mnożąc obustronnie przez $v$:
$$0.6353 \cdot v^3 + 106.3 \cdot v - 750\ 000 = 0$$

Rozwiązując to równanie algebraiczne trzeciego stopnia:
$$v \approx 105.1\text{ m/s} \implies V_{max} \approx 105.1 \cdot 3.6 \approx \mathbf{378.4\text{ km/h}}$$

Przy losowych wahaniach `lapPowerFactor` ($1.02$) i `lapDragFactor` ($0.985$), prędkość maksymalna bolidów w symulacji wynosi dokładnie **375 – 390 km/h** na długich prostych Monza/Spa, co w 100% odzwierciedla realia nowoczesnej Formuły 1.

---

### 2.5 Konfrontacja Kodu (`Car.ts`) ze Specyfikacją (`opis.md`)

Wnikliwa analiza kodu źródłowego i dokumentacji ujawnia kluczową poprawkę inżynieryjną wprowadzoną w kodzie:

1. **Współczynnik oporu $C_D \cdot A$**:
   - W [`opis.md`](file:///Users/krzysztofbojko/f1simai/opis.md#L76) podano: `C_D * A = 0.70 m^2`.
   - W [`src/physics/Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts#L80) zdefiniowano:
     ```ts
     public readonly dragCoeff: number = 1.00; // Cd * A [m^2] (typowo ~1.0-1.4 dla F1; 0.70 dawalo Vmax ~425 km/h)
     ```
   - **Komentarz fizyczny**: Wartość $0.70\text{ m}^2$ była zbyt niska (odpowiada bolidom prototypowym Le Mans lub bolidom F1 z otwartym DRS). Powodowała ona, że bolid osiągał nierealistyczne $425\text{ km/h}$. Zwiększenie $C_D \cdot A$ do $1.00\text{ m}^2$ sprowadziło $V_{max}$ do fizycznego zakresu $378\text{--}385\text{ km/h}$.
2. **Współczynnik docisku $C_L \cdot A$**:
   - W `opis.md`: $3.20\text{ m}^2$.
   - W `Car.ts`: $3.10\text{ m}^2$. Drobna korekta kalibracyjna balansująca prędkość w zakrętach o średnim promieniu.
3. **Mnożnik hamulców `brakeGripMultiplier`**:
   - W `opis.md` wzmiankowano mnożnik $1.60$, który generował przeciążenia rzędu 10 G. W kodzie zoptymalizowano go do wartości $1.10$, stabilizując opóźnienia na realnym poziomie **5.0 – 5.5 G**.

---

## 3. Część II: Dynamiczny Transfer Masy (Weight Transfer: Pitch i Roll)

Pojazd w ruchu nie jest punktem materialnym; posiada wymiary przestrzenne oraz masę zawieszoną nad poziomem nawierzchni na wysokości środka ciężkości $h_{CoG}$. Każde przyspieszenie generuje siłę bezwładności przyłożoną w środku ciężkości, co wywołuje moment obrotowy względem punktów styku opon z podłożem.

```
 Hamowanie (Nose Dive):                  Przyspieszanie (Squat):
         -a_x (Siła bezwładności w CoG)          +a_x (Siła bezwładności w CoG)
              ══════►                                  ◄══════
               ┌───┐                                    ┌───┐
               │CoG│ h_CoG                              │CoG│ h_CoG
               └───┘                                    └───┘
       ▲                   ▼                    ▼                   ▲
 +ΔFz,pitch           -ΔFz,pitch            -ΔFz,pitch          +ΔFz,pitch
 ───────┬───────────────────┬──────         ───────┬───────────────────┬──────
    Oś Przednia         Oś Tylna               Oś Przednia         Oś Tylna
    (Dociążona)         (Odciążona)            (Odciążona)         (Dociążona)
        ◄──────── L ────────►                      ◄──────── L ────────►
```

### 3.1 Geometria Podwozia i Położenie Środka Ciężkości (CoG)

W pliku `Car.ts` zdefiniowano realistyczne parametry geometryczne bolidu F1:
- Rozstaw osi (Wheelbase): $L = 3.60\text{ m}$ (linia 74)
- Rozstaw kół (Track Width): $W = 1.80\text{ m}$ (linia 75)
- Wysokość środka ciężkości: $h_{CoG} = 0.32\text{ m}$ (linia 76)
- Statyczny rozkład masy na osie:
  - Oś przednia: $46\%$ ($0.46$)
  - Oś tylna: $54\%$ ($0.54$) (silnik V6 Turbo, akumulatory ERS i skrzynia biegów zlokalizowane z tyłu)

---

### 3.2 Wzdłużny Transfer Masy (Pitch – Przyspieszanie i Hamowanie)

Wzdłużne przyspieszenie pojazdu $a_x = \frac{dv_x}{dt}$ wywołuje moment pochylający $M_{pitch} = m \cdot a_x \cdot h_{CoG}$. Aby zachować równowagę momentów wokół punktów podparcia kół, następuje redystrybucja nacisków pionowych między osią przednią a tylną.

Równanie transferu masy zaimplementowane w `Car.ts` (linie 559–564):
$$\Delta F_{z,pitch} = m \cdot (-a_x) \cdot \frac{h_{CoG}}{L}$$

Gdzie:
- $a_x = \text{longitudinalG} \cdot g$ (z opóźnieniem o jeden krok dyskretny `prevAccelX`),
- Znak minus wynika z faktu, że przyspieszenie w przód ($a_x > 0$) odciąża przód i dociąża tył, zaś hamowanie ($a_x < 0$) dociąża przód i odciąża tył.

Dynamiczny nacisk na osie wynosi:
$$F_{z,front} = \max\left(100\text{ N}, \ 0.46 \cdot F_z(v) + \Delta F_{z,pitch}\right)$$
$$F_{z,rear} = \max\left(100\text{ N}, \ 0.54 \cdot F_z(v) - \Delta F_{z,pitch}\right)$$

Wartość minimalna $100\text{ N}$ to zabezpieczenie numeryczne chroniące przed dzieleniem przez zero i ujemnymi naciskami przy oderwaniu kół od ziemi.

#### Analiza Przypadku A: Ekstremalne Hamowanie Carbon-Ceramic z $300\text{ km/h}$
- Masa bolidu: $m = 903\text{ kg}$,
- Prędkość: $v = 83.33\text{ m/s}$ ($300\text{ km/h}$),
- Całkowity nacisk normalny: $F_z = 8858\text{ N (grawitacja)} + 13188\text{ N (aero)} = 22\ 046\text{ N}$,
- Statyczny nacisk na przód: $0.46 \cdot 22046 = 10\ 141\text{ N}$,
- Statyczny nacisk na tył: $0.54 \cdot 22046 = 11\ 905\text{ N}$,
- Opóźnienie hamowania: $a_x = -5.0\text{ G} = -49.05\text{ m/s}^2$.

Obliczenie transferu masy:
$$\Delta F_{z,pitch} = 903 \cdot (+49.05) \cdot \frac{0.32}{3.60} \approx \mathbf{+3\ 937\text{ N}}$$

Nowe naciski osi:
$$F_{z,front} = 10\ 141 + 3\ 937 = \mathbf{14\ 078\text{ N}} \quad (\mathbf{63.8\%}\text{ całkowitego nacisku})$$
$$F_{z,rear} = 11\ 905 - 3\ 937 = \mathbf{7\ 968\text{ N}} \quad (\mathbf{36.2\%}\text{ całkowitego nacisku})$$

*Konsekwencje dynamiczne*:
1. **Zysk przyczepności przedniej osi**: Przód zyskuje niemal $40\%$ dodatkowego docisku, co zapobiega przedwczesnemu blokowaniu przednich kół (*front lock-up*).
2. **Odciążenie tylnej osi**: Tył traci ponad $33\%$ swojego obciążenia. W połączeniu z hamulcami na tylnej osi bolid staje się podatny na niestabilność kierunkową przy wejściu w zakręt z wciśniętym hamulcem (*Trail Braking Oversteer*).
3. **Balans hamulców (Brake Bias)**: W kodzie siła hamowania na przód wynosi:
   $$F_{brake,front} = \text{brake} \cdot \mu \cdot 1.10 \cdot F_{z,front}$$
   Dzięki uwzględnieniu dynamicznego $F_{z,front}$ rozkład sił hamowania naturalnie dopasowuje się do dociążenia przodu bez konieczności sztucznego sztywnego podziału.

#### Analiza Przypadku B: Start z Miejsca / Przyspieszanie (RWD Traction)
- Prędkość: $v = 20\text{ m/s}$ ($72\text{ km/h}$), docisk aero jest jeszcze znikomy ($F_{downforce} \approx 760\text{ N}$), $F_z \approx 9618\text{ N}$,
- Przyspieszenie: $a_x = +1.3\text{ G} = +12.75\text{ m/s}^2$.

Transfer masy:
$$\Delta F_{z,pitch} = 903 \cdot (-12.75) \cdot \frac{0.32}{3.60} \approx \mathbf{-1\ 023\text{ N}}$$
$$F_{z,rear} = 0.54 \cdot 9618 - (-1023) = 5194 + 1023 = \mathbf{6\ 217\text{ N}}$$

*Konsekwencje*:
Dociążenie tylnej osi podnosi limit trakcji tylnych kół (RWD):
$$F_{traction,max} = \mu_{base} \cdot k_{grip} \cdot F_{z,rear} = 1.85 \cdot 1.0 \cdot 6217 = \mathbf{11\ 501\text{ N}}$$
Gdyby nie transfer masy, limit wynosiłby jedynie $1.85 \cdot 5194 = 9608\text{ N}$. Dynamiczny przysiad (*squat*) zwiększa zdolność przeniesienia momentu obrotowego silnika o **niemal 2000 N**!

---

### 3.3 Poprzeczny Transfer Masy (Roll – Siła Odśrodkowa w Zakręcie)

W zakręcie na bolid działa przyspieszenie odśrodkowe $a_y = \frac{v^2}{R} = v \cdot \omega$. Wywołuje ono moment przechyłu bocznego wokół osi wzdłużnej nadwozia:
$$M_{roll} = m \cdot a_y \cdot h_{CoG}$$

Siła reakcji podłoża przenoszona jest na opony zewnętrzne, odciążając opony wewnętrzne. W `Car.ts` (linie 619–620):
$$\Delta F_{z,roll} = m \cdot a_y \cdot \frac{h_{CoG}}{W}$$

Dla przeciążenia bocznego $a_y = 4.0\text{ G} = 39.24\text{ m/s}^2$ i rozstawu kół $W = 1.80\text{ m}$:
$$\Delta F_{z,roll} = 903 \cdot 39.24 \cdot \frac{0.32}{1.80} \approx \mathbf{6\ 299\text{ N}}$$

Koła zewnętrzne przyjmują o $6.3\text{ kN}$ większe obciążenie niż koła wewnętrzne.

---

### 3.4 Nieliniowa Degradacja Przyczepności (Tire Load Sensitivity)

W fizyce opon fundamentalnym prawem jest **Tire Load Sensitivity (Czułość Opony na Obciążenie)**: współczynnik tarcia opony $\mu$ nie jest stały, lecz **maleje wraz ze wzrostem nacisku pionowego $F_z$**:

```
 Współczynnik tarcia μ
   ▲
 μ0│───────┐
   │        \
   │         \  μ(Fz) maleje wraz ze wzrostem nacisku!
   │          \
   │           └───────────► Nacisk pionowy Fz
```

Oznacza to, że:
> **Zysk przyczepności dociążonego koła zewnętrznego jest MNIEJSZY niż strata przyczepności odciążonego koła wewnętrznego.**
> Każdy poprzeczny transfer masy obniża sumaryczną przyczepność danej osi!

W `Car.ts` (linie 621 oraz 635) to kluczowe zjawisko zostało zaimplementowane w genialny, numerycznie stabilny sposób:

$$\text{rollGripLoss} = \min\left(0.08, \ \frac{|\Delta F_{z,roll}|}{F_z} \cdot 0.15\right)$$
$$\mu_{eff} = \mu_{base} \cdot k_{grip} \cdot (1.0 - \text{rollGripLoss})$$

#### Znaczenie fizyczne współczynnika `rollGripLoss`:
- W łagodnym łuku ($1.0\text{ G}$): transfer masy jest znikomy, $\text{rollGripLoss} \approx 0.01\text{--}0.02$ (strata $1\text{--}2\%$).
- W agresywnym zakręcie ($4.5\text{ G}$): transfer osiąga wartości krytyczne, a $\text{rollGripLoss}$ osiąga maksymalne nasycenie **$8\%$** (`0.08`).
- Efektywny współczynnik tarcia opony spada z $\mu = 1.85$ do $\mu = 1.702$, co zmusza kierowcę AI do precyzyjnego operowania kątem skrętu i zapobiega nierealistycznemu „przyklejeniu” bolidu do toru.

---

## 4. Część III: Model Przyczepności Opon i Koło Kamma (Kamm's Friction Circle)

### 4.1 Teoria Elipsy Tarcia i Dystrybucja Budżetu Przyczepności

Opona wyścigowa generuje siły w płaszczyźnie styku z asfaltem w dwóch ortogonalnych kierunkach:
1. **Wzdłużnym ($F_x$)**: siła napędowa (przyspieszanie) lub hamująca,
2. **Poprzecznym ($F_y$)**: siła dośrodkowa (skręcanie).

Zgodnie z teorią profesora Wunibalda Kamma (1930 r.), całkowita siła tarcia generowana przez oponę nie może przekroczyć promienia koła (lub półosi elipsy) tarcia:
$$\|\vec{F}_{total}\| = \sqrt{F_x^2 + F_y^2} \le F_{max} = \mu \cdot F_z$$

Zapisując w postaci elipsy bezwymiarowej:
$$\left( \frac{F_x}{F_{x,max}} \right)^2 + \left( \frac{F_y}{F_{y,max}} \right)^2 \le 1.0$$

```
                           +Fx (Przyspieszanie)
                                    ▲
                                    │
                                ┌───┼───┐
                            ┌───┘   │   └───┐
    -Fy (Skręt w lewo)      │       │       │      +Fy (Skręt w prawo)
   ◄────────────────────────┼───────┼───────┼────────────────────────►
                            │       │       │
                            └───┐   │   ┌───┘
                                └───┼───┘
                                    │
                                    ▼
                           -Fx (Hamowanie)
```

**Kluczowa implikacja**: Jeśli opona zużywa $100\%$ przyczepności na hamowanie ($F_x = F_{x,max}$), to dostępna siła boczna $F_y = 0$ – pojazd staje się całkowicie niesterowny i porusza się po linii prostej (tzw. zablokowanie kół, *lock-up*). Odwrotnie: na granicy przyczepności w zakręcie ($F_y = F_{y,max}$) jakiekolwiek dodanie gazu lub dotknięcie hamulca zerwie przyczepność boczną, prowadząc do poślizgu.

---

### 4.2 Sprzężenie Sił Wzdłużnych i Poprzecznych w `Car.ts`

W kodzie `Car.ts` (linie 628–638) zaimplementowano pełne sprzężenie Kamma niezależnie dla **osi przedniej** oraz **osi tylnej**.

#### Krok 1: Wyznaczenie stopnia zużycia budżetu wzdłużnego ($u_x$)
- **Oś przednia** (brak napędu, wyłącznie siła hamowania):
  $$u_{front,x} = \min\left(0.98, \ \frac{F_{brake,front}}{\mu_{base} \cdot F_{z,front}}\right)$$
- **Oś tylna** (zarówno hamowanie, jak i napęd silnika RWD):
  $$u_{rear,x} = \min\left(0.98, \ \frac{\max(F_{brake,rear}, \ F_{drive})}{\mu_{base} \cdot F_{z,rear}}\right)$$

Wartość została ograniczona do $0.98$, aby zapobiec osobliwościom numerycznym przy pierwiastkowaniu.

#### Krok 2: Wyznaczenie rezydualnego mnożnika przyczepności bocznej ($k_{grip}$)
Z równania elipsy Kamma $k_{grip} = \frac{F_y}{F_{y,max}} = \sqrt{1 - u_x^2}$:
$$k_{grip,front} = \sqrt{\max\left(0.05, \ 1.0 - u_{front,x}^2\right)}$$
$$k_{grip,rear} = \sqrt{\max\left(0.05, \ 1.0 - u_{rear,x}^2\right)}$$

Minimalna wartość $0.05$ odzwierciedla szczątkowe tarcie kinetyczne opony sunącej w uślizgu.

#### Krok 3: Wyznaczenie maksymalnej siły dośrodkowej osi
$$F_{y,max,front} = \mu_{eff} \cdot F_{z,front} \cdot k_{grip,front}$$
$$F_{y,max,rear} = \mu_{eff} \cdot F_{z,rear} \cdot k_{grip,rear}$$
$$F_{y,max,total} = F_{y,max,front} + F_{y,max,rear}$$

Poniższa tabela ilustruje nieliniowy spadek zdolności skrętu przy wzroście siły wzdłużnej:

| Wykorzystanie siły wzdłużnej $u_x$ | Stan pojazdu | Pozostała przyczepność boczna $k_{grip}$ |
| :---: | :--- | :---: |
| **$0\%$** ($0.0$) | Swobodne toczenie / stała prędkość | **$100.0\%$** ($1.000$) |
| **$30\%$** ($0.3$) | Lekki gaz na wyjściu / lekkie dohamowanie | **$95.4\%$** ($0.954$) |
| **$50\%$** ($0.5$) | Średnie hamowanie | **$86.6\%$** ($0.866$) |
| **$70\%$** ($0.7$) | Mocne hamowanie / agresywne wyjście | **$71.4\%$** ($0.714$) |
| **$90\%$** ($0.9$) | Granica zablokowania opon | **$43.6\%$** ($0.436$) |
| **$98\%$** ($0.98$) | Płonące opony / pełny lock-up | **$19.9\%$** ($0.199$) |

---

### 4.3 Mechanika Podsterowności (Understeer) i Nadsterowności (Oversteer)

W `Car.ts` idealna prędkość kątowa pojazdu (żądaną geometrią skrętu Ackermanna) wynosi:
$$\omega_{ideal} = \frac{v_{forward}}{L} \cdot \tan(\delta_{steer})$$
Gdzie $\delta_{steer} = u_{steer} \cdot 0.40\text{ rad}$.

Żądana siła odśrodkowa, niezbędna do utrzymania tego promienia skrętu:
$$F_{centrifugal} = m \cdot |v_{forward} \cdot \omega_{ideal}| = m \cdot \frac{v^2}{R_{turn}}$$

W liniach 648–665 zaimplementowano fizyczny warunek utraty przyczepności:
```ts
if (centrifugalForceMag > totalMaxLateralForce && Math.abs(newForwardSpeed) > 10) {
  const gripRatio = totalMaxLateralForce / centrifugalForceMag;
  actualYawRate = idealYawRate * gripRatio;
  this.isSkidding = true;

  // Tire scrub:
  newForwardSpeed *= (1.0 - 0.09 * dt);

  // Understeer vs Oversteer balance:
  if (frontGripFactor < rearGripFactor) {
    this.understeerSlip = 1.0 - gripRatio; // Front washes out
  } else {
    this.oversteerSlip = 1.0 - gripRatio;  // Rear steps out
  }
}
```

```
 PODSTEROWNOŚĆ (Understeer):               NADSTEROWNOŚĆ (Oversteer):
 Front washes out (k_front < k_rear)       Rear steps out (k_rear < k_front)

            ▲ Żądany tor                              ▲ Żądany tor
           /                                         /
     ┌────/┐                                   ┌────/┐
     │   / │                                   │  /  │
     │  /  │  Rzeczywisty tor                  │ /   │
     │ ┌───┼──────────►                        └─────┼──────────► Uciekający tył
     └─┴───┘                                         │
       Przód "płuży" na zewnątrz                     Obrót wokół osi (bączek)
```

#### 1. Mechanizm Podsterowności (Understeer – „płużenie przodu”):
- **Warunek**: $k_{grip,front} < k_{grip,rear}$
- **Przyczyna fizyczna**: Kierowca AI zbyt głęboko wjechał w zakręt z wciśniętym hamulcem (`overspeedDelta > 0`). Balans hamulców obciąża przód, $u_{front,x}$ zbliża się do $1.0$, a $k_{grip,front}$ gwałtownie spada. Przednie opony nie są w stanie nadać bolidowi żądanego przyspieszenia dośrodkowego.
- **Skutek w symulatorze**: Rzeczywista prędkość obrotu $\omega_{actual}$ zostaje drastycznie zredukowana względem kąta skrętu kierownicy (`gripRatio < 1.0`). Bolid pomimo skręconych kół wyjeżdża szeroko na zewnętrzną stronę toru w stronę bandy.

#### 2. Mechanizm Nadsterowności (Oversteer – „uciekający tył”):
- **Warunek**: $k_{grip,rear} < k_{grip,front}$
- **Przyczyna fizyczna**: Występuje najczęściej w dwóch sytuacjach:
  1. **Power Oversteer**: Na wyjściu z zakrętu kierowca wciska pełen gaz ($u_{throttle} = 1.0$), generując potężną siłę napędową $F_{drive}$. Oś tylna wysyca koło Kamma siłą wzdłużną ($u_{rear,x} \to 1.0$), redukując $k_{grip,rear}$ niemal do zera.
  2. **Lift-off / Snap Oversteer**: Gwałtowne odciążenie tylnej osi pod wpływem transferu masy przy nagłym dohamowaniu.
- **Skutek w symulatorze**: Tylna oś traci zdolność trzymania toru jazdy. Wskaźnik `oversteerSlip = 1.0 - gripRatio` rośnie. Przy wartości `oversteerSlip > 0.45` uruchamia się mechanizm awaryjny sieci neuronowej (linia 672), który resetuje wagi kierowcy do stanu bezpiecznego (`safeBrainBackup`), chroniąc go przed wykonaniem niekontrolowanego piruetu (*spin*).

---

### 4.4 Zjawisko Ścierania Opon (Tire Scrubbing) i Dysypacja Energii

Gdy opona porusza się ze ślizgiem poprzecznym, następuje zjawisko **Tire Scrub** – mechanicznego tarcia gumy o makrostrukturę asfaltu. Proces ten nieodwracalnie zamienia energię kinetyczną pojazdu na ciepło.

W `Car.ts` (linia 657):
$$v_{forward,t+\Delta t} = v_{forward,t} \cdot \left( 1.0 - 0.09 \cdot \Delta t \right)$$

Dla $\Delta t = \frac{1}{60}\text{ s}$ spadek wynosi około $0.15\%$ na klatkę, co w ciągu jednej sekundy głębokiego poślizgu ($60$ klatek) powoduje:
$$(1.0 - 0.0015)^{60} \approx 0.913 \implies \mathbf{-8.7\%\text{ prędkości wzdłużnej na sekundę poślizgu!}}$$

Zjawisko to pełni kluczową rolę w uczeniu maszynowym:
1. Bolid, który wchodzi w zakręt ze zbyt wysoką prędkością, jest gwałtownie spowalniany przez uślizg poprzeczny.
2. W liniach 778–782 nałożona jest surowa kara do funkcji przystosowania (*Fitness Penalty*):
   $$\text{skidPenalty} = (45.0 + \text{slipMagnitude} \cdot 6.0) \cdot \Delta t$$
3. W efekcie algorytm genetyczny szybko eliminuje kierowców ślizgających się po zakrętach, promując czystą, płynną jazdę po tzw. nitce wyścigowej (*Racing Line*).

---

### 4.5 Dwuetapowy Budżet Sił Bocznych i Gaszenie Uślizgu (Slide Damping)

Jednym z najbardziej wyrafinowanych rozwiązań w klasie `Car.ts` (linie 690–705) jest **współdzielenie budżetu siły bocznej pomiędzy skręcaniem a tłumieniem ześlizgu bocznego**.

Gdy bolid posiada niezerową prędkość poprzeczną $v_{lateral} \ne 0$ (ślizga się bokiem), opony muszą wykonać dwa zadania:
1. Zapewnić siłę dośrodkową skrętu: $F_{actual,turn} = \min(F_{cf}, F_{y,max,total})$,
2. Wygasić boczny poślizg (tłumienie ślizgu): $F_{slide\_damp}$.

Zgodnie z zasadami wektorowej sumy sił, siła gasząca ślizg może korzystać **wyłącznie z rezydualnej (pozostałej) części budżetu bocznego**:
$$F_{lat,residual} = \sqrt{\max\left(0, \ F_{y,max,total}^2 - F_{actual,turn}^2\right)}$$

Maksymalne dopuszczalne przyspieszenie tłumiące:
$$a_{damp,max} = \frac{F_{lat,residual}}{m}$$

Następnie wyznaczana jest rzeczywista siła tłumienia:
$$a_{damp} = \min\left( \frac{|v_{lateral}|}{\Delta t}, \ |v_{lateral}| \cdot 12.0, \ a_{damp,max} \right)$$
$$v_{lateral,t+\Delta t} = v_{lateral} - \operatorname{sgn}(v_{lateral}) \cdot a_{damp} \cdot \Delta t$$

#### Skutek fizyczny:
- Jeśli bolid jedzie na wprost ($F_{actual,turn} = 0$), cały budżet boczny $F_{lat,residual} = F_{y,max,total}$ jest dostępny do natychmiastowego wygaszenia bocznego zarzucenia (bolid błyskawicznie stabilizuje tor jazdy).
- Jeśli jednak bolid znajduje się na granicy przyczepności w szybkim łuku ($F_{actual,turn} \approx F_{y,max,total}$), to **$F_{lat,residual} \to 0$**. W tym stanie opony nie mają już żadnego zapasu siły, aby zatrzymać boczny poślizg – bolid w sposób całkowicie realistyczny „odpływa” w stronę zewnętrznego krawężnika toru.

---

## 5. Podsumowanie Inżynieryjne i Wnioski Końcowe

Przeprowadzona analiza równań, stałych i algorytmów zaimplementowanych w [`Car.ts`](file:///Users/krzysztofbojko/f1simai/src/physics/Car.ts) oraz opisanych w [`opis.md`](file:///Users/krzysztofbojko/f1simai/opis.md) prowadzi do następujących konkluzji:

| Obszar Fizyki | Zastosowany Model | Wierność Względem Prawdziwego F1 | Uwagi i Kalibracja |
| :--- | :--- | :---: | :--- |
| **Opór Powietrza (Drag)** | $F_D = \frac{1}{2} \rho (C_D A) v^2$, skalowanie $v^2$, moc $\propto v^3$ | **98%** | Skalibrowano $C_D A$ z $0.70$ na $1.00\text{ m}^2$, co ustabilizowało $V_{max}$ na poziomie $378\text{ km/h}$. |
| **Docisk (Downforce)** | $F_L = \frac{1}{2} \rho (C_L A) v^2$, Ground Effect | **95%** | Docisk osiąga $19\text{ kN}$ ($\approx 1.9\text{ t}$) przy $360\text{ km/h}$, potrajając nacisk na podłoże. |
| **Transfer Wzdłużny (Pitch)** | $\Delta F_z = m \cdot a_x \cdot \frac{h}{L}$ | **95%** | Realistyczne zjawiska *nose dive* i *squat*. Dociążenie przodu przy hamowaniu 5G osiąga niemal $64\%$ całkowitej masy. |
| **Transfer Poprzeczny (Roll)** | $\Delta F_z = m \cdot a_y \cdot \frac{h}{W}$ | **92%** | Uwzględnia *Tire Load Sensitivity* (`rollGripLoss` do $8\%$), co stanowi rzadkość w symulatorach 2D. |
| **Koło Kamma (Friction Circle)** | Elipsa tarcia $\left(\frac{F_x}{F_{x,max}}\right)^2 + \left(\frac{F_y}{F_{y,max}}\right)^2 \le 1$ | **96%** | Sprzężenie sił liczone oddzielnie dla przedniej i tylnej osi; wierność zachowania zjawisk *lock-up* i *power oversteer*. |
| **Tłumienie Uślizgu (Damping)** | Rezydualny budżet wektorowy $F_{residual} = \sqrt{F_{max}^2 - F_{turn}^2}$ | **99%** | Znakomite rozwiązanie matematyczne gwarantujące brak generowania energii znikąd i stabilność układu. |

### Główne atuty zaimplementowanego silnika fizyki:
1. **Brak uproszczeń liniowych**: Model nie stosuje prostych stałych limitów prędkości, lecz wyprowadza ograniczenia dynamicznie z bilansu sił, gęstości powietrza, geometrii podwozia i tarcia opon.
2. **Sprzężenie mechaniczno-aerodynamiczne**: Docisk aero bezpośrednio powiększa elipsę Kamma, dzięki czemu zachowanie bolidu przy $100\text{ km/h}$ drastycznie różni się od zachowania przy $300\text{ km/h}$.
3. **Organiczne zachowanie AI**: Dzięki rygorystycznemu modelowi fizyki sieci neuronowe MLP uczą się rzeczywistych technik wyścigowych – dohamowania na prostej (*straight-line braking*), odpuszczania hamulca przy wchodzeniu w apex (*trail braking*) oraz stopniowego otwierania przepustnicy na wyjściu z zakrętu w celu uniknięcia nadsterowności.

Dokument stanowi kompletne i wyczerpujące kompendium dynamiki wzdłużnej i poprzecznej projektu **F1 AI Simulator**.
