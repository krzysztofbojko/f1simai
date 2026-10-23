## 📄 Audyt Systemu Symulacji Wyścigowej Bolidów F1 (F1 Car Simulation Audit Report)

**Do:** Zespół Inżynierii Simu
**Od:** Model Językowy AI
**Data:** [Aktualna data]
**Temat:** Dogłębna analiza luk fizycznych, logistycznych i dynamicznych w modelowaniu bolidów F1.

***

Niniejszy raport stanowi kompleksową analizę architektury symulacyjnej opartej na treściach `PHYSICS.md`, `Traffic.ts` oraz `Car.ts`. System jest zaawansowany, łącząc elementy fizyki objawowej (LOD), uczenia maszynowego i skomplikowanej logiki zarządzania zasobami (ERS/Opony). Audyt skupia się na identyfikacji potencjalnych luk, niekonsekwencji lub obszarów do pogłębienia, które mogą wpłynąć na realizm symulacji.

---

### I. Model Fizyczny i Dynamika Pojazdu (Physics & Dynamics)

#### 🚧 Luka 1: Uproszczone modelowanie zawieszenia i prześwitu (Ride Height Aero)
*   **Kontekst:** Obliczanie docisku na podstawie stałych sztywności osi (`AXLE_STIFFNESS_FRONT/REAR`) oraz funkcjonalności `rideHeightLift` jest quasi-statyczne. Pominięcie zawieszenia 3-DOF, dobijania deski czy morświnowania z założenia upraszcza mechanikę kosztem realistycznego zachowania docisku w bardzo dynamicznych manewrach (np. szybkie hamowanie na nierównym terenie).
*   **Sugestia naprawcza:** Wprowadzenie modelowania prześwitu, które jest funkcją nie tylko sił normalnych osi, ale także prędkości pionowej (Vertical Velocity) i ciśnienia podwozia (Ground Pressure Map), co pozwoli symulować dynamiczne "zapadanie" się pojazdu w zakrętach oraz wzrost oporu przy niemal kontakcie z nawierzchnią.

#### 🌬️ Luka 2: Interakcja aerodynamiczna poza prostej linii lotu (Airflow/Drag)
*   **Kontekst:** Opór ($C_d \cdot A$) działa na cały wektor prędkości, co jest standardowym uproszczeniem. Jednakże model nie uwzględnia dynamicznych efektów aerodynamiki w zależności od kąta natarcia ($\alpha$) lub ślabstwa (Yaw) przy dużych zwalnianiu/wyprzedzaniu (*flow separation*).
*   **Sugestia naprawcza:** Dodanie współczynnika aerodynamicznego $C_d$ i $C_l$ zależnego od kąta natarcia i prędkości względnej w stosunku do nieruchomego powietrza, co jest kluczowe przy dynamicznych zmianach toru.

#### ⚙️ Luka 3: Modele trakcji są zbyt idealne (Tire Slip / Cornering)
*   **Kontekst:** Siły boczne na osiach (`frontLateral`, `rearLateral`) wynikają z kombinacji modelu $\tanh$ i zaawansowanego modelu jednośladu. Przy jednakowym wykorzystaniu sił bocznych może dojść do niefizycznego przenoszenia momentów bez uwzględnienia, że czysta trakcja zależy od lokalnie dostępnego $\mu$ oraz obciążenia w danym punkcie opony.
*   **Sugestia naprawcza:** Ulepszenie rozdzielania siły boczne (Lateral Force) na poszczególne osie na podstawie: 1) proporcjonalności do docisku ($F_z$), 2) geometrycznej lokalizacji w korytarzu jazdy, oraz uwzględnienie współczynnika trakcji zależnego od kąta nadprzemiarowości.

#### 🔋 Luka 4: Model zarządzania energią ERS (Regeneracja/Trakcja)
*   **Kontekst:** Zasady regeneracji są dobrze określone. Problem pojawia się przy zderzeniu mocy elektrycznej i mechanicznej brakuje precyzyjnego modelowania **różnicy sił momentalnych**. Przy silnym hamowaniu (MGU-K) powinna występować dynamiczna reakcja systemu przekładni, która nie jest tylko ograniczeniem *mocy*, ale również *momentu obrotowego* na wałach.
*   **Sugestia naprawcza:** Wprowadzenie bardziej szczegółowej interakcji momentów: MGU-K powinien dostarczać moment w sposób uwzględniający przekładnie biegów i aktualną prędkość obrotową silnika (RPM), zamiast traktować to tylko jako globalne ograniczenie mocy.

