# Aktualny model fizyki

Stan po poprawkach z 05.10.2026. Ten dokument zastępuje historyczny opis fizyki w `docs/archive/opis.md` i `docs/archive/opis.txt`.

## Jednostki i geometria

Świat używa metrów, sekund, kilogramów i radianów. Jedna jednostka współrzędnych odpowiada jednemu metrowi. Szerokość toru 14 m oznacza rzeczywistą szerokość geometrii 14 jednostek. Kamera odpowiada za skalowanie obrazu.

Fizyczny obrys samochodu wynosi 5,5 × 1,8 m. Kolizja z bandą sprawdza ruch obrysu, w tym ścieżki narożników oraz obrót pomiędzy pozycjami, z przestrzennym podziałem do 0,25 m i doprecyzowaniem momentu kontaktu. Powiększony symbol graficzny 9 × 3 jednostki służy czytelności i nie powiększa obrysu kolizji.

## Siły i integracja

- Masa: 798 kg plus bieżące paliwo; start domyślnie 105 kg, zbiornik 110 kg.
- Moc: do 750 kW, ograniczona trakcją tylnej osi. Pusty bak odcina moc, samochód może już tylko wytracać prędkość.
- Aerodynamika: gęstość 1,225 kg/m³, `Cd*A=1,00 m²`, `Cl*A=3,10 m²`. Opór przeciwdziała całemu wektorowi prędkości względem nieruchomego powietrza; docisk rośnie z kwadratem prędkości.
- Bazowe tarcie: 1,85, z mnożnikiem osiągów i wrażliwością opon na obciążenie przy transferze bocznym (sekcja „Wrażliwość opon na obciążenie”).
- Obciążenia osi sumują się do ciężaru i docisku. Transfer wzdłużny korzysta z przyspieszenia poprzedniego kroku.
- Napęd, hamowanie i toczenie wykorzystują wspólny budżet siły wzdłużnej osi. Żądanie hamowania rozdzielane jest 56/44 i ograniczane osobno na osiach.
- Siła boczna każdej osi korzysta z pozostałego koła tarcia `sqrt((mu*Fz)^2-Fx^2)`. Skręt i korekcja poślizgu są sumowane w tej samej osi i wspólnie ograniczane.
- Globalny wektor prędkości jest aktualizowany jeden raz z wynikowej siły. Zmiana orientacji nadwozia sama nie obraca pędu.
- Powyżej ok. 8 m/s działa dynamiczny model jednośladu (patrz „Dynamika poślizgu”); poniżej — kinematyczna odpowiedź pierwszego rzędu (0,05 s), ograniczona dostępną siłą boczną. Przejście jest płynne (8–16 m/s).
- Telemetria G jest podpisanym przyspieszeniem ze zmiany prędkości, rzutowanym na osie pojazdu z początku kroku. Nie jest obcinana przed wykorzystaniem w transferze mas.

Worker używa stałego kroku 1/60 s i akumulatora rzeczywistego czasu. Tryb Balanced 1× nie wykonuje dodatkowych kroków tylko dlatego, że ticker uruchamia się co 16 ms. Po pauzie nie nadrabia czasu zatrzymania. Długie opóźnienia ograniczane są do 0,25 s, a liczba kroków do budżetu profilu, aby uniknąć spirali nadrabiania. Profile Performance i Turbo celowo przyspieszają symulację; MAX wykorzystuje dostępny budżet.

## AI, paliwo i postój

Poprawka treningu z 05.10.2026: po ukończeniu pierwszego okrążenia rekordowa sieć zespołu jest nadpisywana tylko po poprawie czasu PB, a nie przy wzroście kumulowanego fitness. Automatyczne cykle generacji zachowują jadące bolidy z ukończonym okrążeniem, wraz z pozycją, prędkością, paliwem, aktywną siecią i bieżącym okrążeniem. Ręczna „Nowa Gen” nadal rozpoczyna jazdę ze startu, zachowując zapisane rekordowe modele. Po przywróceniu modelu z PB usuwane są próbki nieudanej próby z replay buffer. Profil prędkości lidera jest przypisywany do przestrzennie odpowiadających checkpointów.

AI śledzi krótką trajektorię wzdłuż osi toru zamiast celować o całe checkpointy naprzód przez wąskie zakręty. Sterowanie wykonuje sieć neuronowa (szczegóły w sekcji „Sieć neuronowa jako kierowca”). Progi sensorów zależą od szerokości drogi. Wolne miejsce przed autem (`minCenterClearance`) to odległość z trzech środkowych promieni podzielona przez szerokość toru, w skali `Car.CLEARANCE_REF_WIDTH = 76`. Progi `CLEAR_FULL` 0,22 (pełny gaz), `CLEAR_LIFT` 0,12 (poniżej: hamowanie awaryjne i strażnik) i `CLEAR_CAP` 0,2 odpowiadają ok. 0,69 / 0,38 / 0,63 szerokości toru. Szerszy tor widzi bandę w zakręcie dalej, dlatego progi nie są stałymi w metrach. Plan hamowania jest konserwatywną heurystyką, nie dokładnym solverem maksymalnego tempa.

Zużycie paliwa wynika z mocy silnika: `FUEL_FLOW_MAX · gaz · f(obroty)` plus 0,0006 kg/s na biegu jałowym, gdzie `FUEL_FLOW_MAX` = 100 kg/h (limit przepływu z regulaminu), a `f` to krzywa mocy ICE. Daje to ok. 0,32–0,33 kg/km (GP: ok. 0,94 kg/okr., Spielberg ok. 1,37 kg/okr.), czyli ok. 100 kg na 300 km wyścigu.

Postoje (`src/physics/PitStrategy.ts`) działają tak samo w treningu, kwalifikacjach i wyścigu. Nikt nie tankuje. Zgłoszony postój zaczyna się przy przecięciu linii mety. Auto zjeżdża w aleję: znika z toru, nie bierze udziału w ruchu i nie widzą go czujniki. Traci czas przejazdu aleją (`PIT_LANE_LOSS` = 20 s, tor może ustawić własne `pitLaneLoss`) oraz 2,5 s wymiany opon. Dostaje nowy komplet opon i naprawiony nos. Wraca na tor przy linii, wzdłuż toru, z prędkością limitu alei (80 km/h), ale dopiero gdy w promieniu 12 m nie ma auta i żadne nie nadjeżdża z tyłu szybciej niż w 1,5 s. Postój wlicza się do czasu okrążenia i wyścigu. Okrążenie wyjazdowe nie jest okrążeniem wzorcowym (nie ustala rekordu ani nie ocenia modelu).

Strategia AI: zjazd przy zużyciu opon > 70% (nie na ostatnich dwóch okrążeniach wyścigu), zjazd w dowolnym momencie, gdy opony nie pasują do warunków, a w wyścigu na suchym obowiązek użycia dwóch mieszanek slick. Jeśli auto do połowy dystansu nie zmieniło mieszanki, zjeżdża wtedy. Zasada nie obowiązuje, jeśli użyto opon przejściowych lub deszczowych. Gracz decyduje o postojach sam (klawisz P).

Paliwo na wyścig: liczba okrążeń × zużycie na okrążenie stawki na tym torze (średnia z ukończonych okrążeń treningu, a bez nich 0,35 kg/km) + 4% + 1,5 kg rezerwy. Jeśli bak (110 kg) nie wystarcza na zadany dystans, wyścig jest skracany do liczby okrążeń, którą da się przejechać, jak limit dystansu w F1. Licznik okrążeń pokazuje rzeczywisty dystans. W treningu auto bez paliwa odpada i wraca z pełnym bakiem przy respawnie. Przycisk „Tankuj” działa tylko w treningu.

## Pobocza i bandy

Każdy tor generuje oddzielne krawędzie asfaltu, pas trawy, żwir i bandy. Bazowe pobocze na prostych wynosi 0,25 szerokości asfaltu na stronę (3,5 m przy torze 14 m). Trawa zajmuje do 0,08 szerokości toru. Pobocze zewnętrzne zakrętów jest projektowane na 1–4 szerokości toru na podstawie wygładzonej krzywizny i szacowanej prędkości dojazdu; rozszerzenie obejmuje wejście i wyjście. Poszerzanie ograniczono do 0,3 m na metr drogi. Sąsiedni asfalt może ograniczyć strefę poniżej docelowej szerokości. Przecinający się asfalt jest odrzucany przed wymianą bieżącego toru. Renderer, kamera i fizyka korzystają z jednej geometrii; JSON starszych torów pozostaje zgodny.

Nawierzchnia jest próbkowana pod czterema kołami (rozstaw osi 3,6 m, szerokość 1,8 m). Wypadkowe μ stanowi średnią udziałów: asfalt 1,85, trawa 0,45, żwir 0,60. Dodatkowy opór przeciwny do całego wektora prędkości wynosi 0,04 g na trawie i 0,35 g na żwirze przy pełnym udziale nawierzchni. Impuls nie może odwrócić ruchu. To parametry uproszczonego modelu, nie kalibracja konkretnego toru. Pełny postój w żwirze może uniemożliwić ponowne ruszenie.

Przekroczenie białej linii nie powoduje DNF. Po lekkim kontakcie z bandą usuwana jest prędkość skierowana w bandę, a pozostała mnożona przez 0,8; bolid jest odsuwany o 3 cm. Prędkość prostopadła do bandy co najmniej 12 m/s kończy jazdę. Rozbite auto zostaje na torze jako wrak z lokalną żółtą flagą przez 15 s (`WRECK_CLEAR_SECONDS`), w treningu tak samo jak w wyścigu. W wyścigu nie ma respawnu; trening przywraca auto dopiero po usunięciu wraku. Telemetria pokazuje nawierzchnię i przyczynę eliminacji. Odzyskiwanie kontroli dostaje do 30 s bez checkpointu, pozostała jazda zachowuje dotychczasowy limit 10 s.

## Pomyłki AI i ochrona uczenia

Ryzyko wynosi `clamp((wykorzystaniePrzyczepności − 0,55) / 0,45, 0, 1)`. Zdarzenia mają prawdopodobieństwo `1 − exp(−ryzyko * dt / 600)` w kroku czasu symulacji. Przy pełnym ryzyku daje to średnio jedną pomyłkę na 10 minut ekspozycji, z 30 s przerwy po zdarzeniu. Pomyłka trwa 0,2–0,6 s i zmniejsza hamowanie do 25% żądania albo zmienia skręt o 0,08–0,20. Nie wymusza wypadnięcia, nie zmienia wag sieci i nie dodaje sił. Pomyłki działają w treningu i wyścigu; nie działają podczas postoju, ręcznego sterowania, odzyskiwania kontroli lub po finiszu.

Podczas pomyłki i odzyskiwania kontroli replay jest wyłączony i czyszczony. Dotknięte zdarzeniem lub wyjazdem na pobocze okrążenie liczy się w dystansie i czasie wyścigu, ale nie zastępuje PB, sieci mistrza ani profilu prędkości lidera i nie uruchamia cofnięcia za pogorszenie czasu. Po wyjeździe AI korzysta z geometrycznego celu na asfalcie, ogranicza gaz i hamuje zależnie od prędkości. Na powrót na asfalt ma 12 s (`Car.OFF_TRACK_RECOVERY_TIME`) — dopiero dłuższy ciągły pobyt poza asfaltem kończy się eliminacją „BRAK POSTĘPU”. Checkpointy pozostają uporządkowane i wymagają przejazdu po asfalcie.

## Ograniczenia

Wiatr jest jednorodny na całym torze (bez osłonięć trybunami). Brak pełnej mapy aero (docisk zależy od prześwitu, opór od niego nie zależy). Uszkodzenia ograniczają się do jednego skalara (docisk/opór). Zawieszenie, opony (temperatura, zużycie, wrażliwość na obciążenie) i skrzynię biegów opisują osobne sekcje. Model nie był kalibrowany względem danych konkretnego bolidu F1. Dawne czasy okrążeń i wagi AI nie są porównywalne z wynikami po zmianie fizyki oraz szerokości toru; zalecany jest nowy trening.

## Weryfikacja

`npm run test:learning` sprawdza ochronę modeli PB, odzyskiwanie po rozbiciu, ciągłość generacji, czyszczenie nieudanych próbek i mapowanie telemetrii lidera; zawiera test 400 sekund rzeczywistej pętli treningowej.

`npm run test:runoff` sprawdza generowanie i ograniczanie poboczy, nawierzchnie pod kołami, brak dodawania energii przez opór, lekkie i mocne zderzenia, szybkie przecięcie położenia bandy, powrót AI na asfalt, kolejność checkpointów i ochronę PB. Statystykę zdarzeń porównuje przy 30/60/120 krokach na sekundę; dodatkowo wykonuje trzy testy rzeczywistej jazdy po 600 sekund.

`npm test` uruchamia oba zestawy oraz sprawdza limity sił, hamowanie od spoczynku i w obu kierunkach, telemetrię, jazdę bokiem, brak paliwa, postój bez tankowania i zegary, skalę, obrys oraz ukończenie okrążeń GP przez AI. Test workera z kontrolowanym zegarem sprawdza 1× przy tickerach 16 ms i 20 ms oraz pauzę. Dodatkowo sprawdza checkpointy pól startowych, ukończenie 10-okrążeniowego wyścigu przez AI, zamrożenie czasu po mecie i powrót do treningu. `npm run audit:physics` wypisuje wyniki numeryczne; `npm run build` sprawdza TypeScript i bundlowanie.