#### 📈 Luka 5: Kinematyka vs. Dynamika przy niskich prędkościach/poślizgu
*   **Kontekst:** Przy $V \to 0$ model może zbyt łagodnie przejść z dynamicznego modelu jednośladu do kinematycznego (poniżej ok. $8 \text{ m/s}$), ignorując momenty bezwładności i siły tarcia w sposób bardziej realistyczny.
*   **Sugestia naprawcza:** Przy ekstremalnym poślizgu lub bardzo niskich prędkościach należy wzmocnić wpływ momentu bezwładności i sił tarcia na kąty obrotowe (Angular Momentum) w celu bardziej realistycznego modelowania "utknięcia" lub trudnego powrotu do ruchu.

---

### II. Kolizje i Interakcje Zewnętrzne (Collision & Environment)

#### 💥 Luka 6: Brak czasu kontaktu w kolizjach (Contact Resolution)
*   **Kontekst:** Proces rozdzielania ciał poprzez natychmiastowy impuls normalny jest uproszczony. W przypadku wielu, szybkich zderzeń może dojść do **narastających artefaktów energii** lub niepoprawnej rozdzielczości obrysów po kilku cyklach.
*   **Sugestia naprawcza:** Rozważyć implementację metody iteracyjnej (np. *Multiple Contact Points / Sequential Impulse Solver*) zamiast jednorazowej korekcji impulsami. Wymaga to obliczenia wszystkich interakcji w danym kroku i rozwiązanie ich jednocześnie, aby zachować pełniejszą konsystencję fizyczną.

#### 🚧 Luka 7: Interakcja z bandą (Barrier/Off-track)
*   **Kontekst:** Kontakt z barierą skutkuje stratą pędu wzdłuż osi kolizji i obrotem na podstawie dźwigni. Brakuje uwzględnienia **gradientu oporu aerodynamicznego** przy zbliżaniu się do bariery oraz różnicy w tarciu (zwłaszcza między żwirem a asfaltem) dla *pierwszego* kontaktu poza tor.
*   **Sugestia naprawcza:** Zintegrowanie modelu tępego uderzenia: Siła hamująca powinna być proporcjonalna do zróżnicowania prędkości na styku (Impact Velocity $\Delta V$) oraz obszaru kontaktu, a nie tylko normalnego impulsu. Dodatkowo, przy kontakcie z bandą powinno następować natychmiastowe i potężne obciążenie aerodynamiczne.

#### 🟡 Luka 8: Efekt "Żółtej Flagi" na fizyce ruchu (Yellow Flag Dynamics)
*   **Kontekst:** Yellow Flag jest obecnie głównie mechanizmem AI i hazardem. Fizycznie, zjazd do strefy żółtej powinien wymuszać **natychmiastową redukcję maksymalnego koła tarcia $\mu$** dla wszystkich osi oraz automatyczne obniżenie mocy silnika (np. *brake-by-wire*) niezależnie od decyzji AI.
*   **Sugestia naprawcza:** Wprowadzić fizyczny modyfikator globalny `mu_yellow_flag = 0.7` i obowiązkową, geometryczną redukcję mocy napędu o $X$ kW/Nm dla każdego bolidu w strefie żółtej.

---

### III. Sztuczna Inteligencja i Logika Gry (AI & Gameplay Logic)

#### 🗺️ Luka 9: Złożoność planowania toru (Line Search vs. Geometric Path)
*   **Kontekst:** AI używa połączenia precyzyjnej geometrii opartej na checkpointach i bardziej elastycznej metody uczenia się linii. W przypadku kolizji lub wyjazdu z toru, *geometryczne* planowanie trasy jest zbyt sztywne.
*   **Sugestia naprawcza:** Implementacja dynamicznego przełączania trybu planowania: gdy pojazd jest blisko nieznanego/zablokowanego obiektu (np. wrak, głęboki piasek), AI powinno automatycznie przeszacować korytarz jazdny na podstawie **lokalnego minimalizmu trasy** zamiast ślepo dążyć do najbliższego checkpointu.

#### 🤖 Luka 10: Model „Pomyłki” i Uczenie DAgger (Learning and Mistakes)
*   **Kontekst:** Mechanizm pomyłek jest dobrze zaprojektowany, ale jego wpływ na *trening* vs. *wyścig* może być niejasny. Pomyłki powinny być traktowane jako katalizator uczenia, a nie tylko kary fizyczne.
*   **Sugestia naprawcza:** Wprowadzenie kontekstowej modyfikacji: pomyłki w **treningu** powinny generować sygnały treningowe do `replayBuffer` (jako przykłady DAgger), ale ich wpływ na *stan fizyczny* powinien być łagodniejszy i nie powodować automatycznego spadku docisku, chyba że jest to celowo symulowany zderzenie.