`docs/archive/AUDIT_PHYSICS.md` zachowuje dowody stanu sprzed napraw. Poprawiono osiem opisanych tam problemów i akumulator czasu; dynamika poślizgu (model jednośladu) i kontakty między bolidami doszły później (opisane niżej). Aleja serwisowa nie ma własnej geometrii: auto znika z toru na czas postoju (strata alei plus zmiana opon) i wraca przy linii mety, gdy tor przy wyjeździe jest wolny.

### Krótkie ataki na rywala

W wyścigu AI może podjąć próbę szybszego przejazdu, gdy rywal jedzie 2–35 m przed nim na tym samym odcinku, w zgodnym kierunku i na tym samym okrążeniu. Przy ciągłej okazji częstość rozpoczęcia wynosi średnio raz na 15 s czasu symulacji (p = 1 − exp(−dt/15)). Atak trwa 3–6 s, potem obowiązuje 20 s przerwy. Docelowa prędkość zakrętu rośnie o 4%, a szacowana zdolność hamowania o 8%, co opóźnia rozpoczęcie hamowania; rzeczywista moc i siły przyczepności nie zmieniają się. To założenia modelu, a nie statystyki prawdziwych kierowców.

Po utracie rywala, poślizgu, pomyłce, wyjeździe na pobocze lub zgłoszeniu pit stopu AI odpuszcza. Trening i ręczne sterowanie nie uruchamiają ataków. Telemetria pokazuje „ATAK: nazwisko”. Okrążenie liczy się w wyścigu, ale nie zastępuje rekordowej sieci ani wyników oceny modelu; próbki sterowania podczas ataku są wyłączone. Funkcja zmienia tempo jazdy; współpracuje z osobnym planowaniem linii wyprzedzania i modelem kolizji.

### Kontakt bolidów w wyścigu

Bolidy w wyścigu mają nieprzenikające prostokątne obrysy 5,5 × 1,8 m. Ciągły test osi rozdzielających wykrywa kontakt na całej drodze ruchu; obrót dzielony jest na małe odcinki. Lekkie uderzenie rozdziela auta i stosuje niesprężysty impuls w punkcie styku, z tarciem (szczegóły w sekcji „Kontakt auto–auto: obrót i tarcie”). Składowa prędkości względnej skierowana w kontakt ≥ 12 m/s (`Car.CRASH_CLOSING_SPEED`) oznacza wypadek i DNF obu uczestników. Jest to uproszczony próg modelu. Uszkodzone auta pozostają przeszkodami. Telemetria podaje „WYPADEK Z INNYM BOLIDEM”. Zdarzenie wyklucza okrążenie z oceny sieci, ale czas wyścigu nadal liczy się normalnie.

AI ogranicza gaz i hamuje przed pojazdem w swoim korytarzu jazdy, uwzględniając odległość i prędkość zbliżania. Dotyczy to także dublowanych i zatrzymanych samochodów. Atak ustępuje hamowaniu bezpieczeństwa. Sterowanie ręczne nie jest korygowane, ale jego kolizje są fizyczne. Trening również uwzględnia kontakt i unikanie innych aut. Po wypadku model jest zachowany, a bolid stoi jako wrak 15 s (żółte flagi jak w wyścigu) i wraca, gdy porządkowi go usuną, a jego miejsce startowe jest wolne. Wyprzedzanie korzysta z bocznego przesunięcia celu sterowania, opisanego niżej.

`npm run test:traffic` sprawdza najechanie od tyłu przy dużej prędkości, krzyżowanie trajektorii, lekkie kontakty, rozdzielenie obrysów, energię oraz hamowanie przed wolniejszym i zatrzymanym rywalem.

### Linie wyprzedzania i lokalne żółte flagi

AI wybiera wolną linię po lewej lub prawej stronie rywala, z odstępem bocznym 3,2 m. Przesunięcie celu rośnie płynnie maksymalnie o 1,8 m/s; zmienia wyłącznie punkt, do którego kieruje samochód. Ruch wynika z istniejącej fizyki, bez teleportacji. Kandydat musi mieścić się na asfalcie z zapasem 1,6 m od krawędzi i nie kolidować z pobliskimi autami ani ich zaplanowanymi liniami. Przy bocznej linii prędkość docelowa zakrętu jest obniżona o 12%, by zachować zapas na zmieniony promień jazdy. Odstęp i hamowanie przed rywalem są mierzone wzdłuż krzywej trasy. AI utrzymuje linię do minięcia rywala o 9 m i wraca dopiero, gdy środkowy korytarz jest wolny. Na zbyt wąskim lub zajętym torze czeka i hamuje. Próbki uczenia i ocena rekordowej sieci nie korzystają z okrążeń wspomaganych planowaniem ruchu w stawce.

Każdy nieusunięty DNF tworzy lokalną żółtą strefę od 200 m przed wrakiem do 30 m za nim, liczoną wzdłuż trasy także przez metę. W niej AI odpuszcza atak, nie wybiera linii wyprzedzania żywych rywali i hamuje do 22 m/s (około 79 km/h). Omijanie nieruchomego wraku pozostaje dozwolone. Hamowanie bezpieczeństwa dotyczy również ręcznego sterowania przy żółtej fladze. To uproszczone zasady symulacji, nie odwzorowanie regulaminowego systemu sędziowania. Żółta flaga jest widoczna w telemetrii i etykietach aut. Oczekiwanie przy prędkości poniżej 3 m/s za blokującym pojazdem nie uruchamia DNF za brak postępu.

Przy wykryciu DNF losowana jest obsługa po 1 albo 2 dalszych ukończonych okrążeniach lidera. Po upływie tego dystansu wrak znika z renderowania oraz wykrywania kolizji i przeszkód; kierowca zachowuje DNF w klasyfikacji. Gdy w danej strefie nie ma kolejnego wraku, żółta flaga gaśnie.

### Zgodność rysunku i kolizji

Rysowany bolid ma ten sam obrys 5,5 × 1,8 m co fizyczny model kontaktu. Koła, skrzydła i pozostałe stałe elementy są ograniczone do tego obrysu, zamiast dawnego powiększonego znacznika 9 × 3 m. Efekty dymu, podpisy i zaznaczenie kierowcy pozostają nakładkami. Wzajemne kolizje, hamowanie przed rywalem i wybór bocznej linii działają także w domyślnym treningu. Reset miejsca po wypadku nie jest traktowany jako ruch przez tor, a zajęty slot opóźnia respawn.

### Ciągłość treningu bez czystego rekordu

Automatyczna zmiana generacji nie tworzy ponownie stawki. Zachowuje wszystkie obiekty bolidów, pozycje, prędkości, paliwo, bieżące okrążenia i aktywne sieci, także gdy kierowca nie ma jeszcze czystego PB. Wyprzedzanie, pomyłki i ruch pod żółtą flagą nie pozbawiają tej ochrony. Martwy bolid nadal czeka na swój indywidualny respawn. Dopiero ręczna „Nowa Gen” ustawia całą stawkę na starcie.


## Sieć neuronowa jako kierowca (stan po audycie z 11.10.2026)

Wyjścia sieci `[skręt, gaz, hamulec]` są faktycznym sterowaniem (`Car.getAIControl`, `decodeDriverOutputs`). Regułowy kontroler (`Car.planDrive`: pościg geometryczny + profil prędkości z krzywizny) jest teraz **nauczycielem** i **strażnikiem**:

- **Destylacja** (`src/ai/Distill.ts`): nowa sieć uczy się naśladować nauczyciela na prawdziwym torze (240 s jazdy z zakłóceniami skrętu i losowymi przesunięciami linii, etykiety nauczyciela w odwiedzonych stanach — DAgger). Wynik jest cache'owany na tor/topologię. `NeuralNetwork.createTrainedDriverNetwork(rays, topology, track?)` bez toru korzysta z presetu GP.
- **Autorytet sieci:** skręt w korytarzu ±0,3 wokół skrętu geometrycznego, gaz i hamulec w pełnym zakresie; pedały wykluczają się: przy dekodowaniu wygrywa silniejsze wyjście (szczątkowe 3–4% hamulca nie zeruje pełnego gazu — wcześniej przy zimnych oponach sieć „toczyła się” całe okrążenia na 1. biegu).
- **Strażnik** przejmuje sterowanie tylko przy: zjeździe z asfaltu, bliskości bandy, żółtej fladze, postoju w boksie, odzyskiwaniu kontroli, nadmiernej prędkości względem planu hamowania (hamowanie awaryjne), postoju z gazem wymaganym przez nauczyciela (launch assist).
- **Uczenie:** (1) ewolucja — mutacje rekordowych sieci i selekcja po czasie okrążenia (PB), (2) online backprop wyłącznie w stanach, w których strażnik musiał interweniować (korekta typu DAgger).
- Planowane opóźnienie hamowania: `Car.PLANNED_BRAKE_DECEL = 8,5 m/s²` × agresja (wcześniej 6,0).

`npm run diag:nn -- 600` pokazuje okrążenia, DNF i rekordy zespołów; `--expert` porównuje z samym nauczycielem.

## Dynamika poślizgu

Model jednośladu (`Car.updatePhysics`): kąty znoszenia osi → siła boczna `Fy = Fmax·tanh(Cα·α/Fmax)` (Cα = 22·Fz, Fmax z koła tarcia osi) → moment na bryłę o bezwładności `Iz = 1,3·m`. Napęd i hamowanie mają **priorytet stabilności**: oś zachowuje siłę boczną użytą w poprzednim kroku (×1,1), a napęd/hamulec dostają resztę koła tarcia (jak TC/ESC). Skręt koła podąża za poleceniem z opóźnieniem 0,09 s.

Skutki: podsterowność przy nasyceniu przedniej osi, nadsterowność przy nasyceniu tylnej, `isSkidding`/`understeerSlip`/`oversteerSlip` wynikają z kątów znoszenia, a nie z samego żądania. Kierowca regułowy ma sprzężenie od prędkości kątowej i ogranicza skręt do tego, co wykorzystuje oś. Poniżej ok. 8–16 m/s, gdzie kąty znoszenia są źle uwarunkowane, odpowiedź płynnie przechodzi w kinematyczną.

## Kolizje, uszkodzenia, wraki

- `Car.damage` (0…1) rośnie o `(v/12)²` przy każdym kontakcie (bandy i inne auta); ≥ 1 albo pojedynczy kontakt ≥ 12 m/s (`Car.CRASH_CLOSING_SPEED`) = DNF. Uszkodzenie zmniejsza docisk do 35% i zwiększa opór do 15%; postój w boksie naprawia.
- Banda: impuls z tarciem Coulomba (styczna prędkość maleje proporcjonalnie do uderzenia), zamiast mnożenia przez 0,8 w każdym kroku; uderzenie poza osią skręca auto.
- Wrak zachowuje pęd i zwalnia 12 m/s² (`Car.coastWreck`), zatrzymuje go banda; ślizgający się wrak jest ruchomą przeszkodą w kontaktach.
- `src/math/Random.ts`: `seedRandom(n)` daje powtarzalną symulację (domyślnie `Math.random`).

## Poszukiwanie limitu i linii (trening)

- `PaceSearch` (`src/ai/PaceSearch.ts`): auto, które zostaje na asfalcie, ma zapas, więc po każdym czystym okrążeniu planowana przyczepność w zakrętach i hamowanie rosną (`margin` 0,9–1,5). Jeśli okrążenie nie jest szybsze, wraca do sprawdzonego marginesu i próbuje drobniejszym krokiem. Zjazd z asfaltu, uderzenie w bandę lub wycofanie auta cofa margines i obniża sufit poszukiwań. W wyścigu używany jest sprawdzony `bestMargin`.
- `LineSearch`: oprócz 5 bazowych linii mutacje (co 2. okrążenie) przesuwają linię osobno w 16 odcinkach toru (`trim`, do ±2,2 m), czyli wcześniejszy/późniejszy wierzchołek, szersze wejście itd. Zwycięska linia jest zachowana, a nowa kandydatka testowana obok.

## Wyjścia pedałów i linia z sieci (`LineNet`)

- Gaz i hamulec nigdy nie działają razem: w `updatePhysics` każde żądanie hamowania > 0,02 zeruje gaz, a mniejsze jest odrzucane (dotyczy sieci, eksperta i sterowania ręcznego).
- Linia przejazdu pochodzi z osobnej sieci (`src/ai/LineNet.ts`). Wejścia: promienie LiDAR, prędkość, zakrzywienie toru w 4 punktach przed autem, położenie boczne i błąd kursu. Wyjście: pożądane położenie boczne jako ułamek użytecznej szerokości (do połowy szerokości − 2,3 m). Start: sieć wydestylowana z linii zewnątrz–wewnątrz–zewnątrz, która wykorzystuje całą szerokość.
- Uczenie: zmutowana kopia jedzie jedno okrążenie i zostaje mistrzem tylko, gdy jest szybsza; co 4. okrążenie mistrz jest mierzony ponownie (szum gripu/mocy). Linia sama nie kosztuje prędkości — kara za offset dotyczy tylko odchylenia od linii (wyprzedzanie).
- Najlepsza trasa jest rysowana cieńszą kreską.

## ERS / MGU-K

Jednostka napędowa według regulaminu 2026 (bez MGU-H):