#### 👻 Luka 11: Ciągłość treningu vs. Modelowanie rywali w tle (Ghost Cars)
*   **Kontekst:** Zachowanie całej stawki podczas nieudanej próby PB jest dobre. Brakuje formalnego modelu "duchowych" rywali, którzy pojawiają się w treningu jako statyczne punkty odniesienia lub źródła danych dla analizy.
*   **Sugestia naprawcza:** Wprowadzenie trybu symulacji „ghost cars” (Phantom Racing) podczas treningu i testów. Ich telemetria staje się kluczowym elementem zewnętrznego zestawu danych wejściowych, pozwalając na trenowanie AI w warunkach idealnego rywalizowania.

---

### IV. Aspekty Konsystencji Danych i Interfejsów (Data Consistency & Debugging)

#### ⏱️ Luka 12: Separacja symulacji czasu rzeczywistego od cykli symulacyjnych
*   **Kontekst:** System używa stałego kroku $dt$. W przypadku długich postojów lub zderzeń, obliczenia momentów bezwładności i tarcia mogą być wrażliwe na duże zmiany czasowe.
*   **Sugestia naprawcza:** Wprowadzenie funkcji "Time Dilation Factor" do wszystkich kluczowych symulacji (np. `updatePhysics`). Podczas np. tankowania lub stania po wypadku, system powinien być zdolny do wykonywania *mikrokroki* o znacznie mniejszym $dt$ niż główny krok gry, aby zachować precyzję obliczeń bezwładności i tarcia.

#### 📊 Luka 13: Złożoność danych wejściowych dla Sieci Neuronowej (Feature Scaling)
*   **Kontekst:** Chociaż normalizacja jest realizowana, brakuje mechanizmu zarządzania **dynamiką znaczenia** tych cech. Model nie wie, czy dane są skalowane względem historycznej średniej, czy fizycznego maksimum.
*   **Sugestia naprawcza:** Dodanie warstwy kalibracji wejściowej dla sieci neuronowej, która dynamicznie skaluje dane bazując na odległościach między wartościami w ramach sesji (np. jeśli temperatura opon zawsze oscyluje wąskim zakresem wokół optymalnych $100 \text{ °C}$, powinien to być uwzględniony w skali).

---

### V. Nowe Potencjalne Obszary Modelowania (Ideas for Expansion)

Poniżej znajdują się obszary pominięte lub traktowane zbyt uproszczone, które mogłyby drastycznie podnieść realizm symulacji:

*   **Hydraulika Zawieszenia (Suspension Dynamics):**
    *   Dodanie modelu sprężyn i tłumików. Umożliwi to realistyczne odwzorowanie efektu "zbija się na podwozie" oraz kolizji prętów zawieszenia z torami, co jest kluczowe dla precyzyjnego obliczenia docisku podczas dynamicznych manewrów.
*   **Wiatr i Przeciążenia Zewnętrzne (Wind Model):**
    *   Wprowadzenie zmiennego pola wiatru (np. podmuchy przy wyjeżdżaniu z tunelu, boki). Wiatr powinien być modelowany jako siła aerodynamiczna działająca na cały wektor prędkości względem *wiatru*, a nie tylko względem nieruchomego powietrza.
*   **Opór Ciągu Związany z Obciążeniem (Induced Drag/Lift):**
    *   Wprowadzenie efektu podnoszenia i nadmiernego oporu cięgien w zakrętach, który jest funkcją nie tylko $C_l \cdot A$, ale także lokalnych różnic ciśnień na karoserii.
*   **Interakcja z Obiektami Środowiskowymi (Debris/Obstacles):**
    *   Modelowanie dynamicznych elementów toru, np. pękniętych ogrodzeń lub uszkodzonych segmentów trakcyjnych, które generują tymczasowe i różnorodne kolizje.
*   **Złożone zarządzanie oponami (Thermal Degradation/Overheating):**
    *   Poza prostym zużyciem i temperaturą, należy uwzględnić **przegrzewanie się** opon w przypadku ciągłych mikro-zderzeń lub ekstremalnie długiego użycia. Powinno to prowadzić do natychmiastowego spadku $\mu$ i potencjalnego wyłączenia systemu.