- Moc napędu = ICE 400 kW · gaz · f(obroty) + MGU-K do 350 kW (razem nadal 750 kW). Bateria: 4 MJ użytecznego okna (`ERS_CAPACITY`).
- Oddawanie przy gazie > 0,65. Moc MGU-K maleje liniowo od 290 km/h do zera przy 355 km/h (`ERS_TAPER_START/END`).
- Zarządzanie energią: moc oddawania rośnie liniowo ze stanem baterii od 10% (`ERS_CLIP_SOC`) do pełnej przy 90% (`ERS_LOW_SOC`). Dzięki temu energia oddana na okrążeniu zbliża się do odzyskanej, a bateria nie stoi w miejscu.
- Poniżej 10% przy pełnym gazie następuje „super clipping”: MGU-K ładuje baterię mocą 50 kW, odbierając ją z napędu.
- Odzysk ograniczony do 8,5 MJ na okrążenie (`ERS_LAP_HARVEST`, licznik zerowany na linii mety):
  - hamowanie do 350 kW, niezależnie od siły nacisku na pedał (brake-by-wire najpierw używa MGU-K), ale nie więcej niż moc rozpraszana przez hamulce;
  - lift-and-coast powyżej 30 m/s: 105 kW;
  - częściowy gaz: do 100 kW · gaz (ICE napędza MGU-K jako generator);
  - sprawność 88%.
- Na torze Grand Prix (szer. 14 m) bateria waha się w trakcie okrążenia o ok. 30 punktów procentowych: sieć neuronowa ok. 32–69%, ekspert 25–55%. W modelu sprzed zmiany (120 kW oddawania, 350 kW odzysku) bateria w aplikacji stała zwykle na 90–95%.
- Przy ograniczeniu trakcją (niskie prędkości) dodatkowa moc nie przyspiesza; różnicę widać powyżej ok. 60 m/s. W telemetrii: „ERS xx%”.

## Pogoda (`src/physics/Weather.ts`)

- Stan: zachmurzenie, deszcz, temperatura powietrza i toru, wilgotność toru W, wiatr (średnia, kierunek, mnożnik porywu). Ewoluuje z krokiem symulacji, z własnym generatorem (mulberry32) z ziarnem, niezależnym od `random()` symulacji.
- Zachmurzenie: proces Ornsteina-Uhlenbecka wokół średniej prognozy; „przelotny deszcz” ma jedno okno opadu (start po 3–8 min, 4–8 min). Deszcz = `skala·(chmury − próg)/(1 − próg)`.
- Tor: relaksacja (τ = 240 s) do `T_pow + 13·słońce·(1 − chmury)·(1 − 0,8·W) − 2·deszcz`. Powietrze: baza − 4 °C·deszcz (τ = 300 s).
- Woda: deszcz moczy tor do poziomu `0,35 + 0,75·deszcz` (pełna ulewa w ok. 2 min), parowanie `W/520 s · (0,3 + słońce·(1 − chmury))·(T_toru − 5)/30 · (1 + 0,04·wiatr)`: każdy m/s średniego wiatru suszy o 4% szybciej (od 23.10.2026).
- Gęstość powietrza (od 23.10.2026): `ρ = 1,225·(273,15 + 25)/(273,15 + T_pow)` (gaz doskonały przy stałym ciśnieniu). Przy 25 °C wynosi dokładnie 1,225 kg/m³, więc kalibracja słonecznej pogody się nie zmienia; przy 5 °C ok. 1,31 (więcej docisku i oporu, prędkość maksymalna ok. 6 km/h niższa), przy 35 °C ok. 1,185. Planista zakrętów i hamowania używa tej samej gęstości.
- Aquaplaning (od 23.10.2026): slick na stojącej wodzie (W > 0,6) powyżej 200 km/h traci przyczepność: `0,5 · (W − 0,6)/0,4 · min(1, (v − 200 km/h)/100 km/h)`. Intery i deszczówki odprowadzają wodę. HUD: „⚠ AQUAPLANING”. Planista tego nie przewiduje; AI na mokrym torze i tak zjeżdża po opony z bieżnikiem.
- Wiatr: porywy OU (τ = 3 s, σ wg prognozy), kierunek dryfuje o ok. ±15° (τ = 60 s).
- Aero: prędkość względem powietrza `v_pow = v − wiatr`. Opór `½ρ·CdA·|v_pow|²` przeciw `v_pow`, docisk `½ρ·ClA·|v_pow|²·(1 − 0,6·sin²β)`, gdzie β to kąt napływu; 60% straty z wiatru bocznego pochodzi z przedniej osi. Siła boczna `½ρ·1,5 m²·|v_pow|·v_wiatru,bok` działa 0,3 m za środkiem masy i daje moment odchylający w modelu dynamicznym. W bezwietrznej pogodzie wzory redukują się do poprzednich.
- Trening: klasa warunków sesji (sucho < 0,15 ≤ wilgotno < 0,6 ≤ mokro, z histerezą) i pasma okrążenia (0–0,2 / 0,1–0,65 / 0,55–1). Okrążenie poza pasmem jest „skompromitowane” dla uczenia. `Population.setConditions` przy zmianie klasy ustala nowy rekord odniesienia przy pierwszym czystym okrążeniu, a mózg mistrza zostaje.
- Test: `npm run test:weather`.

## Opony: temperatura i zużycie (na oś)

- Stan: temperatura i zużycie osi przedniej i tylnej. Bilans: ciepło z mocy poślizgu bocznego (`siła · prędkość · tan α`, ×2), z pełzania wzdłużnego (1,2% `|Fx|·v`), z histerezy (`0,0075·Fz·v`), oś przednia ×1,6; chłodzenie konwekcją `∝ v^0,8` i torem; pojemność 12 kJ/K (stała czasowa ok. 40 s).
- Mnożnik przyczepności osi: dzwon temperaturowy (optimum 100 °C, zimno do 0,80, przegrzanie do 0,75) razy zużycie (do −25% przy W=1). Wchodzi do limitów osi i do planowanej przyczepności (kierowca zwalnia na zimnych/zużytych oponach).
- Model opon działa zawsze, tak samo w treningu i w wyścigu (bez przełącznika „koców”). Auto startuje z 85 °C; pit stop daje nowy komplet. Zużycie > 70% wywołuje zjazd do boksu (patrz „AI, paliwo i postój”).
- Kalibracja (`npm run diag:nn`): temperatury ok. 80–115 °C, tempo wyścigowe ok. 3–5% wolniejsze od treningowego.
- Pogoda (`Weather.ts`): powietrze i nawierzchnia z bieżącej pogody zastępują stałe 25 / 38 °C (`TYRE_AMBIENT` / `TYRE_TRACK` to wartości pogody odniesienia). Chłodzenie: `2·(15 + 3,2·v^0,8)·(T − T_pow) + 60·(T − T_toru)`, razy `(1 + 0,9·W)` na mokrym.
- Niezależność od kroku (`test-suspension`): prosta, stały zakręt oraz cykl hamowanie/przyspieszanie, każdy po 20 s przy 30/60/120 Hz. Różnice temperatury < 1,5 °C, zużycia < 5% (zmierzone: 0,9 °C i 2,3% w zakręcie).

## Hamulce: temperatura i blokowanie kół (23.10.2026)

Model działa zawsze, w treningu i w wyścigu, bez przełącznika.

- Tarcze na oś: praca hamowania (siła · prędkość) grzeje tarcze, przepływ chłodzi je `30 + 5·v` W/K; pojemność 3,2 kJ/K przód i 2,4 kJ/K tył. Całkowanie dokładne (relaksacja wykładnicza), więc wynik nie zależy od kroku (test: 30/60/120 Hz < 2 °C). MGU-K przejmuje część pracy tylnej osi, więc tył grzeje się mniej. Start 300 °C.
- Okno pracy 350–950 °C: poniżej skuteczność rośnie liniowo od 0,7 przy temperaturze powietrza, powyżej spada do 0,65 przy 1300 °C. Skuteczność mnoży moment przednich (hydraulicznych) hamulców z pedału (pedał nadal oznacza ułamek przyczepności auta). Tył to brake-by-wire: sterownik realizuje zadany moment najpierw MGU-K, resztę tarczą, niezależnie od jej temperatury. Ponieważ MGU-K przejmuje większość pracy tylnej osi przy typowym hamowaniu AI, tylne tarcze w treningu pozostają chłodne. Hamowanie z 300 do 72 km/h: zimne tarcze (25 °C) wydłużają drogę o ok. 13 m; tarcze przód dochodzą do ok. 720 °C. W treningu na GP szczyt to ok. 550–620 °C.
- Rozkład 60/40 (wcześniej 56/44): przy pełnym hamowaniu przód przenosi ok. 61% obciążenia, a 44% z tyłu blokowałoby tył na prostej.
- Brak ABS: oś blokuje się, gdy moment hamulca przekracza o 15% to, co opona może przenieść wzdłuż drogi na swoim kole tarcia (z bieżącą siłą boczną), dłużej niż 0,1 s (czas wyhamowania koła). Zablokowana oś ślizga się z 85% przyczepności, zachowuje 30% siły bocznej (auto jedzie prosto), praca idzie w oponę zamiast w tarczę, a płaskie miejsce dodaje 1% zużycia na sekundę. Oś odblokowuje się, gdy moment spadnie poniżej możliwości opony. HUD: „⚠ BLOKADA KÓŁ”, temperatury tarcz przy oponach.
- Pełny pedał na prostej na suchym nie blokuje kół; pełny pedał w zakręcie blokuje przód. Planista uwzględnia skuteczność tarcz (wcześniej hamuje i mocniej wciska pedał na zimnych lub przegrzanych tarczach).
- Pomiar wpływu całego etapu (gęstość, wiatr, aquaplaning, hamulce; trening `Population`, 180 s, ziarna 1–8, przed → po): słonecznie 322 → 316 okrążeń, DNF 70 → 66, średni najlepszy czas 53,52 → 53,76 s; deszcz 206 → 204 okrążenia, DNF 62 → 70. Różnice mieszczą się w rozrzucie między ziarnami. Koła są zablokowane w ok. 0,5% kroków auta na suchym i ok. 1,3% w deszczu; tarcze przód dochodzą w treningu do ok. 500–620 °C. Pierwsza wersja (blokada względem budżetu z rezerwą stabilności, rozkład 56/44) blokowała tył na prostej, obniżyła liczbę okrążeń o ok. 30% i podwoiła liczbę DNF, więc ją odrzucono.
- Test: `npm run test:weather`.

## Ochrona przed wartościami nieskończonymi (19.10.2026)

Po całkowaniu, a przed przesunięciem auta, `updatePhysics` sprawdza stan dynamiczny: pozycję, prędkość, kurs, prędkość kątową, heave/pitch/roll z prędkościami, temperatury opon, ERS i paliwo. Wartość NaN lub ∞ zostałaby w stanie auta na zawsze, a pozycja NaN psuje też zapytania toru. Taki krok jest więc odrzucany. Pozycja zostaje ostatnią skończoną, zawieszenie wraca do statyki, złe wartości są resetowane, a auto kończy jazdę jak po uderzeniu w bandę (w treningu respawn po usunięciu wraku). Pierwsze takie zdarzenie trafia do `console.warn`. Test w `test-suspension`.

## Alokacje w kroku fizyki (19.10.2026)

Wyniki promieni (`rayDistances`, `rayHits`), udziały nawierzchni pod kołami i `currentControl` są nadpisywane w miejscu, bez tworzenia nowych obiektów co krok. Średnie lewych i prawych promieni liczone są bez `slice`. Odbiorcy kopiują te dane (wejścia sieci przez spread, snapshot workera przez structured clone). Wynik symulacji jest identyczny bit w bit: skróty stanu `bench:step` dla trzech ziaren się nie zmieniły, a `diag:nn` dla ziarna 1 daje ten sam wynik. Krok przyspieszył z ok. 537 do ok. 465 µs (−13%).

## Gorąca ścieżka kroku (23.10.2026)

- LiDAR: auta w zasięgu i ich układ (cos/sin kursu, połowa szerokości, położenie) liczone raz na skan, nie raz na promień; promień omija auto, którego okręgu opisującego nie przecina przed bieżącym trafieniem. Bufor aut i szumu LiDAR-u jest używany ponownie.
- Kontakty auto–auto: wczesne odrzucenie par, których środki nie zbliżą się w kroku na odległość, przy której bryły mogłyby się zetknąć.
- Sieć: `forward` zapisuje wejścia i aktywacje do buforów sieci (zwracana tablica jest nadpisywana przy następnym wywołaniu); `clone()` kopiuje wagi bez losowania nowych, które i tak były nadpisywane.
- Mistrz sesji wybierany jednym przejściem zamiast dwóch sortowań na krok; opona liczy się w polach auta bez krotki; trajektoria okrążenia przekazywana bez kopii; klasyfikacja wyścigu nie jest liczona w treningu.
- Wszystkie zmiany poza `clone()` dają identyczne skróty stanu `bench:step`. `clone()` przestał zużywać strumień `random()`, więc przebiegi z ziarnem są inne niż wcześniej (statystycznie równoważne).
- `npm run bench:step -- 60` (3 ziarna, na przemian przed/po): ok. 620 → ok. 520 µs na krok (−16%).

## Skrzynia 8-biegowa

- Przełożenia całkowite (bieg × przekładnia główna) maleją geometrycznie od 14,0 (1.) do 5,5 (8.) przy kole 0,36 m: 15 000 obr./min na 8. biegu to ok. 103 m/s (371 km/h). Dokument z `propozycje/` miał tabelę niezgodną z własnymi obrotami (bieg 8 ≈ 590 km/h), więc przełożenia policzono od nowa.
- Automat: wyższy bieg przy 13 500 obr./min, niższy przy 7 500 (z ochroną przed przekręceniem > 14 200), cięcie zapłonu 48 ms na zmianę w górę, odstęp 0,18 s, limiter 15 000, poślizg sprzęgła na starcie (silnik trzymany w paśmie mocy).
- Moc ICE = `ICE_POWER · gaz · f(obroty)`, gdzie `f` rośnie od 0,55 (4 000 obr./min, turbo-lag) do 1 przy 10 500 i dalej jest stałe (limit przepływu paliwa); to jedyny wpływ biegu na siłę napędową poza cięciem i limiterem.
- Hamowanie silnikiem po zdjęciu gazu: `(45 + 25·obroty/15000) Nm` przez aktualne przełożenie (nie jest „gazem”, więc nie łamie wyłączności pedałów).
- HUD pokazuje prawdziwy bieg i obroty, nie bieg wyliczany z prędkości.
- Wpływ na tempo: ok. 1,5% wolniejsze okrążenia (cięcia zapłonu, pasmo mocy, hamowanie silnikiem).

## Pacejka (usunięta 23.10.2026)

Wcześniej `Car.PACEJKA = true` podmieniał `tanh` siły osi na Magic Formula (`C=1,35`, `E=−0,85`, szczyt przy α≈7,5°, spadek ok. 15% za szczytem). Pomiar `npm run diag:nn` (3 ziarna po 600 s): 2–7 rozbić o bandę na ziarno (przy `tanh` 0) i niejednoznaczne czasy; 23.10.2026 z włączoną Pacejką nie przechodzi też `test-neural-driving` („overtaking left the asphalt”). Fizyka nie ma już przełączników, więc wariant usunięto (jest w historii gita). Wymagałby osobnego strojenia strażnika stabilności i planowanej przyczepności.

## Zawieszenie i prześwit (dynamiczne)

Stan po zmianach z 18.10.2026. Od 23.10.2026 wszystkie elementy poniżej działają zawsze, w treningu i w wyścigu; dawne przełączniki (`SUSPENSION_DYNAMIC`, `SUSPENSION_LOADS`, `SUSPENSION_ROLL`, `RIDE_HEIGHT_AERO`, `PLANK_CONTACT`, `PORPOISING`) i modele zastępcze usunięto.

- **Heave + pitch** (`Car.stepSuspension`): masa resorowana 0,85·m, bezwładność pitch 1,85·ms. Sprężyny osi 380/305 kN/m, prześwit statyczny 30/55 mm. Tłumiki asymetryczne: dobicie ζ = 0,5, odbicie ζ = 0,7. Wymuszenia to docisk przód/tył (46/54, z korektą śladu aero) i sprężysta część transferu wzdłużnego. Geometria zawieszenia przejmuje 50% transferu przy hamowaniu (`ANTI_DIVE`) i 30% przy przyspieszaniu (`ANTI_SQUAT`), więc 5 g hamowania obniża przód o < 6 mm. Częstotliwości ok. 5 Hz (heave) i 6,5 Hz (pitch). Podkroki 1/240 s, półjawny Euler, wynik niezależny od kroku symulacji (30/60/120 Hz, < 0,5 mm).
- **Obciążenia opon**: statyka plus siły sprężyn i tłumików, plus transfer geometryczny i masy nieresorowanej. Ruch nadwozia opóźnia część transferu. W bramce etapu 1 wariant z dawnym transferem quasi-statycznym miał ziarna z 54 i 19 uderzeniami w bandę, wariant z obciążeniami z zawieszenia nie.
- **Przechył**: sprężyny narożnikowe 145/115 kN/m i stabilizatory 45/46,5 kN/m. Stabilizatory dobrano tak, żeby przód przejmował ok. 52% ustalonego transferu bocznego, jak dawna stała. Tłumienie przechyłu ζ = 0,6 dzieli się na osie jak tłumiki heave. Transfer każdej osi wynika z momentu jej sprężyn i tłumików przechyłu, łącznie ze stanem przejściowym, i trafia do modelu wrażliwości opon. `rollAngle` i `pitchAngle` pochodzą teraz z dynamiki, więc przechył narasta z opóźnieniem względem przyspieszenia bocznego.
- **Przepływ pod podłogą**: aerodynamika widzi prześwit przez filtr 0,05 s (`FLOOR_FLOW_LAG`), który chroni próg zerwania przed migotaniem. `rideHeightLift` bez zmian: optimum przodu ok. 16 mm, tyłu ok. 35 mm, spadek do 75% poniżej 8/15 mm.
- **Deska**: przy prześwicie < 0 kontakt 3,5 MN/m i 85 kN·s/m. Siłę przejmuje podłoga zamiast opon, a tarcie deski 0,32·F działa jak dodatkowy opór. Poza asfaltem są garby: nowa wysokość co ok. 2,5 m drogi, amplituda trawa 6 mm, żwir 14 mm (`random()` ze ziarnem). HUD: „⚠ DOBIJANIE DESKI”.
- **Morświnowanie** (zawsze włączone od 23.10.2026, wcześniej domyślnie wyłączone): histereza przepływu. Zerwanie poniżej 8/15 mm, ponowne przylgnięcie dopiero powyżej 12/19 mm, strata 40% docisku (`PORPOISING_STALL_LOSS`). Przy podłodze pracującej przy progu zerwania (np. Cl·A ≈ 5 przy 80 m/s) daje to stabilny cykl ok. 3,5–4 Hz, ok. 3 mm rms przy każdym kroku symulacji. HUD: „⚠ MORŚWINOWANIE x Hz”.
- **Opóźnienie o jeden krok**: zawieszenie dostaje `longitudinalG`/`lateralG` z poprzedniego kroku (16,7 ms przy 60 Hz), bo przyspieszenia znane są dopiero po całkowaniu. To świadoma decyzja. Opóźnienie jest krótsze od relaksacji opony i od okresu przechyłu, a predykcja przyspieszenia mogłaby wzbudzić oscylacje między transferem a siłami opon.
- Na torze GP w treningu (vmax ok. 83 m/s) najniższy prześwit podłogi wynosi 12/30 mm. Progi zerwania nie są osiągane, a deska nie dotyka asfaltu ani pobocza, więc włączenie morświnowania na stałe nie zmieniło czasów (`test-timing`: 46,619 s przed i po). Oba zjawiska ujawnią się przy większym docisku lub wyższych prędkościach.

## Wejścia sieci kierowcy (rayCount + 13)

Do 5 dotychczasowych wejść (prędkość, prędkość kątowa, kąt do bramki, zakrzywienie, nadmiar prędkości) doszło 8 wejść stanu pojazdu: temperatura opon przód/tył (60–140 °C → 0–1), maks. zużycie, stan baterii ERS, bieg/8, obroty oraz prześwit przód/tył (0 przy desce na asfalcie, 1 przy 1,5 × prześwicie statycznym, od 18.10.2026). Prześwit wynika z jazdy, więc destylacja uczy go bez losowania. Zmienia to układ wejść, więc stare zapisane modele (i stary autozapis) są odrzucane — uczenie zaczyna od nowa. Worker odmawia wczytania sieci o innej liczbie wejść (`driverInputCount` w `Car.ts`).

Destylacja uczy te wejścia: nauczyciel jedzie z włączonym modelem opon i co 20 s (oraz po każdym respawnie) losowo zmienia temperaturę/zużycie opon i energię ERS; w połowie przypadków opony zostają w stanie nominalnym, żeby typowa jazda była odwzorowana precyzyjnie.

Autozapis zawiera teraz też energię ERS i stan opon (temperatury, zużycie) każdego kierowcy; klucz autozapisu uwzględnia liczbę wejść sieci.

## Wrażliwość opon na obciążenie

- Transfer boczny każdej osi pochodzi z modelu przechyłu (sprężyny, stabilizatory i tłumiki tej osi, patrz wyżej); w stanie ustalonym przód przejmuje ok. 52%.
- Tarcie koła skaluje się jak `(Fz/Fz_śr)^−k`, k = 0,12 (`LOAD_SENSITIVITY_EXP`). `Fz_śr` to średnie obciążenie koła danej osi. Dociążone koło zewnętrzne zyskuje mniej, niż traci wewnętrzne, więc przechył zmniejsza przyczepność osi. Oś, która przenosi większą część transferu, traci więcej (balans podsterowność/nadsterowność).
- Bez przechyłu oś ma nadal `μ·Fz`. Zależność przyczepności od prędkości i docisku pozostaje skalibrowana jak wcześniej. Model zastępuje dawną jednolitą karę ≤8%.
- Wersji ze stałym `Fz0`, w której μ maleje także z dociskiem, nie przyjęto. Szybsze okrążenie w wolnych zakrętach podwajało liczbę kontaktów w treningu. Wersja z k = 0,25 dawała ok. 48 uderzeń w bandę na 600 s (wcześniej 3).
- Działa zawsze (dawny przełącznik `LOAD_SENSITIVITY` usunięto). `diag:nn` przyjmuje `LSK=<k>` do badania wykładnika.

## Ślad aerodynamiczny: zasysanie i brudne powietrze

- `computeWake` (`src/physics/Traffic.ts`) w każdym kroku `Population.update` (także dla gracza) szuka aut przed bolidem: do 50 m wzdłuż trasy (`trackGap`), ślad o szerokości ±1,6 m z zanikiem gaussowskim.
- Zasysanie: opór × (1 − 0,3·s), pełny efekt tuż za tylnym skrzydłem, zanik do 50 m. Brudne powietrze: docisk × (1 − 0,2·s), zanik do 30 m. Siła śladu słabnie, gdy auto z przodu jest wolniejsze. Nie działa poniżej 20 m/s, w boksie i za wrakiem.
- Utracony docisk w 60% pochodzi z przedniego skrzydła (czysty rozkład to 46%), więc za rywalem auto jest bardziej podsterowne. Planista zakrętów zakłada bieżący docisk ze śladem.
- Od 23.10.2026 działa zawsze, w treningu tak samo jak w wyścigu (wcześniej tylko w wyścigu): model uczony w stawce trafia w wyścigu na to samo powietrze. Okrążenie treningowe może więc skorzystać z zasysania. HUD pokazuje „cień aero opór −x% docisk −y%”.

## Kontakt auto–auto: obrót i tarcie

- Impuls normalny jest przykładany w punkcie styku: środek między najbliższymi narożnikami lub ścianami obu obrysów. Uwzględnia masę i bezwładność `Iz = 1,3·m`, tak jak w modelu jednośladu. Tarcie styczne Coulomba μ = 0,3.
- Uderzenie poza osią obraca oba auta. Centralne najechanie od tyłu ich nie obraca. Prędkość kątowa po kontakcie jest ograniczona do max(1,2 rad/s, wartość przed kontaktem). Energia kinetyczna (liniowa i obrotowa) nie rośnie, co sprawdza `test:traffic`.
- Działa zawsze (dawny przełącznik `CONTACT_SPIN` usunięto).

## Kalibracja zmian z 18.10.2026 (`npm run diag:nn -- 600`, ziarna 1–6, trening)

| Wariant | DNF auto–auto / ziarno | DNF banda / ziarno | Średni PB zespołów |
|---|---|---|---|
| Przed zmianami | 4,7 | 3,0 | 64,8 s |
| Wrażliwość opon | 3,2 | 4,0 | 64,4 s |
| Obrót przy kontakcie | 5,8 | 2,7 | 64,8 s |
| Wszystko + ślad w treningu | 5,2 | 2,7 | 64,6 s |

Rozrzut między ziarnami jest duży (np. 0–10 DNF auto–auto), więc różnice poniżej ok. 1,5 DNF na ziarno mieszczą się w szumie. Obrót przy kontakcie zwiększa liczbę wtórnych kolizji, bo obrócone auto bywa staranowane. To skutek fizyki, nie błąd.

### Zawieszenie, etapy 1–4 (ta sama metoda, baseline = stan po zmianach powyżej)

| Etap | DNF auto–auto / ziarno | DNF banda / ziarno | Średni PB | Krok (`bench:step`) |
|---|---|---|---|---|
| Baseline | 7,5 | 4,5 | 64,80 s | 518 µs |
| 1: heave + pitch, obciążenia z zawieszenia | 4,7 | 4,0 | 64,50 s | 525 µs |
| 2: + przechył i stabilizatory | 4,0 | 3,3 | 63,73 s | 528 µs |
| 3: + deska i garby poza asfaltem | 3,8 | 5,2 | 63,88 s | 524 µs |
| 4: + morświnowanie (wyłączone; włączone daje to samo na GP) | 3,8 | 5,2 | 63,88 s | 536 µs |

Etap 2 przyspiesza okrążenie o ok. 1,2%. W stanie przejściowym tłumiki opóźniają transfer boczny, a planista zakrętów tego nie modeluje. Liczba wypadków przy tym nie rośnie.

Poprawka pól startowych (18.10.2026): na łuku boczne przesunięcie pola mogło postawić je za linią następnej bramki. Na torze GP 14 m dotyczyło to pola nr 9: 0,28 m za bramką 154. Auto nie mogło jej przeciąć, więc jego `currentCheckpointIdx` się nie zmieniał. Po ok. 150 m cel sterowania wypadał za autem, AI skręcało do oporu, a auto lądowało w żwirze lub na bandzie. Wynik to ok. 28 eliminacji „stuck” i kilka do kilkudziesięciu uderzeń w bandę na ziarno, zawsze to samo auto. `Track.getGridSlot` uznaje teraz takie bramki za już minięte. Test w `test-neural-driving` sprawdza 24 pola na trzech torach.

| Po poprawce pól startowych | DNF auto–auto / ziarno | DNF banda / ziarno | DNF stuck / ziarno | Średni PB |
|---|---|---|---|---|
| Przed poprawką (etap 4) | 3,8 | 5,2 | ok. 30 | 63,88 s |
| Po poprawce | 4,8 | 2,3 | 2,0 | 64,54 s |
